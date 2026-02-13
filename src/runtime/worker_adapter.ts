import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { nowIso } from "../core/time.js";
import { createRun } from "./run.js";
import { collectSession, launchSession, pollSession, stopSession } from "./session.js";
import { appendEventJsonl, newEnvelope } from "./events.js";
import { readYamlFile, writeYamlFile } from "../store/yaml.js";
import { RunYaml } from "../schemas/run.js";
import type { JobPermissionLevel, JobSpec, WorkerKind } from "../schemas/job.js";
import { resolveProviderBin } from "../drivers/resolve_bin.js";
import { extractClaudeMarkdownFromStreamJson } from "../drivers/claude_stream_json.js";
import { enforceSubscriptionExecutionPolicy } from "./subscription_guard.js";

export type WorkerIdentity = {
  agent_id: string;
  provider: string;
  model_hint?: string;
  launcher?: Record<string, unknown>;
};

export type WorkerAttemptArgs = {
  job: JobSpec;
  worker: WorkerIdentity;
  worker_kind: WorkerKind;
  prompt: string;
  attempt: number;
  result_contract_mode?: WorkerResultContractMode;
  output_contract?: WorkerOutputContract;
  abort_signal?: AbortSignal;
};

export type WorkerResultContractMode = "prompt_only" | "provider_schema";
export type WorkerOutputContract = "result_spec" | "heartbeat_worker_report";

export type WorkerAttemptResult = {
  run_id: string;
  context_pack_id: string;
  session_ref: string;
  status: "ended" | "failed" | "stopped";
  provider_bin: string;
  provider_version?: string;
  provider_help_hash?: string;
  output_format?: string;
  raw_output: string;
  output_relpaths: string[];
  error?: string;
  blocked_reason?: "subscription_unverified";
};

type CommandBuild =
  | {
      mode: "protocol";
      prompt_text: string;
      model?: string;
      provider_bin: string;
      output_format?: string;
      env?: Record<string, string>;
    }
  | {
      mode: "command";
      argv: string[];
      stdin_text?: string;
      model?: string;
      provider_bin: string;
      output_format?: string;
      env?: Record<string, string>;
    };

function mapCodexSandbox(permission: JobPermissionLevel): "read-only" | "workspace-write" {
  if (permission === "read-only") return "read-only";
  return "workspace-write";
}

function tryLauncherTemplate(launcher?: Record<string, unknown>): string[] | null {
  if (!launcher || typeof launcher !== "object") return null;
  const raw = launcher.command_argv_template;
  if (!Array.isArray(raw)) return null;
  const strings = raw.filter((v) => typeof v === "string").map((v) => v.trim()).filter(Boolean);
  if (!strings.length) return null;
  return strings;
}

const SHELL_BINARIES = new Set(["sh", "bash", "zsh", "fish", "cmd", "powershell", "pwsh"]);

function validateLauncherTemplate(argvTemplate: string[]): void {
  const first = argvTemplate[0] ?? "";
  const base = path.basename(first).toLowerCase();
  if (!first.trim()) throw new Error("launcher.command_argv_template must start with a binary path/name");
  if (SHELL_BINARIES.has(base) || SHELL_BINARIES.has(first.toLowerCase())) {
    throw new Error("launcher.command_argv_template cannot invoke a shell wrapper");
  }
  for (const arg of argvTemplate) {
    if (arg.includes("\n") || arg.includes("\r")) {
      throw new Error("launcher.command_argv_template entries cannot contain newlines");
    }
  }
}

