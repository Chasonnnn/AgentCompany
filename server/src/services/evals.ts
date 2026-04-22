import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import {
  buildEmptyEvalSummaryIndex,
  type ComponentEvalAdapterType,
  type ComponentEvalRunRequest,
  type ComponentEvalRunResult,
  type ComponentEvalTraceSummary,
  evalRunArtifactSchema,
  evalSummaryIndexSchema,
  type EvalRunArtifact,
  type EvalRunListItem,
  type EvalSummaryIndex,
} from "@paperclipai/shared";
import {
  getServerAdapter,
  type AdapterEnvironmentCheck,
  type AdapterEnvironmentTestResult,
  type AdapterExecutionContext,
  type AdapterExecutionResult,
  type ServerAdapterModule,
} from "../adapters/index.js";
import { unprocessable } from "../errors.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

const SAFE_RUN_ID_RE = /^[a-zA-Z0-9._-]+$/;
const COMPONENT_EVAL_ADAPTER_TYPES = ["codex_local", "claude_local"] as const;
const BLOCKING_PRECHECK_CODES = new Set([
  "codex_cwd_invalid",
  "claude_cwd_invalid",
  "codex_command_unresolvable",
  "claude_command_unresolvable",
  "codex_openai_api_key_missing",
  "codex_hello_probe_auth_required",
  "codex_hello_probe_auth_stale",
  "claude_hello_probe_auth_required",
]);
const BLOCKED_RUNTIME_ERROR_CODES = new Set(["claude_auth_required"]);
const BLOCKED_RUNTIME_MESSAGE_RE =
  /(?:not\s+logged\s+in|login\s+required|authentication\s+required|please\s+run\s+`?(?:codex|claude)\s+login`?|access token could not be refreshed|openai[_\s-]?api[_\s-]?key|anthropic[_\s-]?api[_\s-]?key|unauthorized|invalid(?:\s+or\s+missing)?\s+api(?:[_\s-]?key)?)/i;
const WARNING_NOTE_RE = /(?:warn|skip|unable|unavailable|retry|invalid|missing|blocked|required|not\s+ready|could not)/i;
const CODEX_SHARED_FILES = ["config.json", "config.toml", "instructions.md"] as const;
const CODEX_SHARED_DIRECTORIES = ["agents"] as const;
const CLAUDE_SHARED_FILES = [
  "settings.json",
  "settings.local.json",
  ".claude.json",
  ".credentials.json",
  "credentials.json",
] as const;

function defaultArtifactRoot() {
  return path.join(resolvePaperclipInstanceRoot(), "data", "evals", "architecture");
}

function resolveRunPath(rootPath: string, runId: string) {
  if (!SAFE_RUN_ID_RE.test(runId)) {
    return null;
  }
  return path.join(rootPath, "runs", runId, "artifact.json");
}

type EvalServiceOptions = {
  artifactRoot?: string;
  adapterResolver?: (type: string) => ServerAdapterModule;
  createTempDir?: (prefix: string) => Promise<string>;
  removeDir?: (dir: string) => Promise<void>;
};

type ComponentEvalFixture = {
  rootDir: string;
  workspaceDir: string;
  logsDir: string;
  homeDir: string;
  codexHomeDir: string;
  claudeConfigDir: string;
};

function isComponentEvalAdapterType(value: string): value is ComponentEvalAdapterType {
  return (COMPONENT_EVAL_ADAPTER_TYPES as readonly string[]).includes(value);
}

async function ensureDir(dirPath: string) {
  await fs.mkdir(dirPath, { recursive: true });
}

function isStringRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function resolveStringVar(vars: Record<string, unknown>, key: string): string | null {
  return readString(vars[key]);
}

function summarizeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : "Unknown component eval error";
}

function defaultCreateTempDir(prefix: string) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function defaultRemoveDir(dir: string) {
  return fs.rm(dir, { recursive: true, force: true });
}

function resolveSharedCodexHomeDir(env: NodeJS.ProcessEnv = process.env) {
  const configured = readString(env.CODEX_HOME);
  return configured ? path.resolve(configured) : path.join(os.homedir(), ".codex");
}

