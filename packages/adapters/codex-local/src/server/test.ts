import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  asString,
  parseObject,
  ensurePathInEnv,
} from "@paperclipai/adapter-utils/server-utils";
import {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetDirectory,
  runAdapterExecutionTargetProcess,
  describeAdapterExecutionTarget,
  resolveAdapterExecutionTargetCwd,
} from "@paperclipai/adapter-utils/execution-target";
import path from "node:path";
import { parseCodexJsonl } from "./parse.js";
import { codexHomeDir, readCodexAuthInfo } from "./quota.js";
import { buildCodexExecArgs } from "./codex-args.js";
import { prepareManagedCodexHome, resolveManagedCodexHomeDir } from "./codex-home.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function commandLooksLike(command: string, expected: string): boolean {
  const base = path.basename(command).toLowerCase();
  return base === expected || base === `${expected}.cmd` || base === `${expected}.exe`;
}

function summarizeProbeDetail(stdout: string, stderr: string, parsedError: string | null): string | null {
  const raw = parsedError?.trim() || firstNonEmptyLine(stderr) || firstNonEmptyLine(stdout);
  if (!raw) return null;
  const clean = raw.replace(/\s+/g, " ").trim();
  const max = 240;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function isCodexRefreshFailure(text: string): boolean {
  return /(?:access token could not be refreshed|please log out and sign in again|token_expired|could not validate your token|could not parse your authentication token)/i.test(
    text,
  );
}

async function resolveProbeCodexHome(
  companyId: string,
  env: Record<string, string>,
): Promise<string | undefined> {
  if (isNonEmpty(env.CODEX_HOME)) {
    return path.resolve(env.CODEX_HOME);
  }
  const mergedEnv = { ...process.env, ...env };
  return prepareManagedCodexHome(mergedEnv, async () => {}, companyId).catch(() =>
    resolveManagedCodexHomeDir(mergedEnv, companyId),
  );
}

async function readCodexLoginStatus(
  command: string,
  cwd: string,
  env: Record<string, string>,
): Promise<{ loggedIn: boolean; detail: string | null } | null> {
  if (!commandLooksLike(command, "codex")) return null;
  const probe = await runChildProcess(
    `codex-login-status-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    command,
    ["login", "status"],
    {
      cwd,
      env,
      timeoutSec: 10,
      graceSec: 2,
      onLog: async () => {},
    },
  );
  if (probe.timedOut) return null;

  const detail = firstNonEmptyLine(probe.stdout) || firstNonEmptyLine(probe.stderr) || null;
  if ((probe.exitCode ?? 1) === 0) {
    return { loggedIn: true, detail };
  }

  const evidence = `${probe.stdout}\n${probe.stderr}`;
  if (/(?:not\s+logged\s+in|login\s+required|logged\s+out|authentication\s+required)/i.test(evidence)) {
    return { loggedIn: false, detail };
  }
  return null;
}

const CODEX_AUTH_REQUIRED_RE =
  /(?:not\s+logged\s+in|login\s+required|authentication\s+required|unauthorized|invalid(?:\s+or\s+missing)?\s+api(?:[_\s-]?key)?|openai[_\s-]?api[_\s-]?key|api[_\s-]?key.*required|please\s+run\s+`?codex\s+login`?|access token could not be refreshed|please log out and sign in again)/i;

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "codex");
  const target = ctx.executionTarget ?? null;
  const targetIsRemote = target?.kind === "remote";
  const cwd = resolveAdapterExecutionTargetCwd(target, asString(config.cwd, ""), process.cwd());
  const targetLabel = targetIsRemote
    ? ctx.environmentName ?? describeAdapterExecutionTarget(target)
    : null;
  const runId = `codex-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  if (targetLabel) {
    checks.push({
      code: "codex_environment_target",
      level: "info",
      message: `Probing inside environment: ${targetLabel}`,
    });
  }

  try {
    await ensureAdapterExecutionTargetDirectory(runId, target, cwd, {
      cwd,
      env: {},
      createIfMissing: true,
    });
    checks.push({
      code: "codex_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "codex_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  const probeEnv = { ...env };
  const effectiveCodexHome = await resolveProbeCodexHome(ctx.companyId, probeEnv);
  if (effectiveCodexHome) {
    probeEnv.CODEX_HOME = effectiveCodexHome;
  }
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...probeEnv });
  try {
    await ensureAdapterExecutionTargetCommandResolvable(command, target, cwd, runtimeEnv);
    checks.push({
      code: "codex_command_resolvable",
      level: "info",
      message: `Command is executable: ${command}`,
    });
  } catch (err) {
    checks.push({
      code: "codex_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
    });
  }

  const configOpenAiKey = env.OPENAI_API_KEY;
  const hostOpenAiKey = targetIsRemote ? undefined : process.env.OPENAI_API_KEY;
  if (isNonEmpty(configOpenAiKey) || isNonEmpty(hostOpenAiKey)) {
    const source = isNonEmpty(configOpenAiKey) ? "adapter config env" : "server environment";
    checks.push({
      code: "codex_openai_api_key_present",
      level: "info",
      message: "OPENAI_API_KEY is set for Codex authentication.",
      detail: `Detected in ${source}.`,
    });
  } else if (!targetIsRemote) {
    const codexHome = isNonEmpty(probeEnv.CODEX_HOME) ? probeEnv.CODEX_HOME : undefined;
    const loginStatus = await readCodexLoginStatus(command, cwd, probeEnv).catch(() => null);
    const codexAuth =
      loginStatus?.loggedIn === false
        ? null
        : await readCodexAuthInfo(codexHome).catch(() => null);
    if (loginStatus?.loggedIn || codexAuth) {
      checks.push({
        code: "codex_native_auth_present",
        level: "info",
        message: "Saved Codex auth configuration was detected.",
        detail:
          codexAuth?.email
            ? `Logged in as ${codexAuth.email}.`
            : loginStatus?.detail ?? `Credentials found in ${path.join(codexHome ?? codexHomeDir(), "auth.json")}.`,
      });
    } else {
      checks.push({
        code: "codex_openai_api_key_missing",
        level: "warn",
        message: "OPENAI_API_KEY is not set. Codex runs may fail until authentication is configured.",
        ...(loginStatus?.detail ? { detail: loginStatus.detail } : {}),
        hint: "Set OPENAI_API_KEY in adapter env, shell environment, or run `codex login` to log in.",
      });
    }
  }

  const canRunProbe =
    checks.every((check) => check.code !== "codex_cwd_invalid" && check.code !== "codex_command_unresolvable");
  if (canRunProbe) {
    if (!commandLooksLike(command, "codex")) {
      checks.push({
        code: "codex_hello_probe_skipped_custom_command",
        level: "info",
        message: "Skipped hello probe because command is not `codex`.",
        detail: command,
        hint: "Use the `codex` CLI command to run the automatic login and installation probe.",
      });
    } else {
      const configuredExecArgs = buildCodexExecArgs(config);
      if (configuredExecArgs.fastModeIgnoredReason) {
        checks.push({
          code: "codex_fast_mode_unsupported_model",
          level: "warn",
          message: configuredExecArgs.fastModeIgnoredReason,
          hint: "Switch the agent model to GPT-5.5 to enable Codex Fast mode.",
        });
      }
      const execArgs = buildCodexExecArgs({ ...config, fastMode: false });
      const args = execArgs.args;

      const probe = await runAdapterExecutionTargetProcess(
        runId,
        target,
        command,
        args,
        {
          cwd,
          env: probeEnv,
          timeoutSec: 45,
          graceSec: 5,
          stdin: "Respond with hello.",
          onLog: async () => {},
        },
      );
      const parsed = parseCodexJsonl(probe.stdout);
      const detail = summarizeProbeDetail(probe.stdout, probe.stderr, parsed.errorMessage);
      const authEvidence = `${parsed.errorMessage ?? ""}\n${probe.stdout}\n${probe.stderr}`.trim();

      if (probe.timedOut) {
        checks.push({
          code: "codex_hello_probe_timed_out",
          level: "warn",
          message: "Codex hello probe timed out.",
          hint: "Retry the probe. If this persists, verify Codex can run `Respond with hello` from this directory manually.",
        });
      } else if ((probe.exitCode ?? 1) === 0) {
        const summary = parsed.summary.trim();
        const hasHello = /\bhello\b/i.test(summary);
        checks.push({
          code: hasHello ? "codex_hello_probe_passed" : "codex_hello_probe_unexpected_output",
          level: hasHello ? "info" : "warn",
          message: hasHello
            ? "Codex hello probe succeeded."
            : "Codex probe ran but did not return `hello` as expected.",
          ...(summary ? { detail: summary.replace(/\s+/g, " ").trim().slice(0, 240) } : {}),
          ...(hasHello
            ? {}
            : {
                hint: "Try the probe manually (`codex exec --json -` then prompt: Respond with hello) to inspect full output.",
              }),
        });
      } else if (CODEX_AUTH_REQUIRED_RE.test(authEvidence)) {
        const hasSavedAuth = checks.some((check) => check.code === "codex_native_auth_present");
        const staleSavedAuth = hasSavedAuth && isCodexRefreshFailure(authEvidence);
        checks.push({
          code: staleSavedAuth ? "codex_hello_probe_auth_stale" : "codex_hello_probe_auth_required",
          level: "warn",
          message: staleSavedAuth
            ? "Saved Codex auth was detected, but `codex exec` could not refresh it."
            : "Codex CLI is installed, but authentication is not ready.",
          ...(detail ? { detail } : {}),
          hint: staleSavedAuth
            ? "Run `codex logout` and `codex login` to refresh the saved session, or set OPENAI_API_KEY in adapter env/shell, then retry the probe."
            : "Configure OPENAI_API_KEY in adapter env/shell or run `codex login`, then retry the probe.",
        });
      } else {
        checks.push({
          code: "codex_hello_probe_failed",
          level: "error",
          message: "Codex hello probe failed.",
          ...(detail ? { detail } : {}),
          hint: "Run `codex exec --json -` manually in this working directory and prompt `Respond with hello` to debug.",
        });
      }
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
