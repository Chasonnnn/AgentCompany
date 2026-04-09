import { fork, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import detectPort from "detect-port";

const DEFAULT_SERVER_PORT = 3100;
const HEALTH_PATH = "/api/health";
const HEALTH_POLL_INTERVAL_MS = 500;
const HEALTH_TIMEOUT_MS = 90_000;
const SERVER_STOP_TIMEOUT_MS = 10_000;
const LOG_LINE_LIMIT = 200;
const DEFAULT_INSTANCE_ID = "default";
const COMMON_MAC_PATHS = [
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
  "/usr/local/sbin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
  "/Library/Apple/usr/bin",
];
const COMMON_USER_BIN_PATHS = [
  ".local/bin",
  ".bun/bin",
  ".cargo/bin",
  ".volta/bin",
  ".asdf/shims",
  ".nodenv/shims",
  "Library/pnpm",
  "bin",
];

export type ManagedServerStartInput = {
  userDataPath: string;
  serverRoot: string;
  preferredPort?: number;
  startupTimeoutMs?: number;
};

export type ManagedServerExitInfo = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

export type ManagedServerHandle = {
  apiUrl: string;
  paperclipHome: string;
  logsDir: string;
  serverLogPath: string;
  whenExit: Promise<ManagedServerExitInfo>;
  getRecentLogLines(): string[];
  stop(): Promise<void>;
};

function parseVersionSegments(version: string): number[] {
  const normalized = version.trim().replace(/^[^\d]*/, "");
  if (!normalized) return [];
  return normalized.split(/[^0-9]+/).filter(Boolean).map((segment) => Number.parseInt(segment, 10));
}

function compareVersionNames(left: string, right: string): number {
  const leftSegments = parseVersionSegments(left);
  const rightSegments = parseVersionSegments(right);
  const maxLength = Math.max(leftSegments.length, rightSegments.length);
  for (let index = 0; index < maxLength; index += 1) {
    const difference = (rightSegments[index] ?? 0) - (leftSegments[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return right.localeCompare(left);
}

function resolveLatestVersionManagerBin(root: string, nestedSegments: string[] = ["bin"]): string | null {
  if (!existsSync(root)) return null;

  const versions = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(compareVersionNames);

  for (const version of versions) {
    const candidate = path.join(root, version, ...nestedSegments);
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

function collectDesktopUserPathEntries(homeDir: string): string[] {
  if (!homeDir) return [];

  const entries = COMMON_USER_BIN_PATHS
    .map((relativePath) => path.join(homeDir, relativePath))
    .filter((candidate) => existsSync(candidate));

  const latestNvmBin = resolveLatestVersionManagerBin(path.join(homeDir, ".nvm", "versions", "node"));
  if (latestNvmBin) entries.push(latestNvmBin);

  const latestFnmBin = resolveLatestVersionManagerBin(
    path.join(homeDir, "Library", "Application Support", "fnm", "node-versions"),
    ["installation", "bin"],
  );
  if (latestFnmBin) entries.push(latestFnmBin);

  return entries;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createLogBuffer(limit = LOG_LINE_LIMIT) {
  const lines: string[] = [];
  let partial = "";

  const pushLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    lines.push(trimmed);
    if (lines.length > limit) lines.splice(0, lines.length - limit);
  };

  return {
    append(chunk: string) {
      partial += chunk.replace(/\r/g, "");
      const parts = partial.split("\n");
      partial = parts.pop() ?? "";
      for (const line of parts) pushLine(line);
    },
    snapshot() {
      return partial.trim() ? [...lines, partial.trim()] : [...lines];
    },
  };
}

export function resolveDesktopPaperclipHome(userDataPath: string): string {
  return path.resolve(userDataPath, "paperclip");
}

export function resolveDesktopLogsDir(paperclipHome: string, instanceId = DEFAULT_INSTANCE_ID): string {
  return path.resolve(paperclipHome, "instances", instanceId, "logs");
}

export function resolveDesktopServerLogPath(paperclipHome: string, instanceId = DEFAULT_INSTANCE_ID): string {
  return path.resolve(resolveDesktopLogsDir(paperclipHome, instanceId), "server.log");
}

export function resolveDesktopServerRoot(input: {
  isPackaged: boolean;
  appPath: string;
  resourcesPath: string;
}): string {
  return input.isPackaged
    ? path.resolve(input.resourcesPath, "server")
    : path.resolve(input.appPath, ".stage", "server");
}

export function augmentDesktopPath(currentPath: string | undefined, homeDir = os.homedir()): string {
  const seen = new Set<string>();
  const entries = [
    ...(currentPath?.split(path.delimiter) ?? []),
    ...collectDesktopUserPathEntries(homeDir),
    ...COMMON_MAC_PATHS,
  ]
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value) => {
      if (seen.has(value)) return false;
      seen.add(value);
      return true;
    });

  return entries.join(path.delimiter);
}

export function buildDesktopServerEnv(input: {
  baseEnv: NodeJS.ProcessEnv;
  paperclipHome: string;
  port: number;
  instanceId?: string;
}): NodeJS.ProcessEnv {
  const instanceId = input.instanceId ?? DEFAULT_INSTANCE_ID;
  return {
    ...input.baseEnv,
    HOST: "127.0.0.1",
    PORT: String(input.port),
    SERVE_UI: "true",
    PAPERCLIP_UI_DEV_MIDDLEWARE: "false",
    PAPERCLIP_DEPLOYMENT_MODE: "local_trusted",
    PAPERCLIP_DEPLOYMENT_EXPOSURE: "private",
    PAPERCLIP_HOME: input.paperclipHome,
    PAPERCLIP_INSTANCE_ID: instanceId,
    PAPERCLIP_OPEN_ON_LISTEN: "false",
    PATH: augmentDesktopPath(input.baseEnv.PATH, input.baseEnv.HOME ?? os.homedir()),
  };
}

export function formatExitReason(exitInfo: ManagedServerExitInfo): string {
  if (exitInfo.signal) return `signal ${exitInfo.signal}`;
  return `exit code ${exitInfo.code ?? "unknown"}`;
}

async function waitForServerHealth(input: {
  apiUrl: string;
  timeoutMs: number;
  whenExit: Promise<ManagedServerExitInfo>;
}): Promise<void> {
  const deadline = Date.now() + input.timeoutMs;
  let lastError: string | null = null;

  while (Date.now() <= deadline) {
    const exitResult = await Promise.race([
      input.whenExit.then((exitInfo) => ({ kind: "exit" as const, exitInfo })),
      delay(HEALTH_POLL_INTERVAL_MS).then(() => ({ kind: "timer" as const })),
    ]);

    if (exitResult.kind === "exit") {
      throw new Error(`Paperclip server exited before it became healthy (${formatExitReason(exitResult.exitInfo)}).`);
    }

    try {
      const response = await fetch(new URL(HEALTH_PATH, input.apiUrl), {
        headers: { accept: "application/json" },
      });
      if (response.ok) return;
      lastError = `Health check returned ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  throw new Error(
    lastError
      ? `Timed out waiting for Paperclip server health (${lastError}).`
      : "Timed out waiting for Paperclip server health.",
  );
}

function attachChildLogs(child: ChildProcess, buffer: ReturnType<typeof createLogBuffer>) {
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string | Buffer) => {
    buffer.append(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  });
  child.stderr?.on("data", (chunk: string | Buffer) => {
    buffer.append(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  });
}

async function stopChildProcess(child: ChildProcess, whenExit: Promise<ManagedServerExitInfo>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    await whenExit.catch(() => undefined);
    return;
  }

  child.kill("SIGTERM");
  const result = await Promise.race([
    whenExit.then(() => "exited" as const),
    delay(SERVER_STOP_TIMEOUT_MS).then(() => "timeout" as const),
  ]);

  if (result === "timeout" && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await whenExit.catch(() => undefined);
  }
}

export async function startManagedServer(input: ManagedServerStartInput): Promise<ManagedServerHandle> {
  if (!existsSync(input.serverRoot)) {
    throw new Error(`Packaged Paperclip server runtime not found at ${input.serverRoot}. Run pnpm desktop:package first.`);
  }

  const paperclipHome = resolveDesktopPaperclipHome(input.userDataPath);
  const logsDir = resolveDesktopLogsDir(paperclipHome);
  const serverLogPath = resolveDesktopServerLogPath(paperclipHome);
  mkdirSync(logsDir, { recursive: true });

  const port = await detectPort(input.preferredPort ?? DEFAULT_SERVER_PORT);
  const apiUrl = `http://127.0.0.1:${port}`;
  const serverEntry = path.resolve(input.serverRoot, "dist", "index.js");
  const env = buildDesktopServerEnv({
    baseEnv: process.env,
    paperclipHome,
    port,
  });
  const logBuffer = createLogBuffer();
  const child = fork(serverEntry, [], {
    cwd: input.serverRoot,
    env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });

  attachChildLogs(child, logBuffer);

  const whenExit = new Promise<ManagedServerExitInfo>((resolve) => {
    child.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });

  try {
    await waitForServerHealth({
      apiUrl,
      timeoutMs: input.startupTimeoutMs ?? HEALTH_TIMEOUT_MS,
      whenExit,
    });
  } catch (error) {
    await stopChildProcess(child, whenExit);
    const reason = error instanceof Error ? error.message : String(error);
    const logLines = logBuffer.snapshot();
    throw new Error(
      logLines.length > 0
        ? `${reason}\n\nRecent server logs:\n${logLines.join("\n")}`
        : reason,
    );
  }

  return {
    apiUrl,
    paperclipHome,
    logsDir,
    serverLogPath,
    whenExit,
    getRecentLogLines: () => logBuffer.snapshot(),
    stop: () => stopChildProcess(child, whenExit),
  };
}