function resolveSharedClaudeConfigDir(env: NodeJS.ProcessEnv = process.env) {
  const configured = readString(env.CLAUDE_CONFIG_DIR);
  if (configured) return path.resolve(configured);
  const homeDir = readString(env.HOME) ?? os.homedir();
  return path.join(homeDir, ".claude");
}

async function copyFileIfExists(source: string, target: string) {
  const exists = await fs.access(source).then(() => true).catch(() => false);
  if (!exists) return;
  await ensureDir(path.dirname(target));
  await fs.copyFile(source, target);
}

async function copyDirectoryIfExists(source: string, target: string) {
  const stat = await fs.stat(source).catch(() => null);
  if (!stat?.isDirectory()) return;
  await fs.cp(source, target, { recursive: true, force: true });
}

async function seedCodexHome(targetHome: string) {
  const sharedHome = resolveSharedCodexHomeDir();
  await ensureDir(targetHome);
  await copyFileIfExists(path.join(sharedHome, "auth.json"), path.join(targetHome, "auth.json"));
  for (const fileName of CODEX_SHARED_FILES) {
    await copyFileIfExists(path.join(sharedHome, fileName), path.join(targetHome, fileName));
  }
  for (const directoryName of CODEX_SHARED_DIRECTORIES) {
    await copyDirectoryIfExists(path.join(sharedHome, directoryName), path.join(targetHome, directoryName));
  }
}

async function seedClaudeConfigDir(targetDir: string) {
  const sharedDir = resolveSharedClaudeConfigDir();
  await ensureDir(targetDir);
  for (const fileName of CLAUDE_SHARED_FILES) {
    await copyFileIfExists(path.join(sharedDir, fileName), path.join(targetDir, fileName));
  }
}

async function createComponentEvalFixture(
  adapterType: ComponentEvalAdapterType,
  createTempDir: (prefix: string) => Promise<string>,
): Promise<ComponentEvalFixture> {
  const rootDir = await createTempDir(`paperclip-component-eval-${adapterType}-`);
  const workspaceDir = path.join(rootDir, "workspace");
  const logsDir = path.join(rootDir, "logs");
  const homeDir = path.join(rootDir, "home");
  const codexHomeDir = path.join(rootDir, "codex-home");
  const claudeConfigDir = path.join(rootDir, "claude-config");
  await Promise.all([
    ensureDir(workspaceDir),
    ensureDir(logsDir),
    ensureDir(homeDir),
  ]);
  await Promise.all([
    adapterType === "codex_local" ? seedCodexHome(codexHomeDir) : ensureDir(codexHomeDir),
    adapterType === "claude_local" ? seedClaudeConfigDir(claudeConfigDir) : ensureDir(claudeConfigDir),
  ]);
  return {
    rootDir,
    workspaceDir,
    logsDir,
    homeDir,
    codexHomeDir,
    claudeConfigDir,
  };
}

function buildComponentEvalConfig(
  input: ComponentEvalRunRequest,
  fixture: ComponentEvalFixture,
): Record<string, unknown> {
  const timeoutSec = Math.max(1, Math.ceil((input.timeoutMs ?? 90_000) / 1000));
  const env: Record<string, string> = {
    PAPERCLIP_COMPONENT_EVAL_CASE_ID: input.caseId,
    PAPERCLIP_COMPONENT_EVAL_ADAPTER: input.adapterType,
  };
  if (input.adapterType === "codex_local") {
    env.HOME = fixture.homeDir;
    env.CODEX_HOME = fixture.codexHomeDir;
  }
  return {
    cwd: fixture.workspaceDir,
    promptTemplate: "{{context.componentEvalPrompt}}",
    timeoutSec,
    graceSec: 5,
    env,
    ...(input.adapterType === "codex_local"
      ? { dangerouslyBypassApprovalsAndSandbox: true }
      : {}),
  };
}

function buildComponentEvalContext(input: ComponentEvalRunRequest): Record<string, unknown> {
  return {
    componentEvalCaseId: input.caseId,
    componentEvalPrompt: input.prompt,
    componentEvalVars: input.vars,
    taskId: resolveStringVar(input.vars, "taskId") ?? input.caseId,
    wakeReason: resolveStringVar(input.vars, "wakeReason") ?? "component_eval",
    approvalId: resolveStringVar(input.vars, "approvalId") ?? null,
  };
}