function hashText(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

const CODEX_OUTPUT_SCHEMA_SUPPORT_CACHE = new Map<string, boolean>();
const CLAUDE_JSON_SCHEMA_SUPPORT_CACHE = new Map<string, boolean>();

async function runProbeCommand(args: {
  bin: string;
  argv: string[];
  timeout_ms?: number;
}): Promise<{ ok: boolean; stdout: string; stderr: string; exit_code: number | null }> {
  const timeoutMs = Math.max(500, args.timeout_ms ?? 5000);
  return await new Promise((resolve) => {
    const p = spawn(args.bin, args.argv, { stdio: ["ignore", "pipe", "pipe"] });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        p.kill("SIGKILL");
      } catch {
        // ignore
      }
      resolve({
        ok: false,
        stdout: Buffer.concat(outChunks).toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8"),
        exit_code: null
      });
    }, timeoutMs);
    p.stdout?.on("data", (b: Buffer) => outChunks.push(b));
    p.stderr?.on("data", (b: Buffer) => errChunks.push(b));
    p.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        stdout: Buffer.concat(outChunks).toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8"),
        exit_code: null
      });
    });
    p.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        stdout: Buffer.concat(outChunks).toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8"),
        exit_code: code
      });
    });
  });
}

async function supportsCodexOutputSchema(bin: string): Promise<boolean> {
  if (CODEX_OUTPUT_SCHEMA_SUPPORT_CACHE.has(bin)) {
    return CODEX_OUTPUT_SCHEMA_SUPPORT_CACHE.get(bin) ?? false;
  }
  const probe = await runProbeCommand({ bin, argv: ["exec", "--help"], timeout_ms: 4000 });
  const text = `${probe.stdout}\n${probe.stderr}`.toLowerCase();
  const supported = text.includes("--output-schema") || text.includes("-s");
  CODEX_OUTPUT_SCHEMA_SUPPORT_CACHE.set(bin, supported);
  return supported;
}

async function supportsClaudeJsonSchema(bin: string): Promise<boolean> {
  if (CLAUDE_JSON_SCHEMA_SUPPORT_CACHE.has(bin)) {
    return CLAUDE_JSON_SCHEMA_SUPPORT_CACHE.get(bin) ?? false;
  }
  const probe = await runProbeCommand({ bin, argv: ["--help"], timeout_ms: 4000 });
  const text = `${probe.stdout}\n${probe.stderr}`.toLowerCase();
  const supported = text.includes("--json-schema");
  CLAUDE_JSON_SCHEMA_SUPPORT_CACHE.set(bin, supported);
  return supported;
}

function buildResultSpecJsonSchema(args: { job_id: string; attempt_run_id: string }): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "schema_version",
      "type",
      "job_id",
      "attempt_run_id",
      "status",
      "summary",
      "files_changed",
      "commands_run",
      "artifacts",
      "next_actions",
      "errors"
    ],
    properties: {
      schema_version: { type: "integer", const: 1 },
      type: { type: "string", const: "result" },
      job_id: { type: "string", const: args.job_id },
      attempt_run_id: { type: "string", const: args.attempt_run_id, minLength: 1 },
      status: {
        type: "string",
        enum: ["succeeded", "needs_input", "blocked", "failed", "canceled"]
      },
      summary: { type: "string", minLength: 1 },
      files_changed: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["path"],
          properties: {
            path: { type: "string", minLength: 1 },
            change_type: {
              type: "string",
              enum: ["added", "modified", "deleted", "renamed"]
            },
            summary: { type: "string", minLength: 1 }
          }
        }
      },
      commands_run: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["command"],
          properties: {
            command: { type: "string", minLength: 1 },
            exit_code: { type: ["integer", "null"] },
            summary: { type: "string", minLength: 1 }
          }
        }
      },
      artifacts: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["relpath"],
          properties: {
            relpath: { type: "string", minLength: 1 },
            artifact_id: { type: "string", minLength: 1 },
            kind: { type: "string", minLength: 1 },
            sha256: { type: "string", minLength: 1 }
          }
        }
      },
      next_actions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["action"],
          properties: {
            action: { type: "string", minLength: 1 },
            rationale: { type: "string", minLength: 1 }
          }
        }
      },
      errors: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["code", "message"],
          properties: {
            code: { type: "string", minLength: 1 },
            message: { type: "string", minLength: 1 },
            details: { type: "string" }
          }
        }
      }
    }
  };
}

