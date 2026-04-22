import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";

const HEALTH_PATH = "/api/health";
const DEFAULT_HEALTH_TIMEOUT_MS = 90_000;
const DEFAULT_PRECHECK_TIMEOUT_MS = 180_000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..", "..");
const promptfooDir = path.resolve(__dirname, "..");

export function normalizeBaseUrl(value) {
  const raw = typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : "";
  if (!raw) {
    throw new Error("PAPERCLIP_COMPONENT_EVAL_BASE_URL is required.");
  }
  return raw.replace(/\/+$/, "");
}

export async function pickOpenPort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to resolve ephemeral port.")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

export async function waitForHealth(baseUrl, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? 500;
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetchImpl(`${normalizeBaseUrl(baseUrl)}${HEALTH_PATH}`);
      if (response.ok) {
        return;
      }
      lastError = new Error(`Health check failed with status ${response.status}.`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw lastError ?? new Error(`Timed out waiting for ${baseUrl}${HEALTH_PATH}`);
}

export async function postComponentRun(baseUrl, request, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${normalizeBaseUrl(baseUrl)}/api/instance/evals/component-run`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(request),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const reason = typeof payload?.error === "string" ? payload.error : `HTTP ${response.status}`;
    throw new Error(`Component eval request failed: ${reason}`);
  }
  return payload;
}

export async function runComponentEvalPreflight(baseUrl, options = {}) {
  const adapters = options.adapters ?? ["codex_local", "claude_local"];
  const timeoutMs = options.timeoutMs ?? DEFAULT_PRECHECK_TIMEOUT_MS;
  for (const adapterType of adapters) {
    const payload = await postComponentRun(baseUrl, {
      caseId: `preflight.${adapterType}`,
      adapterType,
      prompt: "Respond with hello.",
      vars: {
        caseId: `preflight.${adapterType}`,
      },
      timeoutMs,
    }, options);
    const finalText = typeof payload?.finalText === "string" ? payload.finalText : "";
    if (payload?.executionStatus !== "succeeded" || !/\bhello\b/i.test(finalText)) {
      const reason = typeof payload?.errorMessage === "string" ? payload.errorMessage : "Preflight did not return hello.";
      throw new Error(`${adapterType} preflight failed: ${reason}`);
    }
  }
}

export function buildLocalServerSpawnSpec(input) {
  return {
    command: "pnpm",
    args: ["--filter", "@paperclipai/server", "exec", "tsx", "src/index.ts"],
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(input.port),
      PAPERCLIP_HOME: input.paperclipHome,
      PAPERCLIP_INSTANCE_ID: input.instanceId,
      PAPERCLIP_BIND: "loopback",
      PAPERCLIP_MIGRATION_PROMPT: "never",
      PAPERCLIP_MIGRATION_AUTO_APPLY: "true",
      SERVE_UI: "false",
      PAPERCLIP_UI_DEV_MIDDLEWARE: "false",
    },
  };
}

export function buildPromptfooEvalSpawnSpec(baseUrl) {
  return {
    command: "pnpm",
    args: ["dlx", "promptfoo@0.103.3", "eval", "-c", "promptfooconfig.yaml"],
    cwd: promptfooDir,
    env: {
      ...process.env,
      PAPERCLIP_COMPONENT_EVAL_BASE_URL: normalizeBaseUrl(baseUrl),
    },
  };
}

async function spawnCommand(spec, options = {}) {
  const spawnImpl = options.spawnImpl ?? spawn;
  return await new Promise((resolve, reject) => {
    const child = spawnImpl(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: options.stdio ?? "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${spec.command} ${spec.args.join(" ")} failed with code ${code ?? "null"} signal ${signal ?? "null"}.`));
    });
  });
}

async function stopProcess(child, timeoutMs = 10_000) {
  if (!child || child.exitCode != null) return;
  await new Promise((resolve) => {
    let settled = false;
    let forceKillTimer = null;
    let postKillTimer = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (postKillTimer) clearTimeout(postKillTimer);
      child.removeListener("exit", onExit);
      resolve();
    };

    const onExit = () => finish();
    child.once("exit", onExit);

    if (child.exitCode != null) {
      finish();
      return;
    }

    try {
      child.kill("SIGTERM");
    } catch {
      finish();
      return;
    }

    if (child.exitCode != null) {
      finish();
      return;
    }

    forceKillTimer = setTimeout(() => {
      if (child.exitCode != null) {
        finish();
        return;
      }
      try {
        child.kill("SIGKILL");
      } catch {
        finish();
        return;
      }
      if (child.exitCode != null) {
        finish();
        return;
      }
      postKillTimer = setTimeout(finish, 1_000);
    }, timeoutMs);
  });
}

export async function withLocalPaperclipServer(callback, options = {}) {
  const existingBaseUrl = process.env.PAPERCLIP_COMPONENT_EVAL_BASE_URL;
  if (typeof existingBaseUrl === "string" && existingBaseUrl.trim().length > 0) {
    const baseUrl = normalizeBaseUrl(existingBaseUrl);
    await waitForHealth(baseUrl, options);
    return await callback({ baseUrl, startedServer: false });
  }

  const paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-component-evals-home-"));
  const instanceId = `component_evals_${Date.now()}`;
  const port = await pickOpenPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const spec = buildLocalServerSpawnSpec({ port, paperclipHome, instanceId });
  const child = (options.spawnImpl ?? spawn)(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    stdio: options.serverStdio ?? "inherit",
  });

  try {
    await waitForHealth(baseUrl, options);
    return await callback({ baseUrl, startedServer: true });
  } finally {
    await stopProcess(child);
    await fs.rm(paperclipHome, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function runPromptfooEval(baseUrl, options = {}) {
  const spec = buildPromptfooEvalSpawnSpec(baseUrl);
  await spawnCommand(spec, options);
}