function parseTranscript(stdout: string): unknown[] | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return null;
  return lines.map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return line;
    }
  });
}

function walkUnknown(value: unknown, visit: (value: unknown) => void) {
  visit(value);
  if (Array.isArray(value)) {
    for (const entry of value) walkUnknown(entry, visit);
    return;
  }
  if (!isStringRecord(value)) return;
  for (const entry of Object.values(value)) {
    walkUnknown(entry, visit);
  }
}

function extractTranscriptText(rawTranscript: unknown[] | null): string {
  if (!rawTranscript) return "";
  const texts: string[] = [];
  const push = (value: unknown) => {
    const text = readString(value);
    if (text && !texts.includes(text)) texts.push(text);
  };
  for (const entry of rawTranscript) {
    if (!isStringRecord(entry)) continue;
    if (entry.type === "assistant" && isStringRecord(entry.message) && Array.isArray(entry.message.content)) {
      for (const content of entry.message.content) {
        if (isStringRecord(content) && content.type === "text") {
          push(content.text);
        }
      }
    }
    if (entry.type === "result") {
      push(entry.result);
    }
    if (entry.type === "agent_message") {
      push(entry.text);
    }
    if (isStringRecord(entry.item) && entry.item.type === "agentMessage") {
      push(entry.item.text);
    }
  }
  return texts.join("\n\n").trim();
}

function buildTraceSummary(
  rawTranscript: unknown[] | null,
  adapterResult: AdapterExecutionResult | null,
  commandNotes: string[],
  preflightWarnings: string[],
  stderrExcerpt: string | null,
): ComponentEvalTraceSummary {
  const eventKinds = new Set<string>();
  const toolNames = new Set<string>();
  let discoveredSessionId =
    readString(adapterResult?.sessionDisplayId) ??
    readString(adapterResult?.sessionId) ??
    null;

  for (const entry of rawTranscript ?? []) {
    walkUnknown(entry, (value) => {
      if (!isStringRecord(value)) return;
      const type = readString(value.type);
      if (type) eventKinds.add(type);
      const method = readString(value.method);
      if (method) {
        eventKinds.add(method);
        if (method.startsWith("item/tool/")) {
          toolNames.add(method.slice("item/tool/".length));
        }
      }
      const eventType = readString(value.eventType);
      if (eventType) eventKinds.add(eventType);
      if (!discoveredSessionId) {
        discoveredSessionId =
          readString(value.session_id) ??
          readString(value.sessionId) ??
          readString(value.thread_id) ??
          readString(value.threadId) ??
          discoveredSessionId;
      }
      const name = readString(value.name);
      if (name && type === "tool_use") {
        toolNames.add(name);
      }
      if (isStringRecord(value.item) && value.item.type === "toolCall") {
        const itemName = readString(value.item.name);
        if (itemName) toolNames.add(itemName);
      }
    });
  }

  const warnings = Array.from(new Set([
    ...commandNotes.filter((note) => WARNING_NOTE_RE.test(note)),
    ...preflightWarnings,
    ...(stderrExcerpt ? [stderrExcerpt] : []),
  ]));

  return {
    eventKinds: [...eventKinds],
    toolNames: [...toolNames],
    sessionId: discoveredSessionId,
    warnings,
  };
}