function buildHeartbeatWorkerReportJsonSchema(): Record<string, unknown> {
  return {
    oneOf: [
      {
        type: "object",
        additionalProperties: false,
        required: ["schema_version", "type", "status", "token", "summary"],
        properties: {
          schema_version: { type: "integer", const: 1 },
          type: { type: "string", const: "heartbeat_worker_report" },
          status: { type: "string", const: "ok" },
          token: { type: "string", const: "HEARTBEAT_OK" },
          summary: { type: "string", minLength: 1 },
          actions: { type: "array", maxItems: 0 }
        }
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["schema_version", "type", "status", "summary", "actions"],
        properties: {
          schema_version: { type: "integer", const: 1 },
          type: { type: "string", const: "heartbeat_worker_report" },
          status: { type: "string", const: "actions" },
          summary: { type: "string", minLength: 1 },
          actions: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: true,
              required: ["kind", "idempotency_key", "risk", "needs_approval"],
              properties: {
                kind: { type: "string", minLength: 1 },
                idempotency_key: { type: "string", minLength: 1 },
                risk: { type: "string", enum: ["low", "medium", "high"] },
                needs_approval: { type: "boolean" },
                summary: { type: "string" }
              }
            }
          }
        }
      }
    ]
  };
}

async function probeCliProvenance(bin: string): Promise<{
  provider_version?: string;
  provider_help_hash?: string;
}> {
  const [versionProbe, helpProbe] = await Promise.all([
    runProbeCommand({ bin, argv: ["--version"], timeout_ms: 3500 }).catch(() => ({
      ok: false,
      stdout: "",
      stderr: "",
      exit_code: null
    })),
    runProbeCommand({ bin, argv: ["--help"], timeout_ms: 3500 }).catch(() => ({
      ok: false,
      stdout: "",
      stderr: "",
      exit_code: null
    }))
  ]);
  const versionRaw = `${versionProbe.stdout}\n${versionProbe.stderr}`.trim();
  const helpRaw = `${helpProbe.stdout}\n${helpProbe.stderr}`.trim();
  return {
    provider_version: versionRaw ? versionRaw.split(/\r?\n/)[0] : undefined,
    provider_help_hash: helpRaw ? hashText(helpRaw) : undefined
  };
}

