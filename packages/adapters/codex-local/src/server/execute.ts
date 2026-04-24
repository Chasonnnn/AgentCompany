import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inferOpenAiCompatibleBiller, type AdapterExecutionContext, type AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  parseLocalExecutionPolicy,
  permissiveLocalExecutionPolicy,
} from "@paperclipai/adapter-utils/local-execution-policy";
import {
  adapterExecutionTargetIsRemote,
  adapterExecutionTargetPaperclipApiUrl,
  adapterExecutionTargetRemoteCwd,
  adapterExecutionTargetSessionIdentity,
  adapterExecutionTargetSessionMatches,
  describeAdapterExecutionTarget,
  ensureAdapterExecutionTargetCommandResolvable,
  prepareAdapterExecutionTargetRuntime,
  readAdapterExecutionTarget,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
} from "@paperclipai/adapter-utils/execution-target";
import {
  asString,
  asNumber,
  parseObject,
  buildPaperclipEnv,
  buildInvocationEnvForLogs,
  ensureAbsoluteDirectory,
  ensurePaperclipSkillSymlink,
  ensurePathInEnv,
  readPaperclipRuntimeSkillEntries,
  resolvePaperclipDesiredSkillNames,
  renderTemplate,
  renderPaperclipWakePrompt,
  renderPaperclipProjectContext,
  normalizePaperclipWakePayload,
  stringifyPaperclipWakePayload,
  joinPromptSections,
} from "@paperclipai/adapter-utils/server-utils";
import {
  parseCodexJsonl,
  extractCodexRetryNotBefore,
  isCodexTransientUpstreamError,
  isCodexUnknownSessionError,
} from "./parse.js";
import { pathExists, prepareManagedCodexHome, resolveManagedCodexHomeDir, resolveSharedCodexHomeDir } from "./codex-home.js";
import { resolveCodexDesiredSkillNames } from "./skills.js";
import { buildCodexExecArgs } from "./codex-args.js";
import { CodexAppServerClient, NO_RESPONSE } from "./app-server-client.js";
import { DEFAULT_CODEX_LOCAL_MODEL } from "../index.js";
import {
  buildDecisionQuestionCapture,
  buildPendingUserInputResponse,
  normalizeAppServerNotification,
  normalizePendingUserInputQuestions,
  parsePendingUserInput,
  type PendingUserInputState,
} from "./app-server-normalize.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));
const CODEX_ROLLOUT_NOISE_RE =
  /^\d{4}-\d{2}-\d{2}T[^\s]+\s+ERROR\s+codex_core::rollout::list:\s+state db missing rollout path for thread\s+[a-z0-9-]+$/i;

function stripCodexRolloutNoise(text: string): string {
  const parts = text.split(/\r?\n/);
  const kept: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) {
      kept.push(part);
      continue;
    }
    if (CODEX_ROLLOUT_NOISE_RE.test(trimmed)) continue;
    kept.push(part);
  }
  return kept.join("\n");
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function hasNonEmptyEnvValue(env: Record<string, string>, key: string): boolean {
  const raw = env[key];
  return typeof raw === "string" && raw.trim().length > 0;
}

function resolveCodexBillingType(env: Record<string, string>): "api" | "subscription" {
  // Codex uses API-key auth when OPENAI_API_KEY is present; otherwise rely on local login/session auth.
  return hasNonEmptyEnvValue(env, "OPENAI_API_KEY") ? "api" : "subscription";
}

function resolveCodexBiller(env: Record<string, string>, billingType: "api" | "subscription"): string {
  const openAiCompatibleBiller = inferOpenAiCompatibleBiller(env, "openai");
  if (openAiCompatibleBiller === "openrouter") return "openrouter";
  return billingType === "subscription" ? "chatgpt" : openAiCompatibleBiller ?? "openai";
}

async function isLikelyPaperclipRepoRoot(candidate: string): Promise<boolean> {
  const [hasWorkspace, hasPackageJson, hasServerDir, hasAdapterUtilsDir] = await Promise.all([
    pathExists(path.join(candidate, "pnpm-workspace.yaml")),
    pathExists(path.join(candidate, "package.json")),
    pathExists(path.join(candidate, "server")),
    pathExists(path.join(candidate, "packages", "adapter-utils")),
  ]);

  return hasWorkspace && hasPackageJson && hasServerDir && hasAdapterUtilsDir;
}