function firstNonEmptyLine(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

function buildStderrExcerpt(stderr: string, fallback: string | null): string | null {
  const line = firstNonEmptyLine(stderr);
  const source = line ?? fallback;
  if (!source) return null;
  return source.length > 280 ? `${source.slice(0, 279)}…` : source;
}

function hasQuestion(adapterResult: AdapterExecutionResult | null): boolean {
  return Boolean(
    adapterResult?.question ||
    (Array.isArray(adapterResult?.questions) && adapterResult.questions.length > 0),
  );
}

function buildFinalText(
  adapterResult: AdapterExecutionResult | null,
  transcriptText: string,
): string {
  const summary = readString(adapterResult?.summary);
  if (summary) return summary;
  if (transcriptText) return transcriptText;
  const questionPrompt = readString(adapterResult?.question?.prompt);
  if (questionPrompt) return questionPrompt;
  const questionList = Array.isArray(adapterResult?.questions)
    ? adapterResult.questions
      .map((question) => readString(question.prompt))
      .filter((value): value is string => value != null)
    : [];
  return questionList.join("\n\n");
}

function isBlockedByRuntimeResult(result: AdapterExecutionResult | null, stderr: string): boolean {
  if (!result) return false;
  if (result.errorCode && BLOCKED_RUNTIME_ERROR_CODES.has(result.errorCode)) return true;
  const evidence = [result.errorMessage ?? "", stderr].join("\n");
  return BLOCKED_RUNTIME_MESSAGE_RE.test(evidence);
}

function findBlockingPrecheck(preflight: AdapterEnvironmentTestResult | null): AdapterEnvironmentCheck | null {
  if (!preflight) return null;
  return preflight.checks.find((check) => BLOCKING_PRECHECK_CODES.has(check.code)) ?? null;
}

function formatPrecheckWarning(check: AdapterEnvironmentCheck): string {
  const detail = readString(check.detail);
  return detail ? `${check.message} (${detail})` : check.message;
}

export function evalService(options?: EvalServiceOptions) {
  const artifactRoot = options?.artifactRoot ?? defaultArtifactRoot();
  const adapterResolver = (options as EvalServiceOptions | undefined)?.adapterResolver ?? getServerAdapter;
  const createTempDir = (options as EvalServiceOptions | undefined)?.createTempDir ?? defaultCreateTempDir;
  const removeDir = (options as EvalServiceOptions | undefined)?.removeDir ?? defaultRemoveDir;

  async function getSummary(): Promise<EvalSummaryIndex> {
    const summaryPath = path.join(artifactRoot, "summary", "index.json");
    const raw = await fs.readFile(summaryPath, "utf8").catch(() => null);
    if (!raw) {
      return buildEmptyEvalSummaryIndex();
    }
    return evalSummaryIndexSchema.parse(JSON.parse(raw));
  }

  async function listRuns(): Promise<EvalRunListItem[]> {
    const summary = await getSummary();
    return [...summary.runs].sort((left, right) => {
      return Date.parse(right.completedAt) - Date.parse(left.completedAt);
    });
  }

  async function getRun(runId: string): Promise<EvalRunArtifact | null> {
    const artifactPath = resolveRunPath(artifactRoot, runId);
    if (!artifactPath) return null;
    const raw = await fs.readFile(artifactPath, "utf8").catch(() => null);
    if (!raw) return null;
    const parsed = evalRunArtifactSchema.parse(JSON.parse(raw));
    return {
      ...parsed,
      redactionMode: "redacted",
    };
  }

  async function runComponent(input: ComponentEvalRunRequest): Promise<ComponentEvalRunResult> {
    if (!isComponentEvalAdapterType(input.adapterType)) {
      throw unprocessable(`Unsupported component eval adapter type '${input.adapterType}'.`);
    }

    const fixture = await createComponentEvalFixture(input.adapterType, createTempDir);
    const runId = resolveStringVar(input.vars, "runId") ?? `component-eval-${randomUUID()}`;
    const agentId = resolveStringVar(input.vars, "agentId") ?? `component-eval-${input.adapterType}`;
    const companyId = resolveStringVar(input.vars, "companyId") ?? "component-evals";
    const adapter = adapterResolver(input.adapterType);
    const config = buildComponentEvalConfig(input, fixture);
    const context = buildComponentEvalContext(input);
    const commandNotes: string[] = [];
    let stdout = "";
    let stderr = "";
    let adapterResult: AdapterExecutionResult | null = null;
    let preflight: AdapterEnvironmentTestResult | null = null;
    let caughtError: unknown = null;
    const startedAt = Date.now();

    try {
      const executionContext: AdapterExecutionContext = {
        runId,
        agent: {
          id: agentId,
          companyId,
          name: `${input.adapterType} component eval`,
          adapterType: input.adapterType,
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: resolveStringVar(input.vars, "taskId"),
        },
        config,
        context,
        authToken: `component-eval-${runId}`,
        onLog: async (stream, chunk) => {
          if (stream === "stdout") stdout += chunk;
          else stderr += chunk;
        },
        onMeta: async (meta) => {
          commandNotes.push(...(meta.commandNotes ?? []));
        },
      };

      try {
        adapterResult = await adapter.execute(executionContext);
      } catch (err) {
        caughtError = err;
      }

      if (!adapterResult || isBlockedByRuntimeResult(adapterResult, stderr)) {
        try {
          preflight = await adapter.testEnvironment({
            companyId,
            adapterType: input.adapterType,
            config,
          });
        } catch {
          preflight = null;
        }
      }

      const blockingPrecheck = findBlockingPrecheck(preflight);
      const stderrExcerpt = buildStderrExcerpt(stderr, adapterResult?.errorMessage ?? summarizeError(caughtError));
      const rawTranscript = parseTranscript(
        stdout || readString(adapterResult?.resultJson?.stdout) || "",
      );
      const transcriptText = buildFinalText(adapterResult, extractTranscriptText(rawTranscript));
      const durationMs = Date.now() - startedAt;
      const preflightWarnings = preflight?.checks
        .filter((check) => check.level !== "info")
        .map(formatPrecheckWarning) ?? [];
      const traceSummary = buildTraceSummary(rawTranscript, adapterResult, commandNotes, preflightWarnings, null);

      if (adapterResult?.timedOut) {
        return {
          executionStatus: "timed_out",
          adapterType: input.adapterType,
          modelId: readString(adapterResult.model),
          finalText: transcriptText,
          durationMs,
          stderrExcerpt,
          traceSummary,
          rawTranscript,
          errorMessage: readString(adapterResult.errorMessage) ?? "Component eval timed out.",
        };
      }

      if (blockingPrecheck || isBlockedByRuntimeResult(adapterResult, stderr)) {
        const blockingMessage =
          blockingPrecheck
            ? formatPrecheckWarning(blockingPrecheck)
            : readString(adapterResult?.errorMessage) ?? summarizeError(caughtError);
        return {
          executionStatus: "blocked",
          adapterType: input.adapterType,
          modelId: readString(adapterResult?.model),
          finalText: transcriptText,
          durationMs,
          stderrExcerpt,
          traceSummary: {
            ...traceSummary,
            warnings: Array.from(new Set([
              ...traceSummary.warnings,
              ...(blockingMessage ? [blockingMessage] : []),
            ])),
          },
          rawTranscript,
          errorMessage: blockingMessage,
        };
      }

      const successfulExit = adapterResult != null && (adapterResult.exitCode ?? 0) === 0;
      const invalidTranscript =
        successfulExit &&
        !readString(transcriptText) &&
        !hasQuestion(adapterResult) &&
        !traceSummary.sessionId &&
        traceSummary.eventKinds.length === 0 &&
        traceSummary.toolNames.length === 0;

      if (invalidTranscript) {
        return {
          executionStatus: "invalid",
          adapterType: input.adapterType,
          modelId: readString(adapterResult?.model),
          finalText: "",
          durationMs,
          stderrExcerpt,
          traceSummary,
          rawTranscript,
          errorMessage: readString(adapterResult?.errorMessage) ?? "Component eval produced no usable transcript.",
        };
      }

      if (successfulExit && !readString(adapterResult?.errorMessage)) {
        return {
          executionStatus: "succeeded",
          adapterType: input.adapterType,
          modelId: readString(adapterResult?.model),
          finalText: transcriptText,
          durationMs,
          stderrExcerpt,
          traceSummary,
          rawTranscript,
          errorMessage: null,
        };
      }

      return {
        executionStatus: "failed",
        adapterType: input.adapterType,
        modelId: readString(adapterResult?.model),
        finalText: transcriptText,
        durationMs,
        stderrExcerpt,
        traceSummary,
        rawTranscript,
        errorMessage: readString(adapterResult?.errorMessage) ?? summarizeError(caughtError),
      };
    } finally {
      await removeDir(fixture.rootDir).catch(() => undefined);
    }
  }

  return {
    artifactRoot,
    getSummary,
    listRuns,
    getRun,
    runComponent,
  };
}