async function buildLaunchCommand(args: {
  workspace_dir: string;
  provider: string;
  permission_level: JobPermissionLevel;
  prompt: string;
  run_id: string;
  run_outputs_dir_abs: string;
  job_id: string;
  attempt_run_id: string;
  result_contract_mode: WorkerResultContractMode;
  output_contract: WorkerOutputContract;
  model?: string;
  launcher?: Record<string, unknown>;
}): Promise<CommandBuild> {
  const provider = args.provider.trim();
  const resolved = await resolveProviderBin(args.workspace_dir, provider);
  if (provider === "codex_app_server" || provider === "codex-app-server") {
    return {
      mode: "protocol",
      prompt_text: args.prompt,
      model: args.model,
      provider_bin: resolved.bin
    };
  }

  if (resolved.driver === "codex") {
    const nativeSchemaEnabled =
      args.result_contract_mode === "provider_schema" && (await supportsCodexOutputSchema(resolved.bin));
    const codexSchemaPath = path.join(args.run_outputs_dir_abs, `result_spec_schema_${args.run_id}.json`);
    if (nativeSchemaEnabled) {
      const schema =
        args.output_contract === "heartbeat_worker_report"
          ? buildHeartbeatWorkerReportJsonSchema()
          : buildResultSpecJsonSchema({
              job_id: args.job_id,
              attempt_run_id: args.attempt_run_id
            });
      await fs.writeFile(
        codexSchemaPath,
        `${JSON.stringify(schema, null, 2)}\n`,
        { encoding: "utf8" }
      );
    }
    const argv = [
      resolved.bin,
      "exec",
      "--skip-git-repo-check",
      "--sandbox",
      mapCodexSandbox(args.permission_level),
      "--approval-policy",
      "never",
      "--color",
      "never"
    ];
    if (nativeSchemaEnabled) {
      argv.push("--output-schema", codexSchemaPath);
    }
    argv.push("--json", "-");
    if (args.model) {
      argv.splice(2, 0, "--model", args.model);
    }
    return {
      mode: "command",
      argv,
      stdin_text: args.prompt,
      model: args.model,
      provider_bin: resolved.bin
    };
  }

  if (resolved.driver === "claude") {
    const nativeSchemaEnabled =
      args.result_contract_mode === "provider_schema" && (await supportsClaudeJsonSchema(resolved.bin));
    const outputFormat = nativeSchemaEnabled ? "json" : "stream-json";
    const allowedToolsRaw = args.launcher?.allowed_tools;
    const allowedTools =
      Array.isArray(allowedToolsRaw) && allowedToolsRaw.every((v) => typeof v === "string")
        ? (allowedToolsRaw as string[]).map((v) => v.trim()).filter(Boolean)
        : [];
    const argv = [
      resolved.bin,
      "--print",
      "--output-format",
      outputFormat,
      "--no-session-persistence",
      "--permission-mode",
      "dontAsk",
      args.prompt
    ];
    if (!nativeSchemaEnabled) {
      argv.splice(4, 0, "--include-partial-messages");
    } else {
      const schema =
        args.output_contract === "heartbeat_worker_report"
          ? buildHeartbeatWorkerReportJsonSchema()
          : buildResultSpecJsonSchema({
              job_id: args.job_id,
              attempt_run_id: args.attempt_run_id
            });
      argv.splice(
        argv.length - 1,
        0,
        "--json-schema",
        JSON.stringify(schema)
      );
    }
    if (allowedTools.length > 0) {
      argv.splice(argv.length - 1, 0, "--allowedTools", allowedTools.join(","));
    }
    if (args.model) {
      argv.splice(1, 0, "--model", args.model);
    }
    return {
      mode: "command",
      argv,
      model: args.model,
      provider_bin: resolved.bin,
      output_format: outputFormat
    };
  }

  const outputFormat = "json";
  const launcherTemplate = tryLauncherTemplate(args.launcher);
  if (!launcherTemplate) {
    const argv = [resolved.bin, "--output-format", outputFormat];
    if (args.model) argv.push("--model", args.model);
    argv.push("-p", args.prompt);
    return {
      mode: "command",
      argv,
      model: args.model,
      provider_bin: resolved.bin,
      output_format: outputFormat
    };
  }
  validateLauncherTemplate(launcherTemplate);
  const replaced = launcherTemplate.map((part) => {
    return part
      .replaceAll("{PROMPT}", args.prompt)
      .replaceAll("{MODEL}", args.model ?? "")
      .replaceAll("{PERMISSION_LEVEL}", args.permission_level)
      .replaceAll("{OUTPUT_FORMAT}", outputFormat);
  });
  return {
    mode: "command",
    argv: replaced,
    model: args.model,
    provider_bin: resolved.bin,
    output_format: outputFormat
  };
}

function asObject(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function collectText(value: unknown, depth = 0): string[] {
  if (depth > 8) return [];
  if (typeof value === "string") {
    const s = value.trim();
    return s.length ? [s] : [];
  }
  if (Array.isArray(value)) return value.flatMap((v) => collectText(v, depth + 1));
  const obj = asObject(value);
  if (!obj) return [];
  const keys = ["text", "output_text", "content", "message", "result", "completion", "delta"];
  const out: string[] = [];
  for (const key of keys) {
    if (!(key in obj)) continue;
    out.push(...collectText(obj[key], depth + 1));
  }
  return out;
}

function extractTextFromJsonLines(raw: string): string {
  const texts: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const parsed = JSON.parse(t) as unknown;
      texts.push(...collectText(parsed));
    } catch {
      // ignore non-json lines
    }
  }
  if (!texts.length) return raw;
  let longest = texts[0];
  for (const t of texts.slice(1)) {
    if (t.length > longest.length) longest = t;
  }
  return longest;
}