async function isLikelyPaperclipRuntimeSkillPath(
  candidate: string,
  skillName: string,
  options: { requireSkillMarkdown?: boolean } = {},
): Promise<boolean> {
  if (path.basename(candidate) !== skillName) return false;
  const skillsRoot = path.dirname(candidate);
  if (path.basename(skillsRoot) !== "skills") return false;
  if (options.requireSkillMarkdown !== false && !(await pathExists(path.join(candidate, "SKILL.md")))) {
    return false;
  }

  let cursor = path.dirname(skillsRoot);
  for (let depth = 0; depth < 6; depth += 1) {
    if (await isLikelyPaperclipRepoRoot(cursor)) return true;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  return false;
}

async function pruneBrokenUnavailablePaperclipSkillSymlinks(
  skillsHome: string,
  allowedSkillNames: Iterable<string>,
  onLog: AdapterExecutionContext["onLog"],
) {
  const allowed = new Set(Array.from(allowedSkillNames));
  const entries = await fs.readdir(skillsHome, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    if (allowed.has(entry.name) || !entry.isSymbolicLink()) continue;

    const target = path.join(skillsHome, entry.name);
    const linkedPath = await fs.readlink(target).catch(() => null);
    if (!linkedPath) continue;

    const resolvedLinkedPath = path.resolve(path.dirname(target), linkedPath);
    if (await pathExists(resolvedLinkedPath)) continue;
    if (
      !(await isLikelyPaperclipRuntimeSkillPath(resolvedLinkedPath, entry.name, {
        requireSkillMarkdown: false,
      }))
    ) {
      continue;
    }

    await fs.unlink(target).catch(() => {});
    await onLog(
      "stdout",
      `[paperclip] Removed stale Codex skill "${entry.name}" from ${skillsHome}\n`,
    );
  }
}

function resolveCodexSkillsDir(codexHome: string): string {
  return path.join(codexHome, "skills");
}

type EnsureCodexSkillsInjectedOptions = {
  skillsHome?: string;
  skillsEntries?: Array<{ key: string; runtimeName: string; source: string }>;
  desiredSkillNames?: string[];
  linkSkill?: (source: string, target: string) => Promise<void>;
};

export async function ensureCodexSkillsInjected(
  onLog: AdapterExecutionContext["onLog"],
  options: EnsureCodexSkillsInjectedOptions = {},
) {
  const allSkillsEntries = options.skillsEntries ?? await readPaperclipRuntimeSkillEntries({}, __moduleDir);
  const desiredSkillNames =
    options.desiredSkillNames ?? allSkillsEntries.map((entry) => entry.key);
  const desiredSet = new Set(desiredSkillNames);
  const skillsEntries = allSkillsEntries.filter((entry) => desiredSet.has(entry.key));
  if (skillsEntries.length === 0) return;

  const skillsHome = options.skillsHome ?? resolveCodexSkillsDir(resolveSharedCodexHomeDir());
  await fs.mkdir(skillsHome, { recursive: true });
  const linkSkill = options.linkSkill;
  for (const entry of skillsEntries) {
    const target = path.join(skillsHome, entry.runtimeName);

    try {
      const existing = await fs.lstat(target).catch(() => null);
      if (existing?.isSymbolicLink()) {
        const linkedPath = await fs.readlink(target).catch(() => null);
        const resolvedLinkedPath = linkedPath
          ? path.resolve(path.dirname(target), linkedPath)
          : null;
        if (
          resolvedLinkedPath &&
          resolvedLinkedPath !== entry.source &&
          (await isLikelyPaperclipRuntimeSkillPath(resolvedLinkedPath, entry.runtimeName))
        ) {
          await fs.unlink(target);
          if (linkSkill) {
            await linkSkill(entry.source, target);
          } else {
            await fs.symlink(entry.source, target);
          }
          await onLog(
            "stdout",
            `[paperclip] Repaired Codex skill "${entry.runtimeName}" into ${skillsHome}\n`,
          );
          continue;
        }
      }

      const result = await ensurePaperclipSkillSymlink(entry.source, target, linkSkill);
      if (result === "skipped") continue;

      await onLog(
        "stdout",
        `[paperclip] ${result === "repaired" ? "Repaired" : "Injected"} Codex skill "${entry.runtimeName}" into ${skillsHome}\n`,
      );
    } catch (err) {
      await onLog(
        "stderr",
        `[paperclip] Failed to inject Codex skill "${entry.key}" into ${skillsHome}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  await pruneBrokenUnavailablePaperclipSkillSymlinks(
    skillsHome,
    skillsEntries.map((entry) => entry.runtimeName),
    onLog,
  );
}

type CodexTransport = "exec" | "app_server";

type AppServerAttempt = {
  proc: {
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
    stdout: string;
    stderr: string;
  };
  rawStderr: string;
  parsed: ReturnType<typeof parseCodexJsonl>;
  question: AdapterExecutionResult["question"];
  sessionParams: Record<string, unknown> | null;
  sessionDisplayId: string | null;
  clearSession: boolean;
};

function resolveCodexTransport(): CodexTransport {
  const raw = process.env.PAPERCLIP_CODEX_LOCAL_TRANSPORT?.trim().toLowerCase();
  return raw === "exec" ? "exec" : "app_server";
}

function readExtraArgs(config: Record<string, unknown>): string[] {
  const direct = Array.isArray(config.extraArgs) ? config.extraArgs : Array.isArray(config.args) ? config.args : [];
  return direct.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function buildCodexAppServerArgs(config: Record<string, unknown>) {
  const execPreview = buildCodexExecArgs(config);
  const extraArgs = readExtraArgs(config);
  const args: string[] = ["app-server"];
  if (extraArgs.length > 0) args.push(...extraArgs);
  return {
    args,
    fastModeApplied: execPreview.fastModeApplied,
    fastModeIgnoredReason: execPreview.fastModeIgnoredReason,
  };
}

function buildAppServerThreadConfig(
  config: Record<string, unknown>,
  options: { fastModeApplied: boolean },
) {
  const threadConfig: Record<string, unknown> = {};
  const search = config.search === true;
  threadConfig.web_search = search ? "live" : "disabled";
  if (options.fastModeApplied) {
    threadConfig.features = {
      fast_mode: true,
    };
  }
  return threadConfig;
}

function resolveAppServerSandboxPolicy(bypass: boolean): string | null {
  if (!bypass) return null;
  return "danger-full-access";
}

function resolveAppServerApprovalPolicy(bypass: boolean): string | null {
  return bypass ? "never" : null;
}

function resolveAppServerServiceTier(fastModeApplied: boolean): string | null {
  return fastModeApplied ? "fast" : null;
}

function buildInitializeCapabilities(planningMode: boolean) {
  if (!planningMode) return null;
  return {
    experimentalApi: true,
  };
}

function buildCollaborationMode(config: Record<string, unknown>, planningMode: boolean) {
  if (!planningMode) return null;
  const model = asString(config.model, "").trim() || DEFAULT_CODEX_LOCAL_MODEL;
  const configuredEffort = asString(
    config.modelReasoningEffort,
    asString(config.reasoningEffort, ""),
  ).trim();
  return {
    mode: "plan",
    settings: {
      model,
      reasoning_effort: configuredEffort || null,
      developer_instructions: null,
    },
  };
}

function isExperimentalPlanningCapabilityError(message: string) {
  const normalized = message.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.includes("turn/start.collaborationmode requires experimentalapi capability")) {
    return true;
  }
  const mentionsExperimentalApi =
    normalized.includes("experimentalapi") ||
    normalized.includes("experimental api");
  const mentionsPlanningNegotiation =
    normalized.includes("collaborationmode") ||
    normalized.includes("capabilit") ||
    normalized.includes("initialize");
  return mentionsExperimentalApi && mentionsPlanningNegotiation;
}

function normalizePlanningCapabilityError(message: string, planningMode: boolean) {
  const trimmed = message.trim();
  if (!planningMode || !isExperimentalPlanningCapabilityError(trimmed)) {
    return trimmed;
  }
  return [
    "Paperclip requested native Codex Plan mode, but codex app-server rejected experimental capability negotiation.",
    trimmed,
    "Paperclip does not downgrade planning runs automatically.",
    "Use PAPERCLIP_CODEX_LOCAL_TRANSPORT=exec as a temporary workaround while this app-server path is unavailable.",
  ].join(" ");
}

function extractDecisionQuestionAnswer(context: Record<string, unknown>) {
  const wake = parseObject(context.paperclipWake);
  const wakeReason =
    readNonEmptyString(wake.reason) ??
    readNonEmptyString(context.wakeReason);
  const answerSource =
    parseObject(wake.decisionQuestion).answer ??
    parseObject(context.decisionQuestionAnswer);
  const answer = parseObject(answerSource);
  if (wakeReason !== "decision_question_answered" || Object.keys(answer).length === 0) {
    return null;
  }
  return {
    selectedOptionKey: readNonEmptyString(answer.selectedOptionKey),
    answer: readNonEmptyString(answer.answer),
    note: readNonEmptyString(answer.note),
  };
}

function shouldPauseForPendingQuestionWithoutAnswer(
  wakeReason: string | null,
  pendingUserInput: PendingUserInputState | null,
  answeredQuestion: { selectedOptionKey: string | null; answer: string | null; note: string | null } | null,
) {
  return Boolean(
    pendingUserInput &&
    (!answeredQuestion || wakeReason !== "decision_question_answered"),
  );
}

function capturePendingUserInput(
  requestId: string,
  params: Record<string, unknown>,
): PendingUserInputState | null {
  const threadId = readNonEmptyString(params.threadId);
  const turnId = readNonEmptyString(params.turnId);
  const itemId = readNonEmptyString(params.itemId);
  if (!threadId || !turnId || !itemId) return null;
  const questions = normalizePendingUserInputQuestions(params.questions);
  if (questions.length === 0) return null;
  return {
    requestId,
    threadId,
    turnId,
    itemId,
    questions,
  };
}

function pendingUserInputMatches(
  pending: PendingUserInputState,
  params: Record<string, unknown>,
) {
  const threadId = readNonEmptyString(params.threadId);
  const turnId = readNonEmptyString(params.turnId);
  const itemId = readNonEmptyString(params.itemId);
  if (threadId && threadId !== pending.threadId) return false;
  if (turnId && turnId !== pending.turnId) return false;
  if (itemId && itemId !== pending.itemId) return false;
  return true;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;

  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.",
  );
  const command = asString(config.command, "codex");
  const model = asString(config.model, "");

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceStrategy = asString(workspaceContext.strategy, "");
  const workspaceId = asString(workspaceContext.workspaceId, "");
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");
  const workspaceBranch = asString(workspaceContext.branchName, "");
  const workspaceWorktreePath = asString(workspaceContext.worktreePath, "");
  const agentHome = asString(workspaceContext.agentHome, "");
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const runtimeServiceIntents = Array.isArray(context.paperclipRuntimeServiceIntents)
    ? context.paperclipRuntimeServiceIntents.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const runtimeServices = Array.isArray(context.paperclipRuntimeServices)
    ? context.paperclipRuntimeServices.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const runtimePrimaryUrl = asString(context.paperclipRuntimePrimaryUrl, "");
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  const envConfig = parseObject(config.env);
  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  const executionTargetIsRemote = adapterExecutionTargetIsRemote(executionTarget);
  const configuredCodexHome =
    typeof envConfig.CODEX_HOME === "string" && envConfig.CODEX_HOME.trim().length > 0
      ? path.resolve(envConfig.CODEX_HOME.trim())
      : null;
  const codexSkillEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkillNames = resolveCodexDesiredSkillNames(config, codexSkillEntries);
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
  const preparedManagedCodexHome =
    configuredCodexHome ? null : await prepareManagedCodexHome(process.env, onLog, agent.companyId);
  const defaultCodexHome = resolveManagedCodexHomeDir(process.env, agent.companyId);
  const effectiveCodexHome = configuredCodexHome ?? preparedManagedCodexHome ?? defaultCodexHome;
  await fs.mkdir(effectiveCodexHome, { recursive: true });
  // Inject skills into the same CODEX_HOME that Codex will actually run with
  // (managed home in the default case, or an explicit override from adapter config).
  const codexSkillsDir = resolveCodexSkillsDir(effectiveCodexHome);
  await ensureCodexSkillsInjected(
    onLog,
    {
      skillsHome: codexSkillsDir,
      skillsEntries: codexSkillEntries,
      desiredSkillNames,
    },
  );
  const effectiveExecutionCwd = adapterExecutionTargetRemoteCwd(executionTarget, cwd);
  const preparedExecutionTargetRuntime = executionTargetIsRemote
    ? await (async () => {
        await onLog(
          "stdout",
          `[paperclip] Syncing workspace and CODEX_HOME to ${describeAdapterExecutionTarget(executionTarget)}.\n`,
        );
        return await prepareAdapterExecutionTargetRuntime({
          target: executionTarget,
          adapterKey: "codex",
          workspaceLocalDir: cwd,
          assets: [
            {
              key: "home",
              localDir: effectiveCodexHome,
              followSymlinks: true,
            },
          ],
        });
      })()
    : null;
  const restoreRemoteWorkspace = preparedExecutionTargetRuntime
    ? () => preparedExecutionTargetRuntime.restoreWorkspace()
    : null;
  const remoteCodexHome = executionTargetIsRemote
    ? preparedExecutionTargetRuntime?.assetDirs.home ??
      path.posix.join(effectiveExecutionCwd, ".paperclip-runtime", "codex", "home")
    : null;
  const hasExplicitApiKey =
    typeof envConfig.PAPERCLIP_API_KEY === "string" && envConfig.PAPERCLIP_API_KEY.trim().length > 0;
  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  const localExecutionPolicy =
    parseLocalExecutionPolicy(config.localExecutionPolicy, { defaultPreset: "permissive" }) ??
    permissiveLocalExecutionPolicy();
  env.PAPERCLIP_RUN_ID = runId;
  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim().length > 0 && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim().length > 0 && context.issueId.trim()) ||
    null;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim().length > 0
      ? context.wakeReason.trim()
      : null;
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim().length > 0 && context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim().length > 0 && context.commentId.trim()) ||
    null;
  const approvalId =
    typeof context.approvalId === "string" && context.approvalId.trim().length > 0
      ? context.approvalId.trim()
      : null;
  const approvalStatus =
    typeof context.approvalStatus === "string" && context.approvalStatus.trim().length > 0
      ? context.approvalStatus.trim()
      : null;
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake);
  const wakeMode = normalizePaperclipWakePayload(context.paperclipWake)?.mode ?? null;
  if (wakeTaskId) {
    env.PAPERCLIP_TASK_ID = wakeTaskId;
  }
  if (wakeReason) {
    env.PAPERCLIP_WAKE_REASON = wakeReason;
  }
  if (wakeCommentId) {
    env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  }
  if (approvalId) {
    env.PAPERCLIP_APPROVAL_ID = approvalId;
  }
  if (approvalStatus) {
    env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  }
  if (linkedIssueIds.length > 0) {
    env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  }
  if (wakeMode) {
    env.PAPERCLIP_CONTINUITY_MODE = wakeMode;
  }
  if (wakePayloadJson) {
    env.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;
  }
  if (effectiveWorkspaceCwd) {
    env.PAPERCLIP_WORKSPACE_CWD = effectiveWorkspaceCwd;
  }
  if (workspaceSource) {
    env.PAPERCLIP_WORKSPACE_SOURCE = workspaceSource;
  }
  if (workspaceStrategy) {
    env.PAPERCLIP_WORKSPACE_STRATEGY = workspaceStrategy;
  }
  if (workspaceId) {
    env.PAPERCLIP_WORKSPACE_ID = workspaceId;
  }
  if (workspaceRepoUrl) {
    env.PAPERCLIP_WORKSPACE_REPO_URL = workspaceRepoUrl;
  }
  if (workspaceRepoRef) {
    env.PAPERCLIP_WORKSPACE_REPO_REF = workspaceRepoRef;
  }
  if (workspaceBranch) {
    env.PAPERCLIP_WORKSPACE_BRANCH = workspaceBranch;
  }
  if (workspaceWorktreePath) {
    env.PAPERCLIP_WORKSPACE_WORKTREE_PATH = workspaceWorktreePath;
  }
  if (agentHome) {
    env.AGENT_HOME = agentHome;
  }
  if (workspaceHints.length > 0) {
    env.PAPERCLIP_WORKSPACES_JSON = JSON.stringify(workspaceHints);
  }
  if (runtimeServiceIntents.length > 0) {
    env.PAPERCLIP_RUNTIME_SERVICE_INTENTS_JSON = JSON.stringify(runtimeServiceIntents);
  }
  if (runtimeServices.length > 0) {
    env.PAPERCLIP_RUNTIME_SERVICES_JSON = JSON.stringify(runtimeServices);
  }
  if (runtimePrimaryUrl) {
    env.PAPERCLIP_RUNTIME_PRIMARY_URL = runtimePrimaryUrl;
  }
  const targetPaperclipApiUrl = adapterExecutionTargetPaperclipApiUrl(executionTarget);
  if (targetPaperclipApiUrl) {
    env.PAPERCLIP_API_URL = targetPaperclipApiUrl;
  }
  for (const [k, v] of Object.entries(envConfig)) {
    if (typeof v === "string") env[k] = v;
  }
  env.CODEX_HOME = remoteCodexHome ?? effectiveCodexHome;
  if (!hasExplicitApiKey && authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }
  const effectiveEnv = Object.fromEntries(
    Object.entries({ ...process.env, ...env }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const billingType = resolveCodexBillingType(effectiveEnv);
  const runtimeEnv = ensurePathInEnv(effectiveEnv);
  await ensureAdapterExecutionTargetCommandResolvable(command, executionTarget, cwd, runtimeEnv);
  const resolvedCommand = await resolveAdapterExecutionTargetCommandForLogs(command, executionTarget, cwd, runtimeEnv);
  const loggedEnv = buildInvocationEnvForLogs(env, {
    runtimeEnv,
    includeRuntimeKeys: ["HOME"],
    resolvedCommand,
  });

  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 20);

  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(
    runtimeSessionParams.threadId,
    asString(runtimeSessionParams.sessionId, runtime.sessionId ?? ""),
  );
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
  const runtimeRemoteExecution = parseObject(runtimeSessionParams.remoteExecution);
  const codexTransientFallbackMode = asString(context.codexTransientFallbackMode, "");
  const forceFreshSessionForTransientFallback = codexTransientFallbackMode.includes("fresh_session");
  const forceSaferTransientInvocation = codexTransientFallbackMode.includes("safer_invocation");
  const canResumeSession =
    runtimeSessionId.length > 0 &&
    (executionTargetIsRemote
      ? adapterExecutionTargetSessionMatches(runtimeRemoteExecution, executionTarget) &&
        (runtimeSessionCwd.length === 0 || runtimeSessionCwd === effectiveExecutionCwd)
      : runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(cwd));
  const sessionId = canResumeSession && !forceFreshSessionForTransientFallback ? runtimeSessionId : null;
  const pendingUserInput = parsePendingUserInput(runtimeSessionParams.pendingUserInput);
  const answeredDecisionQuestion = extractDecisionQuestionAnswer(context);
  if (runtimeSessionId && forceFreshSessionForTransientFallback) {
    await onLog(
      "stdout",
      `[paperclip] Codex transient fallback requested a fresh session instead of resuming "${runtimeSessionId}".\n`,
    );
  } else if (runtimeSessionId && !canResumeSession) {
    await onLog(
      "stdout",
      executionTargetIsRemote
        ? `[paperclip] Codex session "${runtimeSessionId}" does not match the current remote execution identity and will not be resumed in "${effectiveExecutionCwd}". Starting a fresh remote session.\n`
        : `[paperclip] Codex session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${effectiveExecutionCwd}".\n`,
    );
  }
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const instructionsDir = instructionsFilePath ? `${path.dirname(instructionsFilePath)}/` : "";
  let instructionsPrefix = "";
  let instructionsChars = 0;
  if (instructionsFilePath) {
    try {
      const instructionsContents = await fs.readFile(instructionsFilePath, "utf8");
      instructionsPrefix =
        `${instructionsContents}\n\n` +
        `The above agent instructions were loaded from ${instructionsFilePath}. ` +
        `Resolve any relative file references from ${instructionsDir}.\n\n`;
      instructionsChars = instructionsPrefix.length;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await onLog(
        "stdout",
        `[paperclip] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`,
      );
    }
  }
  const repoAgentsNote =
    "Codex automatically applies repo-scoped AGENTS.md instructions from the current workspace; Paperclip does not currently suppress that discovery.";
  const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const renderedBootstrapPrompt =
    !sessionId && bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, { resumedSession: Boolean(sessionId) });
  const shouldUseResumeDeltaPrompt = Boolean(sessionId) && wakePrompt.length > 0;
  const promptInstructionsPrefix = shouldUseResumeDeltaPrompt ? "" : instructionsPrefix;
  instructionsChars = promptInstructionsPrefix.length;
  const commandNotes = (() => {
    if (!instructionsFilePath) {
      return [repoAgentsNote];
    }
    if (instructionsPrefix.length > 0) {
      if (shouldUseResumeDeltaPrompt) {
        return [
          `Loaded agent instructions from ${instructionsFilePath}`,
          "Skipped stdin instruction reinjection because an existing Codex session is being resumed with a wake delta.",
          repoAgentsNote,
        ];
      }
      return [
        `Loaded agent instructions from ${instructionsFilePath}`,
        `Prepended instructions + path directive to stdin prompt (relative references from ${instructionsDir}).`,
        repoAgentsNote,
      ];
    }
    return [
      `Configured instructionsFilePath ${instructionsFilePath}, but file could not be read; continuing without injected instructions.`,
      repoAgentsNote,
    ];
  })();
  const renderedPrompt = shouldUseResumeDeltaPrompt ? "" : renderTemplate(promptTemplate, templateData);
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const continuationSummary = parseObject(context.paperclipContinuationSummary);
  const transientFallbackHandoffNote =
    forceFreshSessionForTransientFallback && asString(continuationSummary.body, "").trim().length > 0
      ? `Paperclip session handoff:\n\n${asString(continuationSummary.body, "").trim()}`
      : "";
  const projectContextNote = renderPaperclipProjectContext(context);
  const prompt = joinPromptSections([
    promptInstructionsPrefix,
    renderedBootstrapPrompt,
    wakePrompt,
    projectContextNote,
    sessionHandoffNote,
    transientFallbackHandoffNote,
    renderedPrompt,
  ]);
  const promptMetrics = {
    promptChars: prompt.length,
    instructionsChars,
    bootstrapPromptChars: renderedBootstrapPrompt.length,
    wakePromptChars: wakePrompt.length,
    projectContextChars: projectContextNote.length,
    sessionHandoffChars: sessionHandoffNote.length + transientFallbackHandoffNote.length,
    heartbeatPromptChars: renderedPrompt.length,
  };

  const transport = executionTargetIsRemote ? "exec" : resolveCodexTransport();
  if (executionTargetIsRemote && resolveCodexTransport() !== "exec") {
    await onLog(
      "stdout",
      "[paperclip] Codex SSH execution uses exec transport; app-server transport is host-local only.\n",
    );
  }

  const buildSessionParams = (
    threadId: string | null,
    nextPendingUserInput: PendingUserInputState | null = null,
  ) => threadId
    ? ({
      threadId,
      sessionId: threadId,
      cwd: effectiveExecutionCwd,
      ...(executionTargetIsRemote
        ? { remoteExecution: adapterExecutionTargetSessionIdentity(executionTarget) }
        : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
      ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
      ...(nextPendingUserInput ? { pendingUserInput: nextPendingUserInput } : {}),
    } as Record<string, unknown>)
    : null;

  if (transport === "app_server" && shouldPauseForPendingQuestionWithoutAnswer(wakeReason, pendingUserInput, answeredDecisionQuestion)) {
    await onLog(
      "stdout",
      `[paperclip] Codex thread "${runtimeSessionId}" is waiting on a board answer; preserving the pending question without starting a new turn.\n`,
    );
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      sessionId: runtimeSessionId || null,
      sessionParams: buildSessionParams(runtimeSessionId || null, pendingUserInput),
      sessionDisplayId: runtimeSessionId || null,
      provider: "openai",
      biller: resolveCodexBiller(effectiveEnv, billingType),
      model,
      billingType,
      costUsd: null,
      resultJson: {
        stdout: "",
        stderr: "",
      },
      summary: "",
      clearSession: false,
    };
  }

  const runExecAttempt = async (resumeSessionId: string | null) => {
    const execConfig = forceSaferTransientInvocation
      ? {
          ...config,
          fastMode: false,
        }
      : config;
    const execArgs = buildCodexExecArgs(execConfig, { resumeSessionId });
    const args = execArgs.args;
    const transientNotes = [
      ...(forceSaferTransientInvocation
        ? ["Codex transient fallback requested safer invocation settings for this retry."]
        : []),
      ...(forceFreshSessionForTransientFallback
        ? ["Codex transient fallback forced a fresh session with a continuation handoff."]
        : []),
    ];
    const commandNotesWithFastMode =
      execArgs.fastModeIgnoredReason == null
        ? [...commandNotes, ...transientNotes]
        : [...commandNotes, execArgs.fastModeIgnoredReason, ...transientNotes];
    if (onMeta) {
      await onMeta({
        adapterType: "codex_local",
        command: resolvedCommand,
        cwd: effectiveExecutionCwd,
        commandNotes: commandNotesWithFastMode,
        commandArgs: args.map((value, idx) => {
          if (idx === args.length - 1 && value !== "-") return `<prompt ${prompt.length} chars>`;
          return value;
        }),
        env: loggedEnv,
        prompt,
        promptMetrics,
        context,
      });
    }

    const proc = await runAdapterExecutionTargetProcess(runId, executionTarget, command, args, {
      cwd,
      env,
      stdin: prompt,
      timeoutSec,
      graceSec,
      onSpawn,
      localExecutionPolicy,
      declaredEnvKeys: Object.keys(envConfig),
      onLog: async (stream, chunk) => {
        if (stream !== "stderr") {
          await onLog(stream, chunk);
          return;
        }
        const cleaned = stripCodexRolloutNoise(chunk);
        if (!cleaned.trim()) return;
        await onLog(stream, cleaned);
      },
    });
    const cleanedStderr = stripCodexRolloutNoise(proc.stderr);
    const parsed = parseCodexJsonl(proc.stdout);
    const resolvedSessionId = parsed.sessionId ?? runtimeSessionId ?? runtime.sessionId ?? null;
    return {
      proc: {
        ...proc,
        stderr: cleanedStderr,
      },
      rawStderr: proc.stderr,
      parsed,
      question: null,
      sessionParams: buildSessionParams(resolvedSessionId),
      sessionDisplayId: resolvedSessionId,
      clearSession: false,
    } satisfies AppServerAttempt;
  };

  const runAppServerAttempt = async (resumeThreadId: string | null): Promise<AppServerAttempt> => {
    const configRecord = parseObject(config);
    const bypass = configRecord.dangerouslyBypassApprovalsAndSandbox === true || configRecord.dangerouslyBypassSandbox === true;
    const appServerArgs = buildCodexAppServerArgs(configRecord);
    const threadConfig = buildAppServerThreadConfig(configRecord, {
      fastModeApplied: appServerArgs.fastModeApplied,
    });
    const approvalPolicy = resolveAppServerApprovalPolicy(bypass);
    const sandboxPolicy = resolveAppServerSandboxPolicy(bypass);
    const serviceTier = resolveAppServerServiceTier(appServerArgs.fastModeApplied);
    const effort = asString(configRecord.modelReasoningEffort, asString(configRecord.reasoningEffort, "")).trim();
    const planningMode = context.paperclipPlanningMode === true;
    const initializeCapabilities = buildInitializeCapabilities(planningMode);
    const collaborationMode = buildCollaborationMode(
      configRecord,
      initializeCapabilities?.experimentalApi === true,
    );
    const commandNotesWithFastMode =
      appServerArgs.fastModeIgnoredReason == null
        ? commandNotes
        : [...commandNotes, appServerArgs.fastModeIgnoredReason];
    const shouldResumePendingAnswer = Boolean(
      resumeThreadId &&
      pendingUserInput &&
      answeredDecisionQuestion &&
      wakeReason === "decision_question_answered",
    );
    const appServerPrompt = shouldResumePendingAnswer ? "" : prompt;
    const appServerPromptMetrics = shouldResumePendingAnswer
      ? {
        promptChars: 0,
        instructionsChars: 0,
        bootstrapPromptChars: 0,
        wakePromptChars: 0,
        projectContextChars: 0,
        sessionHandoffChars: 0,
        heartbeatPromptChars: 0,
      }
      : promptMetrics;

    if (onMeta) {
      await onMeta({
        adapterType: "codex_local",
        command: resolvedCommand,
        cwd,
        commandNotes: commandNotesWithFastMode,
        commandArgs: appServerArgs.args,
        env: loggedEnv,
        prompt: appServerPrompt,
        promptMetrics: appServerPromptMetrics,
        context,
      });
    }

    const stdoutLines: string[] = [];
    const usageByTurn = new Map<string, { input_tokens: number; cached_input_tokens: number; output_tokens: number }>();
    let rawStderr = "";
    let cleanedStderr = "";
    let threadId = resumeThreadId;
    let exitCode: number | null = 0;
    let signal: string | null = null;
    let timedOut = false;
    let capturedQuestion: AdapterExecutionResult["question"] = null;
    let nextPendingUserInput = shouldResumePendingAnswer ? null : pendingUserInput;
    let loggedThreadStarted = false;
    let settled = false;
    let resolveOutcome!: (value: "completed" | "question") => void;
    const outcomePromise = new Promise<"completed" | "question">((resolve) => {
      resolveOutcome = resolve;
    });
    const settle = (value: "completed" | "question") => {
      if (settled) return;
      settled = true;
      resolveOutcome(value);
    };
    const appendError = async (message: string) => {
      const trimmed = message.trim();
      if (!trimmed) return;
      rawStderr += rawStderr.endsWith("\n") || rawStderr.length === 0 ? `${trimmed}\n` : `\n${trimmed}\n`;
      cleanedStderr += cleanedStderr.endsWith("\n") || cleanedStderr.length === 0 ? `${trimmed}\n` : `\n${trimmed}\n`;
      await onLog("stderr", `${trimmed}\n`);
      const errorLine = JSON.stringify({
        type: "error",
        message: trimmed,
      });
      stdoutLines.push(errorLine);
      await onLog("stdout", `${errorLine}\n`);
    };

    const client = new CodexAppServerClient({
      command,
      args: appServerArgs.args,
      cwd,
      env,
      onSpawn,
      onStderr: async (chunk) => {
        rawStderr += chunk;
        const cleaned = stripCodexRolloutNoise(chunk);
        cleanedStderr += cleaned;
        if (cleaned.trim().length > 0) {
          await onLog("stderr", cleaned);
        }
      },
      onNotification: async (method, params) => {
        if (method === "error") {
          const error = parseObject(params.error);
          const message = readNonEmptyString(error.message);
          if (message) {
            error.message = normalizePlanningCapabilityError(message, planningMode);
          }
        }
        const normalized = normalizeAppServerNotification({ method, params, usageByTurn });
        if (method === "thread/started") {
          const thread = parseObject(params.thread);
          threadId = readNonEmptyString(thread.id) ?? threadId;
          loggedThreadStarted = Boolean(threadId);
        }
        if (method === "error") {
          const error = parseObject(params.error);
          const message = readNonEmptyString(error.message);
          if (message) {
            exitCode = 1;
          }
          settle("completed");
        }
        if (method === "turn/completed") {
          const turn = parseObject(params.turn);
          if (asString(turn.status, "").trim().toLowerCase() === "failed") {
            exitCode = 1;
          }
        }
        if (normalized?.line) {
          stdoutLines.push(normalized.line);
          await onLog("stdout", `${normalized.line}\n`);
        }
        if (method === "turn/completed") {
          settle("completed");
        }
      },
      onRequest: async (method, id, params) => {
        if (method !== "item/tool/requestUserInput") {
          return null;
        }

        const livePending = capturePendingUserInput(String(id), params);
        if (!livePending) {
          return null;
        }

        const debugLine = JSON.stringify({
          type: "item.requested_user_input",
          request_id: String(id),
          thread_id: livePending.threadId,
          turn_id: livePending.turnId,
          item_id: livePending.itemId,
          questions: livePending.questions,
        });
        stdoutLines.push(debugLine);
        await onLog("stdout", `${debugLine}\n`);

        if (answeredDecisionQuestion && (!pendingUserInput || pendingUserInputMatches(pendingUserInput, params))) {
          nextPendingUserInput = null;
          return buildPendingUserInputResponse({
            questions: livePending.questions,
            selectedOptionKey: answeredDecisionQuestion.selectedOptionKey,
            answer: answeredDecisionQuestion.answer,
            note: answeredDecisionQuestion.note,
          });
        }

        nextPendingUserInput = livePending;
        capturedQuestion = buildDecisionQuestionCapture(livePending.questions);
        settle("question");
        return NO_RESPONSE;
      },
    });

    const timeoutTimer = timeoutSec > 0
      ? setTimeout(() => {
        timedOut = true;
        exitCode = null;
        settle("completed");
      }, timeoutSec * 1000)
      : null;

    try {
      await client.initialize(
        initializeCapabilities ? { capabilities: initializeCapabilities } : undefined,
      );

      if (resumeThreadId) {
        const resumeResponse = await client.request("thread/resume", {
          threadId: resumeThreadId,
          cwd,
          ...(approvalPolicy ? { approvalPolicy } : {}),
          ...(sandboxPolicy ? { sandbox: sandboxPolicy } : {}),
          ...(serviceTier ? { serviceTier } : {}),
          ...(Object.keys(threadConfig).length > 0 ? { config: threadConfig } : {}),
          ...(model ? { model } : {}),
        });
        const thread = parseObject(parseObject(resumeResponse.result).thread);
        threadId = readNonEmptyString(thread.id) ?? threadId;
      } else {
        const startResponse = await client.request("thread/start", {
          ...(model ? { model } : {}),
          cwd,
          ...(approvalPolicy ? { approvalPolicy } : {}),
          ...(sandboxPolicy ? { sandbox: sandboxPolicy } : {}),
          ...(serviceTier ? { serviceTier } : {}),
          ...(Object.keys(threadConfig).length > 0 ? { config: threadConfig } : {}),
          experimentalRawEvents: false,
        });
        const thread = parseObject(parseObject(startResponse.result).thread);
        threadId = readNonEmptyString(thread.id) ?? threadId;
      }

      if (threadId && !loggedThreadStarted) {
        const threadStartedLine = JSON.stringify({
          type: "thread.started",
          thread_id: threadId,
        });
        stdoutLines.push(threadStartedLine);
        await onLog("stdout", `${threadStartedLine}\n`);
        loggedThreadStarted = true;
      }

      if (!threadId) {
        throw new Error("Codex app-server did not return a thread id");
      }

      if (!shouldResumePendingAnswer) {
        const turnResponse = await client.request("turn/start", {
          threadId,
          input: [{ type: "text", text: prompt }],
          cwd,
          ...(approvalPolicy ? { approvalPolicy } : {}),
          ...(sandboxPolicy ? { sandbox: sandboxPolicy } : {}),
          ...(serviceTier ? { serviceTier } : {}),
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
          ...(collaborationMode ? { collaborationMode } : {}),
        });
        const turn = parseObject(parseObject(turnResponse.result).turn);
        if (asString(turn.status, "") === "failed") {
          exitCode = 1;
          settle("completed");
        }
      }

      await outcomePromise;
    } catch (error) {
      if (!timedOut) {
        exitCode = 1;
        await appendError(
          normalizePlanningCapabilityError(
            error instanceof Error ? error.message : String(error),
            planningMode,
          ),
        );
      }
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (timedOut) signal = "SIGTERM";
      await client.shutdown({ graceMs: graceSec * 1000 });
    }

    const stdout = stdoutLines.join("\n");
    return {
      proc: {
        exitCode: timedOut ? null : exitCode,
        signal,
        timedOut,
        stdout,
        stderr: cleanedStderr,
      },
      rawStderr,
      parsed: parseCodexJsonl(stdout),
      question: capturedQuestion,
      sessionParams: buildSessionParams(threadId ?? runtimeSessionId ?? runtime.sessionId ?? null, nextPendingUserInput),
      sessionDisplayId: threadId ?? runtimeSessionId ?? runtime.sessionId ?? null,
      clearSession: false,
    };
  };

  const toResult = (
    attempt: AppServerAttempt,
    clearSessionOnMissingSession = false,
  ): AdapterExecutionResult => {
    if (attempt.proc.timedOut) {
      return {
        exitCode: attempt.proc.exitCode,
        signal: attempt.proc.signal,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
        clearSession: clearSessionOnMissingSession,
      };
    }

    const resolvedSessionId =
      attempt.sessionDisplayId ??
      attempt.parsed.sessionId ??
      runtimeSessionId ??
      runtime.sessionId ??
      null;
    const resolvedSessionParams = attempt.sessionParams ?? buildSessionParams(resolvedSessionId);

    const parsedError = typeof attempt.parsed.errorMessage === "string" ? attempt.parsed.errorMessage.trim() : "";
    const stderrLine = firstNonEmptyLine(attempt.proc.stderr);
    const fallbackErrorMessage =
      parsedError ||
      stderrLine ||
      `Codex exited with code ${attempt.proc.exitCode ?? -1}`;
    const transientRetryNotBefore =
      (attempt.proc.exitCode ?? 0) !== 0
        ? extractCodexRetryNotBefore({
            stdout: attempt.proc.stdout,
            stderr: attempt.proc.stderr,
            errorMessage: fallbackErrorMessage,
          })
        : null;
    const transientUpstream =
      (attempt.proc.exitCode ?? 0) !== 0 &&
      isCodexTransientUpstreamError({
        stdout: attempt.proc.stdout,
        stderr: attempt.proc.stderr,
        errorMessage: fallbackErrorMessage,
      });

    return {
      exitCode: attempt.proc.exitCode,
      signal: attempt.proc.signal,
      timedOut: false,
      errorMessage:
        (attempt.proc.exitCode ?? 0) === 0
          ? null
          : fallbackErrorMessage,
      errorCode:
        transientUpstream
          ? "codex_transient_upstream"
          : null,
      errorFamily: transientUpstream ? "transient_upstream" : null,
      retryNotBefore: transientRetryNotBefore ? transientRetryNotBefore.toISOString() : null,
      usage: attempt.parsed.usage,
      sessionId: resolvedSessionId,
      sessionParams: resolvedSessionParams,
      sessionDisplayId: resolvedSessionId,
      provider: "openai",
      biller: resolveCodexBiller(effectiveEnv, billingType),
      model,
      billingType,
      costUsd: null,
      resultJson: {
        stdout: attempt.proc.stdout,
        stderr: attempt.proc.stderr,
        ...(transientUpstream ? { errorFamily: "transient_upstream" } : {}),
        ...(transientRetryNotBefore ? { retryNotBefore: transientRetryNotBefore.toISOString() } : {}),
        ...(transientRetryNotBefore ? { transientRetryNotBefore: transientRetryNotBefore.toISOString() } : {}),
      },
      summary: attempt.parsed.summary,
      clearSession: attempt.clearSession || Boolean(clearSessionOnMissingSession && !resolvedSessionId),
      question: attempt.question ?? null,
    };
  };

  const runAttempt = async (resumeSessionId: string | null) =>
    transport === "exec"
      ? runExecAttempt(resumeSessionId)
      : runAppServerAttempt(resumeSessionId);

  try {
    const initial = await runAttempt(sessionId);
    if (
      sessionId &&
      !initial.proc.timedOut &&
      (initial.proc.exitCode ?? 0) !== 0 &&
      isCodexUnknownSessionError(initial.proc.stdout, initial.rawStderr)
    ) {
      await onLog(
        "stdout",
        `[paperclip] Codex resume session "${sessionId}" is unavailable; retrying with a fresh session.\n`,
      );
      const retry = await runAttempt(null);
      return toResult({
        ...retry,
        clearSession: true,
      });
    }

    return toResult(initial);
  } finally {
    if (restoreRemoteWorkspace) {
      await onLog(
        "stdout",
        `[paperclip] Restoring workspace changes from ${describeAdapterExecutionTarget(executionTarget)}.\n`,
      );
      await restoreRemoteWorkspace();
    }
  }
}
