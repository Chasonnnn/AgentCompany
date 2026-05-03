import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { parseLocalExecutionPolicy } from "@paperclipai/adapter-utils/local-execution-policy";
import fs from "node:fs/promises";
import os from "node:os";
import {
  asString,
  asBoolean,
  asNumber,
  asStringArray,
  parseJson,
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
import { detectClaudeLoginRequired, parseClaudeStreamJson } from "./parse.js";
import { isBedrockModelId } from "./models.js";

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

function summarizeProbeDetail(stdout: string, stderr: string): string | null {
  const raw = firstNonEmptyLine(stderr) || firstNonEmptyLine(stdout);
  if (!raw) return null;
  const clean = raw.replace(/\s+/g, " ").trim();
  const max = 240;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

type ClaudeAuthStatusProbe = {
  loggedIn: boolean;
  authMethod: string | null;
  subscriptionType: string | null;
};

async function readClaudeAuthStatus(
  command: string,
  cwd: string,
  env: Record<string, string>,
): Promise<ClaudeAuthStatusProbe | null> {
  if (!commandLooksLike(command, "claude")) return null;
  const probe = await runChildProcess(
    `claude-auth-status-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    command,
    ["auth", "status"],
    {
      cwd,
      env,
      timeoutSec: 10,
      graceSec: 2,
      onLog: async () => {},
      localExecutionPolicy: buildClaudeEnvironmentProbePolicy(command, cwd, env),
    },
  );
  if (probe.timedOut || (probe.exitCode ?? 1) !== 0) return null;

  const parsed = parseJson(probe.stdout.trim());
  if (!parsed) return null;
  return {
    loggedIn: parsed.loggedIn === true,
    authMethod: typeof parsed.authMethod === "string" ? parsed.authMethod : null,
    subscriptionType: typeof parsed.subscriptionType === "string" ? parsed.subscriptionType : null,
  };
}

function describeClaudeNativeAuth(status: ClaudeAuthStatusProbe | null): string | null {
  if (!status?.loggedIn || status.authMethod !== "claude.ai") return null;
  return status.subscriptionType
    ? `Claude is authenticated via claude.ai (${status.subscriptionType}).`
    : "Claude is authenticated via claude.ai.";
}

function resolveClaudeConfigDir(env: NodeJS.ProcessEnv): string {
  const configured = env.CLAUDE_CONFIG_DIR;
  if (typeof configured === "string" && configured.trim().length > 0) {
    return configured.trim();
  }
  const home = typeof env.HOME === "string" && env.HOME.trim().length > 0
    ? env.HOME.trim()
    : os.homedir();
  return path.join(home, ".claude");
}

function buildClaudeEnvironmentProbePolicy(
  command: string,
  cwd: string,
  env: Record<string, string>,
) {
  const allowedEnvKeys = Array.from(
    new Set(
      Object.keys(env).filter((key) =>
        key === "PATH" ||
        key === "HOME" ||
        key === "TMPDIR" ||
        key === "USER" ||
        key === "LOGNAME" ||
        key === "CLAUDE_CONFIG_DIR" ||
        key === "CLAUDE_CODE_USE_BEDROCK" ||
        key.startsWith("PAPERCLIP_") ||
        key.startsWith("ANTHROPIC_") ||
        key.startsWith("AWS_"),
      ),
    ),
  );

  return parseLocalExecutionPolicy(
    {
      preset: "claude_environment_probe",
      allowedCommands: [path.basename(command)],
      allowedEnvKeys,
      allowedFsPaths: [cwd, resolveClaudeConfigDir(env), os.tmpdir()],
      allowedNetwork: "all",
    },
    { defaultPreset: "claude_environment_probe" },
  )!;
}

async function readSkipAutoPermissionPromptWarning(
  env: NodeJS.ProcessEnv,
): Promise<AdapterEnvironmentCheck | null> {
  const settingsPath = path.join(resolveClaudeConfigDir(env), "settings.json");
  let raw: string;
  try {
    raw = await fs.readFile(settingsPath, "utf8");
  } catch {
    return null;
  }

  const parsed = parseJson(raw);
  if (!parsed) return null;
  const settings = parseObject(parsed);
  if (settings.skipAutoPermissionPrompt !== true) return null;

  return {
    code: "claude_skip_auto_permission_prompt_enabled",
    level: "warn",
    message:
      "Claude settings.json has skipAutoPermissionPrompt=true. Native AskUserQuestion UI prompts will be auto-suppressed.",
    detail: settingsPath,
    hint:
      "Set skipAutoPermissionPrompt to false if you need Claude's native ask-user tool flow to surface reliably. " +
      "If native ask-user remains unavailable, fall back to persisted issue decision questions via POST /api/issues/:issueId/questions.",
  };
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "claude");
  const target = ctx.executionTarget ?? null;
  const targetIsRemote = target?.kind === "remote";
  const cwd = resolveAdapterExecutionTargetCwd(target, asString(config.cwd, ""), process.cwd());
  const targetLabel = targetIsRemote
    ? ctx.environmentName ?? describeAdapterExecutionTarget(target)
    : null;
  const runId = `claude-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  if (targetLabel) {
    checks.push({
      code: "claude_environment_target",
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
      code: "claude_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "claude_cwd_invalid",
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
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  try {
    await ensureAdapterExecutionTargetCommandResolvable(command, target, cwd, runtimeEnv);
    checks.push({
      code: "claude_command_resolvable",
      level: "info",
      message: `Command is executable: ${command}`,
    });
  } catch (err) {
    checks.push({
      code: "claude_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
    });
  }

  // When probing a remote target, the Paperclip host's process.env does not
  // reflect what the agent will actually see at runtime. Only consider env
  // vars from the adapter config in that case; the probe itself will surface
  // any auth issues on the remote box.
  const considerHostEnv = !targetIsRemote;
  const hasBedrock =
    env.CLAUDE_CODE_USE_BEDROCK === "1" ||
    env.CLAUDE_CODE_USE_BEDROCK === "true" ||
    (considerHostEnv && process.env.CLAUDE_CODE_USE_BEDROCK === "1") ||
    (considerHostEnv && process.env.CLAUDE_CODE_USE_BEDROCK === "true") ||
    isNonEmpty(env.ANTHROPIC_BEDROCK_BASE_URL) ||
    (considerHostEnv && isNonEmpty(process.env.ANTHROPIC_BEDROCK_BASE_URL));

  const configApiKey = env.ANTHROPIC_API_KEY;
  const hostApiKey = considerHostEnv ? process.env.ANTHROPIC_API_KEY : undefined;
  if (hasBedrock) {
    const source =
      env.CLAUDE_CODE_USE_BEDROCK === "1" ||
      env.CLAUDE_CODE_USE_BEDROCK === "true" ||
      isNonEmpty(env.ANTHROPIC_BEDROCK_BASE_URL)
        ? "adapter config env"
        : "server environment";
    checks.push({
      code: "claude_bedrock_auth",
      level: "info",
      message: "AWS Bedrock auth detected. Claude will use Bedrock for inference.",
      detail: `Detected in ${source}.`,
      hint: "Ensure AWS credentials (AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY or AWS_PROFILE) and AWS_REGION are configured.",
    });
  } else if (isNonEmpty(configApiKey) || isNonEmpty(hostApiKey)) {
    const source = isNonEmpty(configApiKey) ? "adapter config env" : "server environment";
    checks.push({
      code: "claude_anthropic_api_key_overrides_subscription",
      level: "warn",
      message:
        "ANTHROPIC_API_KEY is set. Claude will use API-key auth instead of subscription credentials.",
      detail: `Detected in ${source}.`,
      hint: "Unset ANTHROPIC_API_KEY if you want subscription-based Claude login behavior.",
    });
  } else if (!targetIsRemote) {
    const authStatus = await readClaudeAuthStatus(command, cwd, env).catch(() => null);
    const authDescription = describeClaudeNativeAuth(authStatus);
    if (authDescription) {
      checks.push({
        code: "claude_native_auth_present",
        level: "info",
        message: authDescription,
      });
    } else {
      checks.push({
        code: "claude_subscription_mode_possible",
        level: "info",
        message: "ANTHROPIC_API_KEY is not set; subscription-based auth can be used if Claude is logged in.",
      });
    }
  }

  if (!targetIsRemote && commandLooksLike(command, "claude")) {
    const skipPromptWarning = await readSkipAutoPermissionPromptWarning(runtimeEnv).catch(() => null);
    if (skipPromptWarning) {
      checks.push(skipPromptWarning);
    }
  }

  const canRunProbe =
    checks.every((check) => check.code !== "claude_cwd_invalid" && check.code !== "claude_command_unresolvable");
  if (canRunProbe) {
    if (!commandLooksLike(command, "claude")) {
      checks.push({
        code: "claude_hello_probe_skipped_custom_command",
        level: "info",
        message: "Skipped hello probe because command is not `claude`.",
        detail: command,
        hint: "Use the `claude` CLI command to run the automatic login and installation probe.",
      });
    } else {
      const model = asString(config.model, "").trim();
      const effort = asString(config.effort, "").trim();
      const chrome = asBoolean(config.chrome, false);
      const maxTurns = asNumber(config.maxTurnsPerRun, 0);
      const dangerouslySkipPermissions = asBoolean(config.dangerouslySkipPermissions, true);
      const extraArgs = (() => {
        const fromExtraArgs = asStringArray(config.extraArgs);
        if (fromExtraArgs.length > 0) return fromExtraArgs;
        return asStringArray(config.args);
      })();

      const args = ["--print", "-", "--output-format", "stream-json", "--verbose"];
      if (dangerouslySkipPermissions) args.push("--dangerously-skip-permissions");
      if (chrome) args.push("--chrome");
      // For Bedrock: only pass --model when the ID is a Bedrock-native identifier.
      if (model && (!hasBedrock || isBedrockModelId(model))) {
        args.push("--model", model);
      }
      if (effort) args.push("--effort", effort);
      if (maxTurns > 0) args.push("--max-turns", String(maxTurns));
      if (extraArgs.length > 0) args.push(...extraArgs);

      const probe = await runAdapterExecutionTargetProcess(
        runId,
        target,
        command,
        args,
        {
          cwd,
          env,
          timeoutSec: 45,
          graceSec: 5,
          stdin: "Respond with hello.",
          onLog: async () => {},
          localExecutionPolicy: buildClaudeEnvironmentProbePolicy(command, cwd, env),
          declaredEnvKeys: Object.keys(env),
        },
      );

      const parsedStream = parseClaudeStreamJson(probe.stdout);
      const parsed = parsedStream.resultJson;
      const loginMeta = detectClaudeLoginRequired({
        parsed,
        stdout: probe.stdout,
        stderr: probe.stderr,
      });
      const detail = summarizeProbeDetail(probe.stdout, probe.stderr);

      if (probe.timedOut) {
        checks.push({
          code: "claude_hello_probe_timed_out",
          level: "warn",
          message: "Claude hello probe timed out.",
          hint: "Retry the probe. If this persists, verify Claude can run `Respond with hello` from this directory manually.",
        });
      } else if (loginMeta.requiresLogin) {
        checks.push({
          code: "claude_hello_probe_auth_required",
          level: "warn",
          message: "Claude CLI is installed, but login is required.",
          ...(detail ? { detail } : {}),
          hint: loginMeta.loginUrl
            ? `Run \`claude login\` and complete sign-in at ${loginMeta.loginUrl}, then retry.`
            : "Run `claude login` in this environment, then retry the probe.",
        });
      } else if ((probe.exitCode ?? 1) === 0) {
        const summary = parsedStream.summary.trim();
        const hasHello = /\bhello\b/i.test(summary);
        checks.push({
          code: hasHello ? "claude_hello_probe_passed" : "claude_hello_probe_unexpected_output",
          level: hasHello ? "info" : "warn",
          message: hasHello
            ? "Claude hello probe succeeded."
            : "Claude probe ran but did not return `hello` as expected.",
          ...(summary ? { detail: summary.replace(/\s+/g, " ").trim().slice(0, 240) } : {}),
          ...(hasHello
            ? {}
            : {
                hint: "Try the probe manually (`claude --print - --output-format stream-json --verbose`) and prompt `Respond with hello`.",
              }),
        });
      } else {
        checks.push({
          code: "claude_hello_probe_failed",
          level: "error",
          message: "Claude hello probe failed.",
          ...(detail ? { detail } : {}),
          hint: "Run `claude --print - --output-format stream-json --verbose` manually in this directory and prompt `Respond with hello` to debug.",
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
