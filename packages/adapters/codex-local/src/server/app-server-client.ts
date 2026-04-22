import { spawn, type ChildProcess } from "node:child_process";
import { ensurePathInEnv } from "@paperclipai/adapter-utils/server-utils";

type JsonRpcId = number | string;

type PendingRequest = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type SpawnMeta = {
  pid: number;
  processGroupId: number | null;
  startedAt: string;
};

export type AppServerClientOptions = {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onSpawn?: (meta: SpawnMeta) => Promise<void> | void;
  onNotification?: (method: string, params: Record<string, unknown>) => Promise<void> | void;
  onRequest?: (
    method: string,
    id: JsonRpcId,
    params: Record<string, unknown>,
  ) => Promise<Record<string, unknown> | typeof NO_RESPONSE | null | void> | Record<string, unknown> | typeof NO_RESPONSE | null | void;
  onStderr?: (chunk: string) => Promise<void> | void;
};

export type AppServerInitializeCapabilities = {
  experimentalApi?: boolean;
};

export type AppServerInitializeOptions = {
  capabilities?: AppServerInitializeCapabilities | null;
};

export const NO_RESPONSE = Symbol("codex-app-server-no-response");

function stringifyId(id: JsonRpcId): string {
  return typeof id === "number" ? String(id) : id;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function errorMessageFromResponse(message: Record<string, unknown>): string {
  const error = asRecord(message.error);
  if (typeof error?.message === "string" && error.message.trim().length > 0) {
    return error.message.trim();
  }
  if (typeof message.error === "string" && message.error.trim().length > 0) {
    return message.error.trim();
  }
  try {
    return JSON.stringify(message.error ?? message);
  } catch {
    return "codex app-server request failed";
  }
}

export class CodexAppServerClient {
  private readonly proc: ChildProcess;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly closePromise: Promise<void>;
  private readonly options: AppServerClientOptions;
  private nextId = 1;
  private buffer = "";
  private stderr = "";

  constructor(options: AppServerClientOptions = {}) {
    this.options = options;
    const command = options.command ?? "codex";
    const args = options.args ?? ["app-server"];
    const startedAt = new Date().toISOString();
    const env = ensurePathInEnv({ ...process.env, ...options.env });
    this.proc = spawn(command, args, {
      cwd: options.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.closePromise = new Promise((resolve) => {
      this.proc.once("exit", () => resolve());
      this.proc.once("close", () => resolve());
      this.proc.once("error", () => resolve());
    });

    if (typeof this.proc.stdout?.setEncoding === "function") {
      this.proc.stdout.setEncoding("utf8");
    }
    if (typeof this.proc.stderr?.setEncoding === "function") {
      this.proc.stderr.setEncoding("utf8");
    }

    this.proc.stdout?.on("data", (chunk: string) => {
      void this.onStdout(chunk);
    });
    this.proc.stderr?.on("data", (chunk: string) => {
      this.stderr += chunk;
      void this.options.onStderr?.(chunk);
    });
    this.proc.on("exit", () => {
      const message = this.stderr.trim() || "codex app-server closed unexpectedly";
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error(message));
      }
      this.pending.clear();
    });
    this.proc.on("error", (err: Error) => {
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(err);
      }
      this.pending.clear();
    });

    if (typeof this.proc.pid === "number" && this.proc.pid > 0) {
      void this.options.onSpawn?.({
        pid: this.proc.pid,
        processGroupId: null,
        startedAt,
      });
    }
  }

  get stderrText() {
    return this.stderr;
  }

  get pid() {
    return this.proc.pid ?? null;
  }

  private async onStdout(chunk: string) {
    this.buffer += chunk;
    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex < 0) break;
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (!line) continue;

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      const id = parsed.id;
      const method = typeof parsed.method === "string" ? parsed.method : null;
      if (method && id !== undefined) {
        await this.handleServerRequest(method, id as JsonRpcId, asRecord(parsed.params) ?? {});
        continue;
      }
      if (method) {
        await this.options.onNotification?.(method, asRecord(parsed.params) ?? {});
        continue;
      }
      if (id === undefined) continue;

      const key = stringifyId(id as JsonRpcId);
      const pending = this.pending.get(key);
      if (!pending) continue;
      this.pending.delete(key);
      clearTimeout(pending.timer);
      if (parsed.error !== undefined) {
        pending.reject(new Error(errorMessageFromResponse(parsed)));
      } else {
        pending.resolve(parsed);
      }
    }
  }

  private async handleServerRequest(
    method: string,
    id: JsonRpcId,
    params: Record<string, unknown>,
  ) {
    try {
      const result = await this.options.onRequest?.(method, id, params);
      if (result === NO_RESPONSE) return;
      this.writeRaw({
        id,
        result: result ?? null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.writeRaw({
        id,
        error: {
          code: -32000,
          message,
        },
      });
    }
  }

  private writeRaw(payload: Record<string, unknown>) {
    this.proc.stdin?.write(`${JSON.stringify(payload)}\n`);
  }

  request(method: string, params: Record<string, unknown> = {}, timeoutMs = 10_000) {
    const id = this.nextId++;
    const payload = { id, method, params };
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`codex app-server timed out on ${method}`));
      }, timeoutMs);
      this.pending.set(String(id), { resolve, reject, timer });
      this.writeRaw(payload);
    });
  }

  notify(method: string, params: Record<string, unknown> = {}) {
    this.writeRaw({ method, params });
  }

  async initialize(options: AppServerInitializeOptions = {}) {
    const capabilities =
      options.capabilities && Object.keys(options.capabilities).length > 0
        ? options.capabilities
        : undefined;
    await this.request("initialize", {
      clientInfo: {
        name: "paperclip",
        version: "0.0.0",
      },
      ...(capabilities ? { capabilities } : {}),
    });
    this.notify("initialized", {});
  }

  async shutdown(options: { graceMs?: number } = {}) {
    const graceMs = Math.max(0, options.graceMs ?? 2_000);
    if (!this.proc.killed) {
      this.proc.kill("SIGTERM");
    }

    if (graceMs === 0) {
      await this.closePromise.catch(() => {});
      return;
    }

    const forceTimer = setTimeout(() => {
      if (!this.proc.killed) {
        this.proc.kill("SIGKILL");
      }
    }, graceMs);

    try {
      await this.closePromise.catch(() => {});
    } finally {
      clearTimeout(forceTimer);
    }
  }
}