async function readOutputText(args: {
  workspace_dir: string;
  project_id: string;
  output_relpaths: string[];
  provider: string;
}): Promise<string> {
  const candidates = [...args.output_relpaths]
    .sort((a, b) => a.localeCompare(b))
    .map((rel) => ({
      rel,
      abs: path.join(args.workspace_dir, "work/projects", args.project_id, rel)
    }));
  const preferred = [
    candidates.find((c) => c.rel.endsWith("/result_spec.json")),
    candidates.find((c) => c.rel.endsWith("/result_spec.jsonl")),
    candidates.find((c) => c.rel.endsWith("/last_message.md")),
    candidates.find((c) => c.rel.endsWith("/stdout.txt")),
    candidates.find((c) => c.rel.endsWith("/stderr.txt"))
  ].filter((c): c is { rel: string; abs: string } => Boolean(c));
  const ordered = [...preferred, ...candidates.filter((c) => !preferred.some((p) => p.abs === c.abs))];

  for (const item of ordered) {
    try {
      const raw = await fs.readFile(item.abs, { encoding: "utf8" });
      if (!raw.trim()) continue;
      if (item.rel.endsWith("/last_message.md")) return raw;
      if (args.provider === "claude" || args.provider === "claude_code" || args.provider === "claude-code") {
        try {
          return extractClaudeMarkdownFromStreamJson(raw);
        } catch {
          return raw;
        }
      }
      return extractTextFromJsonLines(raw);
    } catch {
      // continue
    }
  }
  return "";
}

async function markPrelaunchBlockedRun(args: {
  workspace_dir: string;
  project_id: string;
  run_id: string;
  session_ref: string;
  reason: string;
}): Promise<void> {
  const runYamlPath = path.join(
    args.workspace_dir,
    "work/projects",
    args.project_id,
    "runs",
    args.run_id,
    "run.yaml"
  );
  const eventsPath = path.join(
    args.workspace_dir,
    "work/projects",
    args.project_id,
    "runs",
    args.run_id,
    "events.jsonl"
  );
  const endedAt = nowIso();
  try {
    const runDoc = RunYaml.parse(await readYamlFile(runYamlPath));
    await writeYamlFile(runYamlPath, {
      ...runDoc,
      status: "failed",
      ended_at: endedAt
    });
  } catch {
    // best effort
  }
  await appendEventJsonl(
    eventsPath,
    newEnvelope({
      schema_version: 1,
      ts_wallclock: endedAt,
      run_id: args.run_id,
      session_ref: args.session_ref,
      actor: "system",
      visibility: "managers",
      type: "run.failed",
      payload: {
        preflight: true,
        reason: args.reason,
        exit_code: null,
        signal: null,
        stopped: false
      }
    })
  ).catch(() => {});
}

async function waitForTerminalSession(args: {
  session_ref: string;
  workspace_dir: string;
  abort_signal?: AbortSignal;
  timeout_ms: number;
}): Promise<{ status: "ended" | "failed" | "stopped"; error?: string }> {
  const end = Date.now() + args.timeout_ms;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (args.abort_signal?.aborted) {
      await stopSession(args.session_ref, { workspace_dir: args.workspace_dir }).catch(() => {});
      return { status: "stopped", error: "Attempt canceled by caller" };
    }
    const poll = await pollSession(args.session_ref, { workspace_dir: args.workspace_dir });
    if (poll.status !== "running") {
      return {
        status: poll.status as "ended" | "failed" | "stopped",
        error: poll.error
      };
    }
    if (Date.now() >= end) {
      await stopSession(args.session_ref, { workspace_dir: args.workspace_dir }).catch(() => {});
      return { status: "failed", error: `Worker attempt timed out after ${args.timeout_ms}ms` };
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

export function buildInitialAttemptPrompt(args: { job: JobSpec; attempt_run_id: string }): string {
  if (args.job.job_kind === "heartbeat") {
    return [
      "Return only JSON. Do not include markdown fences or explanatory prose.",
      "Act as a worker heartbeat responder. Propose actions only when there is concrete work to do.",
      "",
      `job_id: ${args.job.job_id}`,
      `attempt_run_id: ${args.attempt_run_id}`,
      `goal: ${args.job.goal}`,
      "",
      "constraints:",
      ...args.job.constraints.map((c) => `- ${c}`),
      "",
      "context_refs:",
      ...args.job.context_refs.map((ref) => `- [${ref.kind}] ${ref.value}${ref.description ? ` (${ref.description})` : ""}`),
      "",
      "HeartbeatWorkerReport JSON shape:",
      JSON.stringify(
        {
          schema_version: 1,
          type: "heartbeat_worker_report",
          status: "ok|actions",
          token: "HEARTBEAT_OK (required when status=ok)",
          summary: "string",
          actions: [
            {
              kind: "launch_job|add_comment|create_approval_item|noop",
              idempotency_key: "string",
              risk: "low|medium|high",
              needs_approval: true,
              summary: "string"
            }
          ]
        },
        null,
        2
      )
    ].join("\n");
  }

  return [
    "Return only JSON that matches the ResultSpec schema.",
    "Do not include markdown fences or explanatory prose.",
    "",
    `job_id: ${args.job.job_id}`,
    `attempt_run_id: ${args.attempt_run_id}`,
    `goal: ${args.job.goal}`,
    `permission_level: ${args.job.permission_level}`,
    "",
    "constraints:",
    ...args.job.constraints.map((c) => `- ${c}`),
    "",
    "deliverables:",
    ...args.job.deliverables.map((d) => `- ${d}`),
    "",
    "context_refs:",
    ...args.job.context_refs.map((ref) => `- [${ref.kind}] ${ref.value}${ref.description ? ` (${ref.description})` : ""}`),
    "",
    "ResultSpec JSON shape:",
    JSON.stringify(
      {
        schema_version: 1,
        type: "result",
        job_id: args.job.job_id,
        attempt_run_id: args.attempt_run_id,
        status: "succeeded|needs_input|blocked|failed|canceled",
        summary: "string",
        files_changed: [{ path: "string", change_type: "added|modified|deleted|renamed", summary: "string?" }],
        commands_run: [{ command: "string", exit_code: 0, summary: "string?" }],
        artifacts: [{ relpath: "string", artifact_id: "string?", kind: "string?", sha256: "string?" }],
        next_actions: [{ action: "string", rationale: "string?" }],
        errors: [{ code: "string", message: "string", details: "string?" }]
      },
      null,
      2
    )
  ].join("\n");
}

export async function runWorkerAttempt(args: WorkerAttemptArgs): Promise<WorkerAttemptResult> {
  const run = await createRun({
    workspace_dir: args.job.workspace_dir,
    project_id: args.job.project_id,
    agent_id: args.worker.agent_id,
    provider: args.worker.provider
  });
  const sessionRef = `job_${args.job.job_id}_attempt_${args.attempt}_${run.run_id}`;
  const eventsPath = path.join(
    args.job.workspace_dir,
    "work/projects",
    args.job.project_id,
    "runs",
    run.run_id,
    "events.jsonl"
  );

  const launchBuild = await buildLaunchCommand({
    workspace_dir: args.job.workspace_dir,
    provider: args.worker.provider,
    permission_level: args.job.permission_level,
    prompt: args.prompt,
    run_id: run.run_id,
    run_outputs_dir_abs: path.join(
      args.job.workspace_dir,
      "work/projects",
      args.job.project_id,
      "runs",
      run.run_id,
      "outputs"
    ),
    job_id: args.job.job_id,
    attempt_run_id: run.run_id,
    result_contract_mode: args.result_contract_mode ?? "prompt_only",
    output_contract: args.output_contract ?? "result_spec",
    model: args.job.model ?? args.worker.model_hint,
    launcher: args.worker.launcher
  });

  const subscription = await enforceSubscriptionExecutionPolicy({
    workspace_dir: args.job.workspace_dir,
    provider: args.worker.provider,
    events_file_path: eventsPath,
    run_id: run.run_id,
    session_ref: sessionRef,
    effective_env: launchBuild.env
  });
  if (!subscription.ok) {
    await markPrelaunchBlockedRun({
      workspace_dir: args.job.workspace_dir,
      project_id: args.job.project_id,
      run_id: run.run_id,
      session_ref: sessionRef,
      reason: subscription.reason
    });
    return {
      run_id: run.run_id,
      context_pack_id: run.context_pack_id,
      session_ref: sessionRef,
      status: "failed",
      provider_bin: launchBuild.provider_bin,
      output_format: launchBuild.output_format,
      raw_output: "",
      output_relpaths: [],
      error: subscription.message,
      blocked_reason: "subscription_unverified"
    };
  }

  const provenance = await probeCliProvenance(launchBuild.provider_bin);
  await appendEventJsonl(
    eventsPath,
    newEnvelope({
      schema_version: 1,
      ts_wallclock: nowIso(),
      run_id: run.run_id,
      session_ref: sessionRef,
      actor: "system",
      visibility: "managers",
      type: "worker.cli.provenance",
      payload: {
        provider: args.worker.provider,
        provider_bin: launchBuild.provider_bin,
        provider_version: provenance.provider_version ?? null,
        provider_help_hash: provenance.provider_help_hash ?? null,
        output_format: launchBuild.output_format ?? null
      }
    })
  ).catch(() => {});

  const launched = await launchSession({
    workspace_dir: args.job.workspace_dir,
    project_id: args.job.project_id,
    run_id: run.run_id,
    argv: launchBuild.mode === "command" ? launchBuild.argv : [],
    stdin_text: launchBuild.mode === "command" ? launchBuild.stdin_text : undefined,
    prompt_text: launchBuild.mode === "protocol" ? launchBuild.prompt_text : undefined,
    env: launchBuild.env,
    model: launchBuild.model,
    session_ref: sessionRef,
    actor_id: args.job.manager_actor_id ?? "manager",
    actor_role: args.job.manager_role ?? "manager"
  });

  const terminal = await waitForTerminalSession({
    session_ref: launched.session_ref,
    workspace_dir: args.job.workspace_dir,
    abort_signal: args.abort_signal,
    timeout_ms: Number.parseInt(process.env.AC_JOB_ATTEMPT_TIMEOUT_MS ?? "", 10) || 30 * 60 * 1000
  });

  const collected = await collectSession(launched.session_ref, { workspace_dir: args.job.workspace_dir });
  const rawText = await readOutputText({
    workspace_dir: args.job.workspace_dir,
    project_id: args.job.project_id,
    output_relpaths: collected.output_relpaths,
    provider: args.worker.provider
  });

  return {
    run_id: run.run_id,
    context_pack_id: run.context_pack_id,
    session_ref: launched.session_ref,
    status: terminal.status,
    provider_bin: launchBuild.provider_bin,
    provider_version: provenance.provider_version,
    provider_help_hash: provenance.provider_help_hash,
    output_format: launchBuild.output_format,
    raw_output: rawText,
    output_relpaths: collected.output_relpaths,
    error: terminal.error
  };
}
