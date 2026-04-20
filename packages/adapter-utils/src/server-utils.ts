import { spawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants, promises as fs, type Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AdapterSkillEntry,
  AdapterSkillSnapshot,
} from "./types.js";

export interface RunProcessResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  pid: number | null;
  startedAt: string | null;
}

interface RunningProcess {
  child: ChildProcess;
  graceSec: number;
  processGroupId: number | null;
}

interface SpawnTarget {
  command: string;
  args: string[];
}

type ChildProcessWithEvents = ChildProcess & {
  on(event: "error", listener: (err: Error) => void): ChildProcess;
  on(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): ChildProcess;
};

function resolveProcessGroupId(child: ChildProcess) {
  if (process.platform === "win32") return null;
  return typeof child.pid === "number" && child.pid > 0 ? child.pid : null;
}

function signalRunningProcess(
  running: Pick<RunningProcess, "child" | "processGroupId">,
  signal: NodeJS.Signals,
) {
  if (process.platform !== "win32" && running.processGroupId && running.processGroupId > 0) {
    try {
      process.kill(-running.processGroupId, signal);
      return;
    } catch {
      // Fall back to the direct child signal if group signaling fails.
    }
  }
  if (!running.child.killed) {
    running.child.kill(signal);
  }
}

export const runningProcesses = new Map<string, RunningProcess>();
export const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
export const MAX_EXCERPT_BYTES = 32 * 1024;
const SENSITIVE_ENV_KEY = /(key|token|secret|password|passwd|authorization|cookie)/i;
const PAPERCLIP_SKILL_ROOT_RELATIVE_CANDIDATES = [
  "../../skills",
  "../../../../../skills",
];
const DEFAULT_PAPERCLIP_INSTANCE_ID = "default";

export interface PaperclipSkillEntry {
  key: string;
  runtimeName: string;
  source: string;
  required?: boolean;
  requiredReason?: string | null;
}

export interface InstalledSkillTarget {
  targetPath: string | null;
  kind: "symlink" | "directory" | "file";
}

interface PersistentSkillSnapshotOptions {
  adapterType: string;
  availableEntries: PaperclipSkillEntry[];
  desiredSkills: string[];
  installed: Map<string, InstalledSkillTarget>;
  diagnosticInstalled?: Map<string, InstalledSkillTarget>;
  skillsHome: string;
  locationLabel?: string | null;
  installedDetail?: string | null;
  missingDetail: string;
  externalConflictDetail: string;
  externalDetail: string;
  diagnosticLocationLabel?: string | null;
  diagnosticExternalDetail?: string | null;
  warnings?: string[];
}

interface ManagedHomeSubtree {
  relativePath: string;
  excludeChildren?: string[];
}

interface PrepareManagedAdapterHomeOptions {
  env?: NodeJS.ProcessEnv;
  adapterKey: string;
  companyId?: string;
  sharedHomeDir?: string | null;
  logLabel: string;
  subtrees: ManagedHomeSubtree[];
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}

function normalizePathSlashes(value: string): string {
  return value.replaceAll("\\", "/");
}

function isMaintainerOnlySkillTarget(candidate: string): boolean {
  return normalizePathSlashes(candidate).includes("/.agents/skills/");
}

function skillLocationLabel(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildManagedSkillOrigin(entry: { required?: boolean }): Pick<
  AdapterSkillEntry,
  "origin" | "originLabel" | "readOnly"
> {
  if (entry.required) {
    return {
      origin: "paperclip_required",
      originLabel: "Required by Paperclip",
      readOnly: false,
    };
  }
  return {
    origin: "company_managed",
    originLabel: "Managed by Paperclip",
    readOnly: false,
  };
}

function nonEmptyString(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeRelativePath(value: string): string {
  return value
    .replaceAll("\\", "/")
    .replace(/^\/+|\/+$/g, "");
}

function hasNestedExclude(excludes: Set<string>, relativePath: string): boolean {
  const prefix = `${relativePath}/`;
  for (const value of excludes) {
    if (value.startsWith(prefix)) return true;
  }
  return false;
}

async function ensureDirectoryAt(targetDir: string): Promise<void> {
  const existing = await fs.lstat(targetDir).catch(() => null);
  if (existing?.isDirectory()) return;
  if (existing) {
    await fs.rm(targetDir, { recursive: true, force: true });
  }
  await fs.mkdir(targetDir, { recursive: true });
}

async function ensureSymlinkTarget(target: string, source: string): Promise<void> {
  const existing = await fs.lstat(target).catch(() => null);
  if (!existing) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.symlink(source, target);
    return;
  }

  if (existing.isSymbolicLink()) {
    const linkedPath = await fs.readlink(target).catch(() => null);
    if (!linkedPath) return;
    const resolvedLinkedPath = path.resolve(path.dirname(target), linkedPath);
    if (resolvedLinkedPath === source) return;
    await fs.unlink(target);
    await fs.symlink(source, target);
    return;
  }
}

async function mirrorManagedHomeSubtree(
  sourceRoot: string,
  targetRoot: string,
  excludes: Set<string>,
  relativePath = "",
): Promise<void> {
  const entries = await fs.readdir(sourceRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const nextRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    if (excludes.has(nextRelativePath)) {
      continue;
    }

    const sourcePath = path.join(sourceRoot, entry.name);
    const targetPath = path.join(targetRoot, entry.name);
    if (entry.isDirectory() && hasNestedExclude(excludes, nextRelativePath)) {
      await ensureDirectoryAt(targetPath);
      await mirrorManagedHomeSubtree(sourcePath, targetPath, excludes, nextRelativePath);
      continue;
    }

    await ensureSymlinkTarget(targetPath, sourcePath);
  }
}

export function resolveSharedLocalAdapterHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(nonEmptyString(env.HOME) ?? os.homedir());
}

export function resolveManagedLocalAdapterHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  adapterKey: string,
  companyId?: string,
): string {
  const paperclipHome = nonEmptyString(env.PAPERCLIP_HOME) ?? path.resolve(os.homedir(), ".paperclip");
  const instanceId = nonEmptyString(env.PAPERCLIP_INSTANCE_ID) ?? DEFAULT_PAPERCLIP_INSTANCE_ID;
  return companyId
    ? path.resolve(paperclipHome, "instances", instanceId, "companies", companyId, `${adapterKey}-home`)
    : path.resolve(paperclipHome, "instances", instanceId, `${adapterKey}-home`);
}

export async function prepareManagedAdapterHome(
  options: PrepareManagedAdapterHomeOptions,
): Promise<string> {
  const env = options.env ?? process.env;
  const sourceHome = path.resolve(options.sharedHomeDir ?? resolveSharedLocalAdapterHomeDir(env));
  const targetHome = resolveManagedLocalAdapterHomeDir(env, options.adapterKey, options.companyId);
  if (path.resolve(sourceHome) === path.resolve(targetHome)) {
    return targetHome;
  }

  await fs.mkdir(targetHome, { recursive: true });
  for (const subtree of options.subtrees) {
    const normalizedRelativePath = normalizeRelativePath(subtree.relativePath);
    if (!normalizedRelativePath) continue;
    const sourceRoot = path.join(sourceHome, normalizedRelativePath);
    const sourceExists = await fs.access(sourceRoot).then(() => true).catch(() => false);
    if (!sourceExists) continue;

    const targetRoot = path.join(targetHome, normalizedRelativePath);
    await ensureDirectoryAt(targetRoot);
    const excludes = new Set(
      (subtree.excludeChildren ?? [])
        .map((value) => normalizeRelativePath(value))
        .filter(Boolean),
    );
    await mirrorManagedHomeSubtree(sourceRoot, targetRoot, excludes);
  }

  if (options.onLog) {
    await options.onLog(
      "stdout",
      `[paperclip] Using Paperclip-managed ${options.logLabel} home "${targetHome}" (seeded from "${sourceHome}").\n`,
    );
  }

  return targetHome;
}

function resolveInstalledEntryTarget(
  skillsHome: string,
  entryName: string,
  dirent: Dirent,
  linkedPath: string | null,
): InstalledSkillTarget {
  const fullPath = path.join(skillsHome, entryName);
  if (dirent.isSymbolicLink()) {
    return {
      targetPath: linkedPath ? path.resolve(path.dirname(fullPath), linkedPath) : null,
      kind: "symlink",
    };
  }
  if (dirent.isDirectory()) {
    return { targetPath: fullPath, kind: "directory" };
  }
  return { targetPath: fullPath, kind: "file" };
}

export function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

export function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

export function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function parseJson(value: string): Record<string, unknown> | null {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function appendWithCap(prev: string, chunk: string, cap = MAX_CAPTURE_BYTES) {
  const combined = prev + chunk;
  return combined.length > cap ? combined.slice(combined.length - cap) : combined;
}

export function appendWithByteCap(prev: string, chunk: string, cap = MAX_CAPTURE_BYTES) {
  const combined = prev + chunk;
  const bytes = Buffer.byteLength(combined, "utf8");
  if (bytes <= cap) return combined;

  const buffer = Buffer.from(combined, "utf8");
  let start = Math.max(0, bytes - cap);
  while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) {
    start += 1;
  }
  return buffer.subarray(start).toString("utf8");
}

function resumeReadable(readable: { resume: () => unknown; destroyed?: boolean } | null | undefined) {
  if (!readable || readable.destroyed) return;
  readable.resume();
}

export function resolvePathValue(obj: Record<string, unknown>, dottedPath: string) {
  const parts = dottedPath.split(".");
  let cursor: unknown = obj;

  for (const part of parts) {
    if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) {
      return "";
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }

  if (cursor === null || cursor === undefined) return "";
  if (typeof cursor === "string") return cursor;
  if (typeof cursor === "number" || typeof cursor === "boolean") return String(cursor);

  try {
    return JSON.stringify(cursor);
  } catch {
    return "";
  }
}

export function renderTemplate(template: string, data: Record<string, unknown>) {
  return template.replace(/{{\s*([a-zA-Z0-9_.-]+)\s*}}/g, (_, path) => resolvePathValue(data, path));
}

export function joinPromptSections(
  sections: Array<string | null | undefined>,
  separator = "\n\n",
) {
  return sections
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean)
    .join(separator);
}

export function renderPaperclipProjectContext(context: Record<string, unknown> | null | undefined) {
  if (!context || typeof context !== "object" || Array.isArray(context)) return "";
  const projectContextRaw = context.paperclipProjectContext;
  if (typeof projectContextRaw !== "object" || projectContextRaw === null || Array.isArray(projectContextRaw)) {
    return "";
  }
  const projectContext = projectContextRaw as Record<string, unknown>;
  const body =
    typeof projectContext.body === "string"
      ? projectContext.body.trim()
      : "";
  if (!body.length) return "";
  const projectName =
    typeof projectContext.projectName === "string"
      ? projectContext.projectName.trim()
      : "";
  const title = projectName.length ? `${projectName} PROJECT_CONTEXT.md` : "PROJECT_CONTEXT.md";
  return [`# ${title}`, body].join("\n\n");
}

type PaperclipWakeIssue = {
  id: string | null;
  identifier: string | null;
  title: string | null;
  status: string | null;
  priority: string | null;
};

type PaperclipWakeExecutionPrincipal = {
  type: "agent" | "user" | null;
  agentId: string | null;
  userId: string | null;
};

type PaperclipWakeExecutionStage = {
  wakeRole: "reviewer" | "approver" | "executor" | null;
  stageId: string | null;
  stageType: string | null;
  currentParticipant: PaperclipWakeExecutionPrincipal | null;
  returnAssignee: PaperclipWakeExecutionPrincipal | null;
  lastDecisionOutcome: string | null;
  allowedActions: string[];
};

type PaperclipWakeComment = {
  id: string | null;
  issueId: string | null;
  body: string;
  bodyTruncated: boolean;
  createdAt: string | null;
  authorType: string | null;
  authorId: string | null;
};

type PaperclipWakeConferenceRoomIssue = {
  id: string | null;
  identifier: string | null;
  title: string | null;
};

type PaperclipWakeConferenceRoom = {
  id: string | null;
  title: string | null;
  kind: string | null;
  status: string | null;
  linkedIssues: PaperclipWakeConferenceRoomIssue[];
};

type PaperclipWakeConferenceRoomMessage = {
  id: string | null;
  parentCommentId: string | null;
  messageType: string | null;
  body: string;
  createdAt: string | null;
  authorType: string | null;
  authorId: string | null;
};

type PaperclipWakeConferenceRoomPendingResponse = {
  agentId: string | null;
  agentName: string | null;
  status: string | null;
  repliedCommentId: string | null;
};

type PaperclipWakeDecisionOption = {
  key: string;
  label: string;
  description?: string;
};

type PaperclipWakeDecisionAnswer = {
  answer: string;
  selectedOptionKey: string | null;
  note: string | null;
};

type PaperclipWakeDecisionQuestion = {
  id: string | null;
  status: string | null;
  blocking: boolean;
  title: string | null;
  question: string | null;
  whyBlocked: string | null;
  suggestedDefault: string | null;
  linkedApprovalId: string | null;
  recommendedOptions: PaperclipWakeDecisionOption[];
  answer: PaperclipWakeDecisionAnswer | null;
};

type PaperclipWakePlanApproval = {
  approvalId: string | null;
  status: string | null;
  currentPlanRevisionId: string | null;
  requestedPlanRevisionId: string | null;
  approvedPlanRevisionId: string | null;
  decisionNote: string | null;
  currentRevisionApproved: boolean;
  requiresApproval: boolean;
  requiresResubmission: boolean;
  lastRequestedAt: string | null;
  lastDecidedAt: string | null;
};

type PaperclipWakePayload = {
  reason: string | null;
  issue: PaperclipWakeIssue | null;
  planningMode: boolean;
  continuityStatus: string | null;
  openDecisionQuestionCount: number;
  blockingDecisionQuestionCount: number;
  decisionQuestion: PaperclipWakeDecisionQuestion | null;
  planApproval: PaperclipWakePlanApproval | null;
  checkedOutByHarness: boolean;
  executionStage: PaperclipWakeExecutionStage | null;
  commentIds: string[];
  latestCommentId: string | null;
  comments: PaperclipWakeComment[];
  requestedCount: number;
  includedCount: number;
  missingCount: number;
  truncated: boolean;
  fallbackFetchNeeded: boolean;
  conferenceRoom: PaperclipWakeConferenceRoom | null;
  conferenceRoomMessage: PaperclipWakeConferenceRoomMessage | null;
  conferenceRoomThread: PaperclipWakeConferenceRoomMessage[];
  conferenceRoomPendingResponses: PaperclipWakeConferenceRoomPendingResponse[];
};

function normalizePaperclipWakeIssue(value: unknown): PaperclipWakeIssue | null {
  const issue = parseObject(value);
  const id = asString(issue.id, "").trim() || null;
  const identifier = asString(issue.identifier, "").trim() || null;
  const title = asString(issue.title, "").trim() || null;
  const status = asString(issue.status, "").trim() || null;
  const priority = asString(issue.priority, "").trim() || null;
  if (!id && !identifier && !title) return null;
  return {
    id,
    identifier,
    title,
    status,
    priority,
  };
}

function normalizePaperclipWakeComment(value: unknown): PaperclipWakeComment | null {
  const comment = parseObject(value);
  const author = parseObject(comment.author);
  const body = asString(comment.body, "");
  if (!body.trim()) return null;
  return {
    id: asString(comment.id, "").trim() || null,
    issueId: asString(comment.issueId, "").trim() || null,
    body,
    bodyTruncated: asBoolean(comment.bodyTruncated, false),
    createdAt: asString(comment.createdAt, "").trim() || null,
    authorType: asString(author.type, "").trim() || null,
    authorId: asString(author.id, "").trim() || null,
  };
}

function normalizePaperclipWakeConferenceRoomIssue(value: unknown): PaperclipWakeConferenceRoomIssue | null {
  const issue = parseObject(value);
  const id = asString(issue.id, "").trim() || null;
  const identifier = asString(issue.identifier, "").trim() || null;
  const title = asString(issue.title, "").trim() || null;
  if (!id && !identifier && !title) return null;
  return { id, identifier, title };
}

function normalizePaperclipWakeConferenceRoom(value: unknown): PaperclipWakeConferenceRoom | null {
  const room = parseObject(value);
  const linkedIssues = Array.isArray(room.linkedIssues)
    ? room.linkedIssues
        .map((entry) => normalizePaperclipWakeConferenceRoomIssue(entry))
        .filter((entry): entry is PaperclipWakeConferenceRoomIssue => Boolean(entry))
    : [];
  const id = asString(room.id, "").trim() || null;
  const title = asString(room.title, "").trim() || null;
  const kind = asString(room.kind, "").trim() || null;
  const status = asString(room.status, "").trim() || null;
  if (!id && !title) return null;
  return { id, title, kind, status, linkedIssues };
}

function normalizePaperclipWakeConferenceRoomMessage(value: unknown): PaperclipWakeConferenceRoomMessage | null {
  const message = parseObject(value);
  const author = parseObject(message.author);
  const body = asString(message.body, "");
  if (!body.trim()) return null;
  return {
    id: asString(message.id, "").trim() || null,
    parentCommentId: asString(message.parentCommentId, "").trim() || null,
    messageType: asString(message.messageType, "").trim() || null,
    body,
    createdAt: asString(message.createdAt, "").trim() || null,
    authorType: asString(author.type, "").trim() || null,
    authorId: asString(author.id, "").trim() || null,
  };
}

function normalizePaperclipWakeConferenceRoomPendingResponse(
  value: unknown,
): PaperclipWakeConferenceRoomPendingResponse | null {
  const response = parseObject(value);
  const agent = parseObject(response.agent);
  const agentId = asString(agent.id, "").trim() || null;
  const agentName = asString(agent.name, "").trim() || null;
  const status = asString(response.status, "").trim() || null;
  const repliedCommentId = asString(response.repliedCommentId, "").trim() || null;
  if (!agentId && !agentName && !status) return null;
  return {
    agentId,
    agentName,
    status,
    repliedCommentId,
  };
}

function normalizePaperclipWakeDecisionQuestion(value: unknown): PaperclipWakeDecisionQuestion | null {
  const question = parseObject(value);
  const answer = parseObject(question.answer);
  const recommendedOptions = Array.isArray(question.recommendedOptions)
    ? question.recommendedOptions
        .map((entry) => {
          const option = parseObject(entry);
          const key = asString(option.key, "").trim();
          const label = asString(option.label, "").trim();
          const description = asString(option.description, "").trim();
          if (!key || !label) return null;
          return {
            key,
            label,
            ...(description ? { description } : {}),
          };
        })
        .filter((entry): entry is PaperclipWakeDecisionOption => Boolean(entry))
    : [];
  const normalizedAnswer =
    Object.keys(answer).length === 0 && !asString(question.answer, "").trim()
      ? null
      : {
          answer: asString(answer.answer, asString(question.answer, "")).trim(),
          selectedOptionKey: asString(answer.selectedOptionKey, "").trim() || null,
          note: asString(answer.note, "").trim() || null,
        };
  const id = asString(question.id, "").trim() || null;
  const status = asString(question.status, "").trim() || null;
  const title = asString(question.title, "").trim() || null;
  const prompt = asString(question.question, "").trim() || null;
  if (!id && !status && !title && !prompt && !normalizedAnswer) return null;
  return {
    id,
    status,
    blocking: asBoolean(question.blocking, false),
    title,
    question: prompt,
    whyBlocked: asString(question.whyBlocked, "").trim() || null,
    suggestedDefault: asString(question.suggestedDefault, "").trim() || null,
    linkedApprovalId: asString(question.linkedApprovalId, "").trim() || null,
    recommendedOptions,
    answer: normalizedAnswer && normalizedAnswer.answer
      ? normalizedAnswer
      : normalizedAnswer?.selectedOptionKey || normalizedAnswer?.note
        ? normalizedAnswer
        : null,
  };
}

function normalizePaperclipWakePlanApproval(value: unknown): PaperclipWakePlanApproval | null {
  const approval = parseObject(value);
  const approvalId = asString(approval.approvalId, "").trim() || null;
  const status = asString(approval.status, "").trim() || null;
  const currentPlanRevisionId = asString(approval.currentPlanRevisionId, "").trim() || null;
  const requestedPlanRevisionId = asString(approval.requestedPlanRevisionId, "").trim() || null;
  const approvedPlanRevisionId = asString(approval.approvedPlanRevisionId, "").trim() || null;
  const decisionNote = asString(approval.decisionNote, "").trim() || null;
  const lastRequestedAt = asString(approval.lastRequestedAt, "").trim() || null;
  const lastDecidedAt = asString(approval.lastDecidedAt, "").trim() || null;

  if (
    !approvalId &&
    !status &&
    !currentPlanRevisionId &&
    !requestedPlanRevisionId &&
    !approvedPlanRevisionId &&
    !decisionNote
  ) {
    return null;
  }

  return {
    approvalId,
    status,
    currentPlanRevisionId,
    requestedPlanRevisionId,
    approvedPlanRevisionId,
    decisionNote,
    currentRevisionApproved: asBoolean(approval.currentRevisionApproved, false),
    requiresApproval: asBoolean(approval.requiresApproval, false),
    requiresResubmission: asBoolean(approval.requiresResubmission, false),
    lastRequestedAt,
    lastDecidedAt,
  };
}

function normalizePaperclipWakeExecutionPrincipal(value: unknown): PaperclipWakeExecutionPrincipal | null {
  const principal = parseObject(value);
  const typeRaw = asString(principal.type, "").trim().toLowerCase();
  if (typeRaw !== "agent" && typeRaw !== "user") return null;
  return {
    type: typeRaw,
    agentId: asString(principal.agentId, "").trim() || null,
    userId: asString(principal.userId, "").trim() || null,
  };
}

function normalizePaperclipWakeExecutionStage(value: unknown): PaperclipWakeExecutionStage | null {
  const stage = parseObject(value);
  const wakeRoleRaw = asString(stage.wakeRole, "").trim().toLowerCase();
  const wakeRole =
    wakeRoleRaw === "reviewer" || wakeRoleRaw === "approver" || wakeRoleRaw === "executor"
      ? wakeRoleRaw
      : null;
  const allowedActions = Array.isArray(stage.allowedActions)
    ? stage.allowedActions
        .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        .map((entry) => entry.trim())
    : [];
  const currentParticipant = normalizePaperclipWakeExecutionPrincipal(stage.currentParticipant);
  const returnAssignee = normalizePaperclipWakeExecutionPrincipal(stage.returnAssignee);
  const stageId = asString(stage.stageId, "").trim() || null;
  const stageType = asString(stage.stageType, "").trim() || null;
  const lastDecisionOutcome = asString(stage.lastDecisionOutcome, "").trim() || null;

  if (!wakeRole && !stageId && !stageType && !currentParticipant && !returnAssignee && !lastDecisionOutcome && allowedActions.length === 0) {
    return null;
  }

  return {
    wakeRole,
    stageId,
    stageType,
    currentParticipant,
    returnAssignee,
    lastDecisionOutcome,
    allowedActions,
  };
}

export function normalizePaperclipWakePayload(value: unknown): PaperclipWakePayload | null {
  const payload = parseObject(value);
  const comments = Array.isArray(payload.comments)
    ? payload.comments
        .map((entry) => normalizePaperclipWakeComment(entry))
        .filter((entry): entry is PaperclipWakeComment => Boolean(entry))
    : [];
  const commentWindow = parseObject(payload.commentWindow);
  const commentIds = Array.isArray(payload.commentIds)
    ? payload.commentIds
        .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        .map((entry) => entry.trim())
    : [];
  const executionStage = normalizePaperclipWakeExecutionStage(payload.executionStage);
  const conferenceRoom = normalizePaperclipWakeConferenceRoom(payload.conferenceRoom);
  const conferenceRoomMessage = normalizePaperclipWakeConferenceRoomMessage(payload.conferenceRoomMessage);
  const conferenceRoomThread = Array.isArray(payload.conferenceRoomThread)
    ? payload.conferenceRoomThread
        .map((entry) => normalizePaperclipWakeConferenceRoomMessage(entry))
        .filter((entry): entry is PaperclipWakeConferenceRoomMessage => Boolean(entry))
    : [];
  const conferenceRoomPendingResponses = Array.isArray(payload.conferenceRoomPendingResponses)
    ? payload.conferenceRoomPendingResponses
        .map((entry) => normalizePaperclipWakeConferenceRoomPendingResponse(entry))
        .filter((entry): entry is PaperclipWakeConferenceRoomPendingResponse => Boolean(entry))
    : [];

  if (
    comments.length === 0 &&
    commentIds.length === 0 &&
    !executionStage &&
    !normalizePaperclipWakeIssue(payload.issue) &&
    !conferenceRoom &&
    !conferenceRoomMessage &&
    conferenceRoomThread.length === 0
  ) {
    return null;
  }

  return {
    reason: asString(payload.reason, "").trim() || null,
    issue: normalizePaperclipWakeIssue(payload.issue),
    planningMode: asBoolean(payload.planningMode, false),
    continuityStatus: asString(payload.continuityStatus, "").trim() || null,
    openDecisionQuestionCount: asNumber(payload.openDecisionQuestionCount, 0),
    blockingDecisionQuestionCount: asNumber(payload.blockingDecisionQuestionCount, 0),
    decisionQuestion: normalizePaperclipWakeDecisionQuestion(payload.decisionQuestion),
    planApproval: normalizePaperclipWakePlanApproval(payload.planApproval),
    checkedOutByHarness: asBoolean(payload.checkedOutByHarness, false),
    executionStage,
    commentIds,
    latestCommentId: asString(payload.latestCommentId, "").trim() || null,
    comments,
    requestedCount: asNumber(commentWindow.requestedCount, comments.length || commentIds.length),
    includedCount: asNumber(commentWindow.includedCount, comments.length),
    missingCount: asNumber(commentWindow.missingCount, 0),
    truncated: asBoolean(payload.truncated, false),
    fallbackFetchNeeded: asBoolean(payload.fallbackFetchNeeded, false),
    conferenceRoom,
    conferenceRoomMessage,
    conferenceRoomThread,
    conferenceRoomPendingResponses,
  };
}

export function stringifyPaperclipWakePayload(value: unknown): string | null {
  const normalized = normalizePaperclipWakePayload(value);
  if (!normalized) return null;
  return JSON.stringify(normalized);
}

export function renderPaperclipWakePrompt(
  value: unknown,
  options: { resumedSession?: boolean } = {},
): string {
  const normalized = normalizePaperclipWakePayload(value);
  if (!normalized) return "";
  const resumedSession = options.resumedSession === true;
  const executionStage = normalized.executionStage;
  const principalLabel = (principal: PaperclipWakeExecutionPrincipal | null) => {
    if (!principal || !principal.type) return "unknown";
    if (principal.type === "agent") return principal.agentId ? `agent ${principal.agentId}` : "agent";
    return principal.userId ? `user ${principal.userId}` : "user";
  };

  if (normalized.conferenceRoom) {
    const room = normalized.conferenceRoom;
    const thread = normalized.conferenceRoomThread;
    const triggerMessage = normalized.conferenceRoomMessage;
    const lines = resumedSession
      ? [
          "## Paperclip Resume Delta",
          "",
          "You are resuming an existing Paperclip session.",
          "This heartbeat is scoped to the conference room below. Handle this room wake before returning to generic inbox work.",
          "Use the inline room payload first before refetching the room thread.",
          "",
          `- reason: ${normalized.reason ?? "unknown"}`,
          `- conference room: ${room.title ?? room.id ?? "unknown"} (${room.id ?? "unknown"})`,
          `- linked issues: ${room.linkedIssues.length}`,
          `- trigger message: ${triggerMessage?.id ?? "none"}`,
          `- pending room responses: ${normalized.conferenceRoomPendingResponses.filter((entry) => entry.status === "pending").length}`,
        ]
      : [
          "## Paperclip Wake Payload",
          "",
          "Treat this wake payload as the highest-priority change for the current heartbeat.",
          "This heartbeat is scoped to the conference room below. Handle this room wake before returning to generic inbox work.",
          "For room questions, reply in the conference room thread instead of forcing issue checkout first.",
          "Use the inline room payload first before refetching the room thread.",
          "",
          `- reason: ${normalized.reason ?? "unknown"}`,
          `- conference room: ${room.title ?? room.id ?? "unknown"} (${room.id ?? "unknown"})`,
          `- linked issues: ${room.linkedIssues.length}`,
          `- trigger message: ${triggerMessage?.id ?? "none"}`,
          `- pending room responses: ${normalized.conferenceRoomPendingResponses.filter((entry) => entry.status === "pending").length}`,
        ];

    if (room.kind) {
      lines.push(`- room kind: ${room.kind}`);
    }
    if (room.status) {
      lines.push(`- room status: ${room.status}`);
    }
    if (room.linkedIssues.length > 0) {
      lines.push(
        "- linked issues:",
        ...room.linkedIssues.map((issue, index) =>
          `  ${index + 1}. ${issue.identifier ?? issue.id ?? "unknown"}${issue.title ? ` ${issue.title}` : ""}`),
      );
    }

    lines.push("");
    if (normalized.reason === "conference_room_question") {
      lines.push(
        "An invited board question is awaiting your in-thread response.",
        "Post your reply back into the conference room thread after you have the needed context.",
      );
    } else if (normalized.reason === "conference_room_message") {
      lines.push(
        "Another invited agent posted a new top-level room message.",
        "Read it, decide whether you need to respond in-thread, and keep the room conversation moving.",
      );
    } else if (normalized.reason === "conference_room_invite") {
      lines.push(
        "You were invited into this conference room.",
        "Read the room context before deciding whether a reply is needed.",
      );
    }

    if (triggerMessage) {
      const authorLabel = triggerMessage.authorId
        ? `${triggerMessage.authorType ?? "unknown"} ${triggerMessage.authorId}`
        : triggerMessage.authorType ?? "unknown";
      lines.push(
        "",
        "Triggering room message:",
        `- id: ${triggerMessage.id ?? "unknown"}`,
        `- type: ${triggerMessage.messageType ?? "note"}`,
        `- author: ${authorLabel}`,
        `- created at: ${triggerMessage.createdAt ?? "unknown"}`,
        triggerMessage.body,
      );
    }

    if (thread.length > 0) {
      lines.push("", "Conference room thread context:");
      for (const [index, message] of thread.entries()) {
        const authorLabel = message.authorId
          ? `${message.authorType ?? "unknown"} ${message.authorId}`
          : message.authorType ?? "unknown";
        lines.push(
          `${index + 1}. message ${message.id ?? "unknown"} (${message.messageType ?? "note"}) at ${message.createdAt ?? "unknown"} by ${authorLabel}`,
          message.body,
        );
      }
    }

    if (normalized.conferenceRoomPendingResponses.length > 0) {
      lines.push("", "Room response state:");
      for (const response of normalized.conferenceRoomPendingResponses) {
        lines.push(
          `- ${response.agentName ?? response.agentId ?? "unknown"}: ${response.status ?? "unknown"}${response.repliedCommentId ? ` (reply ${response.repliedCommentId})` : ""}`,
        );
      }
    }

    return lines.join("\n");
  }

  const lines = resumedSession
      ? [
        "## Paperclip Resume Delta",
        "",
        "You are resuming an existing Paperclip session.",
        "This heartbeat is scoped to the issue below. Do not switch to another issue until you have handled this wake.",
        "Focus on the new wake delta below and continue the current task without restating the full heartbeat boilerplate.",
        "Fetch the API thread only when `fallbackFetchNeeded` is true or you need broader history than this batch.",
        "",
        `- reason: ${normalized.reason ?? "unknown"}`,
        `- issue: ${normalized.issue?.identifier ?? normalized.issue?.id ?? "unknown"}${normalized.issue?.title ? ` ${normalized.issue.title}` : ""}`,
        `- pending comments: ${normalized.includedCount}/${normalized.requestedCount}`,
        `- latest comment id: ${normalized.latestCommentId ?? "unknown"}`,
        `- fallback fetch needed: ${normalized.fallbackFetchNeeded ? "yes" : "no"}`,
      ]
    : [
        "## Paperclip Wake Payload",
        "",
        "Treat this wake payload as the highest-priority change for the current heartbeat.",
        "This heartbeat is scoped to the issue below. Do not switch to another issue until you have handled this wake.",
        "Before generic repo exploration or boilerplate heartbeat updates, acknowledge the latest comment and explain how it changes your next action.",
        "Use this inline wake data first before refetching the issue thread.",
        "Only fetch the API thread when `fallbackFetchNeeded` is true or you need broader history than this batch.",
        "",
        `- reason: ${normalized.reason ?? "unknown"}`,
        `- issue: ${normalized.issue?.identifier ?? normalized.issue?.id ?? "unknown"}${normalized.issue?.title ? ` ${normalized.issue.title}` : ""}`,
        `- pending comments: ${normalized.includedCount}/${normalized.requestedCount}`,
        `- latest comment id: ${normalized.latestCommentId ?? "unknown"}`,
        `- fallback fetch needed: ${normalized.fallbackFetchNeeded ? "yes" : "no"}`,
      ];

  if (normalized.issue?.status) {
    lines.push(`- issue status: ${normalized.issue.status}`);
  }
  if (normalized.issue?.priority) {
      lines.push(`- issue priority: ${normalized.issue.priority}`);
  }
  if (normalized.continuityStatus) {
    lines.push(`- continuity status: ${normalized.continuityStatus}`);
  }
  if (normalized.planningMode) {
    lines.push("- planning mode: yes");
  }
  if (normalized.openDecisionQuestionCount > 0 || normalized.blockingDecisionQuestionCount > 0) {
    lines.push(
      `- open decision questions: ${normalized.openDecisionQuestionCount}`,
      `- blocking decision questions: ${normalized.blockingDecisionQuestionCount}`,
    );
  }
  if (normalized.checkedOutByHarness) {
    lines.push("- checkout: already claimed by the harness for this run");
  }
  if (normalized.missingCount > 0) {
    lines.push(`- omitted comments: ${normalized.missingCount}`);
  }

  if (normalized.checkedOutByHarness) {
    lines.push(
      "",
      "The harness already checked out this issue for the current run.",
      "Do not call the checkout endpoint again unless you intentionally switch away and later need to reclaim the issue.",
    );
  }

  if (normalized.decisionQuestion) {
    const question = normalized.decisionQuestion;
    lines.push(
      "",
      "Decision question context:",
      `- title: ${question.title ?? "untitled"}`,
      `- status: ${question.status ?? "unknown"}`,
      `- blocking: ${question.blocking ? "yes" : "no"}`,
    );
    if (question.question) {
      lines.push(`- question: ${question.question}`);
    }
    if (question.whyBlocked) {
      lines.push(`- why blocked: ${question.whyBlocked}`);
    }
    if (question.recommendedOptions.length > 0) {
      lines.push(
        "- recommended options:",
        ...question.recommendedOptions.map((option) =>
          `  - ${option.key}: ${option.label}${option.description ? ` — ${option.description}` : ""}`),
      );
    }
    if (question.suggestedDefault) {
      lines.push(`- suggested default: ${question.suggestedDefault}`);
    }
    if (question.answer) {
      lines.push(
        `- board answer: ${question.answer.answer || "provided"}`,
        `- selected option: ${question.answer.selectedOptionKey ?? "none"}`,
      );
      if (question.answer.note) {
        lines.push(`- answer note: ${question.answer.note}`);
      }
    }
    if (question.linkedApprovalId) {
      lines.push(`- linked approval: ${question.linkedApprovalId}`);
    }

    lines.push("");
    if (normalized.reason === "decision_question_answered") {
      lines.push(
        "The board answered your decision question.",
        "Use the recorded answer as the new source of truth and continue the issue from that decision.",
        "",
      );
    } else if (normalized.reason === "decision_question_dismissed") {
      lines.push(
        "The board dismissed your decision question.",
        "Continue using your best judgment unless another blocker remains.",
        "",
      );
    } else if (normalized.reason === "decision_question_escalated") {
      lines.push(
        "This decision question has been promoted to a formal approval.",
        "Treat the linked approval as the governed decision path before proceeding on any blocked work.",
        "",
      );
    } else if (question.blocking && question.status === "open") {
      lines.push(
        "A blocking decision question is open for this issue.",
        "Do not continue blocked execution work until the board answers or dismisses it.",
        "",
      );
    }
  }

  if (normalized.planApproval) {
    const planApproval = normalized.planApproval;
    lines.push(
      "",
      "Plan approval context:",
      `- approval id: ${planApproval.approvalId ?? "none"}`,
      `- status: ${planApproval.status ?? "none"}`,
      `- current plan revision: ${planApproval.currentPlanRevisionId ?? "none"}`,
      `- requested revision: ${planApproval.requestedPlanRevisionId ?? "none"}`,
      `- approved revision: ${planApproval.approvedPlanRevisionId ?? "none"}`,
      `- current revision approved: ${planApproval.currentRevisionApproved ? "yes" : "no"}`,
    );
    if (planApproval.decisionNote) {
      lines.push(`- board note: ${planApproval.decisionNote}`);
    }
    if (planApproval.lastRequestedAt) {
      lines.push(`- last requested at: ${planApproval.lastRequestedAt}`);
    }
    if (planApproval.lastDecidedAt) {
      lines.push(`- last decided at: ${planApproval.lastDecidedAt}`);
    }

    lines.push("");
    if (normalized.reason === "approval_revision_requested") {
      lines.push(
        "The board requested revisions on your plan approval.",
        "Open the linked issue, inspect the board note, revise the plan document and any supporting planning docs, then resubmit the approval.",
        "",
      );
    } else if (normalized.reason === "approval_resubmitted") {
      lines.push(
        "The plan approval was resubmitted and is pending board review again.",
        "Do not continue execution until the current plan revision is approved.",
        "",
      );
    } else if (normalized.reason === "approval_approved") {
      lines.push(
        "The current plan revision is approved.",
        "Proceed on the linked issue using the approved plan as the source of truth.",
        "",
      );
    } else if (
      normalized.continuityStatus === "awaiting_decision" &&
      (planApproval.status === "pending" || planApproval.status === "revision_requested" || planApproval.requiresApproval)
    ) {
      lines.push(
        "Issue planning is blocked on board plan approval.",
        "Revise and resubmit or wait for board approval before starting execution work.",
        "",
      );
    }
  }

  if (executionStage) {
    lines.push(
      `- execution wake role: ${executionStage.wakeRole ?? "unknown"}`,
      `- execution stage: ${executionStage.stageType ?? "unknown"}`,
      `- execution participant: ${principalLabel(executionStage.currentParticipant)}`,
      `- execution return assignee: ${principalLabel(executionStage.returnAssignee)}`,
      `- last decision outcome: ${executionStage.lastDecisionOutcome ?? "none"}`,
    );
    if (executionStage.allowedActions.length > 0) {
      lines.push(`- allowed actions: ${executionStage.allowedActions.join(", ")}`);
    }
    lines.push("");
    if (executionStage.wakeRole === "reviewer" || executionStage.wakeRole === "approver") {
      lines.push(
        `You are waking as the active ${executionStage.wakeRole} for this issue.`,
        "Do not execute the task itself or continue executor work.",
        "Review the issue and choose one of the allowed actions above.",
        "If you request changes, the workflow routes back to the stored return assignee.",
        "",
      );
    } else if (executionStage.wakeRole === "executor") {
      lines.push(
        "You are waking because changes were requested in the execution workflow.",
        "Address the requested changes on this issue and resubmit when the work is ready.",
        "",
      );
    }
  }

  if (normalized.comments.length > 0) {
    lines.push("New comments in order:");
  }

  for (const [index, comment] of normalized.comments.entries()) {
    const authorLabel = comment.authorId
      ? `${comment.authorType ?? "unknown"} ${comment.authorId}`
      : comment.authorType ?? "unknown";
    lines.push(
      `${index + 1}. comment ${comment.id ?? "unknown"} at ${comment.createdAt ?? "unknown"} by ${authorLabel}`,
      comment.body,
    );
    if (comment.bodyTruncated) {
      lines.push("[comment body truncated]");
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

export function redactEnvForLogs(env: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    redacted[key] = SENSITIVE_ENV_KEY.test(key) ? "***REDACTED***" : value;
  }
  return redacted;
}

export function buildInvocationEnvForLogs(
  env: Record<string, string>,
  options: {
    runtimeEnv?: NodeJS.ProcessEnv | Record<string, string>;
    includeRuntimeKeys?: string[];
    resolvedCommand?: string | null;
    resolvedCommandEnvKey?: string;
  } = {},
): Record<string, string> {
  const merged: Record<string, string> = { ...env };
  const runtimeEnv = options.runtimeEnv ?? {};

  for (const key of options.includeRuntimeKeys ?? []) {
    if (key in merged) continue;
    const value = runtimeEnv[key];
    if (typeof value !== "string" || value.length === 0) continue;
    merged[key] = value;
  }

  const resolvedCommand = options.resolvedCommand?.trim();
  if (resolvedCommand) {
    merged[options.resolvedCommandEnvKey ?? "PAPERCLIP_RESOLVED_COMMAND"] = resolvedCommand;
  }

  return redactEnvForLogs(merged);
}

export function buildPaperclipEnv(agent: { id: string; companyId: string }): Record<string, string> {
  const resolveHostForUrl = (rawHost: string): string => {
    const host = rawHost.trim();
    if (!host || host === "0.0.0.0" || host === "::") return "localhost";
    if (host.includes(":") && !host.startsWith("[") && !host.endsWith("]")) return `[${host}]`;
    return host;
  };
  const vars: Record<string, string> = {
    PAPERCLIP_AGENT_ID: agent.id,
    PAPERCLIP_COMPANY_ID: agent.companyId,
  };
  const runtimeHost = resolveHostForUrl(
    process.env.PAPERCLIP_LISTEN_HOST ?? process.env.HOST ?? "localhost",
  );
  const runtimePort = process.env.PAPERCLIP_LISTEN_PORT ?? process.env.PORT ?? "3100";
  const apiUrl = process.env.PAPERCLIP_API_URL ?? `http://${runtimeHost}:${runtimePort}`;
  vars.PAPERCLIP_API_URL = apiUrl;
  return vars;
}

export function defaultPathForPlatform() {
  if (process.platform === "win32") {
    return "C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem";
  }
  return "/usr/local/bin:/opt/homebrew/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin";
}

function windowsPathExts(env: NodeJS.ProcessEnv): string[] {
  return (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean);
}

async function pathExists(candidate: string) {
  try {
    await fs.access(candidate, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveCommandPath(command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const hasPathSeparator = command.includes("/") || command.includes("\\");
  if (hasPathSeparator) {
    const absolute = path.isAbsolute(command) ? command : path.resolve(cwd, command);
    return (await pathExists(absolute)) ? absolute : null;
  }

  const pathValue = env.PATH ?? env.Path ?? "";
  const delimiter = process.platform === "win32" ? ";" : ":";
  const dirs = pathValue.split(delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? windowsPathExts(env) : [""];
  const hasExtension = process.platform === "win32" && path.extname(command).length > 0;

  for (const dir of dirs) {
    const candidates =
      process.platform === "win32"
        ? hasExtension
          ? [path.join(dir, command)]
          : exts.map((ext) => path.join(dir, `${command}${ext}`))
        : [path.join(dir, command)];
    for (const candidate of candidates) {
      if (await pathExists(candidate)) return candidate;
    }
  }

  return null;
}

export async function resolveCommandForLogs(command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  return (await resolveCommandPath(command, cwd, env)) ?? command;
}

function quoteForCmd(arg: string) {
  if (!arg.length) return '""';
  const escaped = arg.replace(/"/g, '""');
  return /[\s"&<>|^()]/.test(escaped) ? `"${escaped}"` : escaped;
}

function resolveWindowsCmdShell(env: NodeJS.ProcessEnv): string {
  const fallbackRoot = env.SystemRoot || process.env.SystemRoot || "C:\\Windows";
  return path.join(fallbackRoot, "System32", "cmd.exe");
}

async function resolveSpawnTarget(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<SpawnTarget> {
  const resolved = await resolveCommandPath(command, cwd, env);
  const executable = resolved ?? command;

  if (process.platform !== "win32") {
    return { command: executable, args };
  }

  if (/\.(cmd|bat)$/i.test(executable)) {
    // Always use cmd.exe for .cmd/.bat wrappers. Some environments override
    // ComSpec to PowerShell, which breaks cmd-specific flags like /d /s /c.
    const shell = resolveWindowsCmdShell(env);
    const commandLine = [quoteForCmd(executable), ...args.map(quoteForCmd)].join(" ");
    return {
      command: shell,
      args: ["/d", "/s", "/c", commandLine],
    };
  }

  return { command: executable, args };
}

export function ensurePathInEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (typeof env.PATH === "string" && env.PATH.length > 0) return env;
  if (typeof env.Path === "string" && env.Path.length > 0) return env;
  return { ...env, PATH: defaultPathForPlatform() };
}

export async function ensureAbsoluteDirectory(
  cwd: string,
  opts: { createIfMissing?: boolean } = {},
) {
  if (!path.isAbsolute(cwd)) {
    throw new Error(`Working directory must be an absolute path: "${cwd}"`);
  }

  const assertDirectory = async () => {
    const stats = await fs.stat(cwd);
    if (!stats.isDirectory()) {
      throw new Error(`Working directory is not a directory: "${cwd}"`);
    }
  };

  try {
    await assertDirectory();
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (!opts.createIfMissing || code !== "ENOENT") {
      if (code === "ENOENT") {
        throw new Error(`Working directory does not exist: "${cwd}"`);
      }
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  try {
    await fs.mkdir(cwd, { recursive: true });
    await assertDirectory();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not create working directory "${cwd}": ${reason}`);
  }
}

export async function resolvePaperclipSkillsDir(
  moduleDir: string,
  additionalCandidates: string[] = [],
): Promise<string | null> {
  const candidates = [
    ...PAPERCLIP_SKILL_ROOT_RELATIVE_CANDIDATES.map((relativePath) => path.resolve(moduleDir, relativePath)),
    ...additionalCandidates.map((candidate) => path.resolve(candidate)),
  ];
  const seenRoots = new Set<string>();

  for (const root of candidates) {
    if (seenRoots.has(root)) continue;
    seenRoots.add(root);
    const isDirectory = await fs.stat(root).then((stats) => stats.isDirectory()).catch(() => false);
    if (isDirectory) return root;
  }

  return null;
}

export async function listPaperclipSkillEntries(
  moduleDir: string,
  additionalCandidates: string[] = [],
): Promise<PaperclipSkillEntry[]> {
  const root = await resolvePaperclipSkillsDir(moduleDir, additionalCandidates);
  if (!root) return [];

  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        key: `paperclipai/paperclip/${entry.name}`,
        runtimeName: entry.name,
        source: path.join(root, entry.name),
        required: true,
        requiredReason: "Bundled Paperclip skills are always available for local adapters.",
      }));
  } catch {
    return [];
  }
}

export async function readInstalledSkillTargets(skillsHome: string): Promise<Map<string, InstalledSkillTarget>> {
  const entries = await fs.readdir(skillsHome, { withFileTypes: true }).catch(() => []);
  const out = new Map<string, InstalledSkillTarget>();
  for (const entry of entries) {
    const fullPath = path.join(skillsHome, entry.name);
    const linkedPath = entry.isSymbolicLink() ? await fs.readlink(fullPath).catch(() => null) : null;
    out.set(entry.name, resolveInstalledEntryTarget(skillsHome, entry.name, entry, linkedPath));
  }
  return out;
}

export function buildPersistentSkillSnapshot(
  options: PersistentSkillSnapshotOptions,
): AdapterSkillSnapshot {
  const {
    adapterType,
    availableEntries,
    desiredSkills,
    installed,
    skillsHome,
    locationLabel,
    installedDetail,
    missingDetail,
    externalConflictDetail,
    externalDetail,
  } = options;
  const availableByKey = new Map(availableEntries.map((entry) => [entry.key, entry]));
  const desiredSet = new Set(desiredSkills);
  const entries: AdapterSkillEntry[] = [];
  const warnings = [...(options.warnings ?? [])];

  for (const available of availableEntries) {
    const installedEntry = installed.get(available.runtimeName) ?? null;
    const desired = desiredSet.has(available.key);
    let state: AdapterSkillEntry["state"] = "available";
    let managed = false;
    let detail: string | null = null;

    if (installedEntry?.targetPath === available.source) {
      managed = true;
      state = desired ? "installed" : "stale";
      detail = installedDetail ?? null;
    } else if (installedEntry) {
      state = "blocked";
      detail = desired ? externalConflictDetail : externalDetail;
    } else if (desired) {
      state = "missing";
      detail = missingDetail;
    }

    entries.push({
      key: available.key,
      runtimeName: available.runtimeName,
      desired,
      managed,
      state,
      sourcePath: available.source,
      targetPath: path.join(skillsHome, available.runtimeName),
      detail,
      required: Boolean(available.required),
      requiredReason: available.requiredReason ?? null,
      ...buildManagedSkillOrigin(available),
    });
  }

  for (const desiredSkill of desiredSkills) {
    if (availableByKey.has(desiredSkill)) continue;
    warnings.push(`Desired skill "${desiredSkill}" is not available from the Paperclip skills directory.`);
    entries.push({
      key: desiredSkill,
      runtimeName: null,
      desired: true,
      managed: true,
      state: "missing",
      sourcePath: null,
      targetPath: null,
      detail: "Paperclip cannot find this skill in the local runtime skills directory.",
      origin: "external_unknown",
      originLabel: "External or unavailable",
      readOnly: false,
    });
  }

  const diagnosticInstalled = options.diagnosticInstalled ?? new Map<string, InstalledSkillTarget>();

  for (const [name, installedEntry] of installed.entries()) {
    if (availableEntries.some((entry) => entry.runtimeName === name)) continue;
    entries.push({
      key: name,
      runtimeName: name,
      desired: false,
      managed: false,
      state: "blocked",
      origin: "user_installed",
      originLabel: "User-installed",
      locationLabel: skillLocationLabel(locationLabel),
      readOnly: true,
      sourcePath: null,
      targetPath: installedEntry.targetPath ?? path.join(skillsHome, name),
      detail: externalDetail,
    });
  }

  for (const [name, installedEntry] of diagnosticInstalled.entries()) {
    if (installed.has(name)) continue;
    if (availableEntries.some((entry) => entry.runtimeName === name)) continue;
    entries.push({
      key: name,
      runtimeName: name,
      desired: false,
      managed: false,
      state: "blocked",
      origin: "user_installed",
      originLabel: "Blocked unmanaged skill",
      locationLabel: skillLocationLabel(options.diagnosticLocationLabel ?? locationLabel),
      readOnly: true,
      sourcePath: null,
      targetPath: installedEntry.targetPath ?? null,
      detail: options.diagnosticExternalDetail ?? externalDetail,
    });
  }

  entries.sort((left, right) => left.key.localeCompare(right.key));

  return {
    adapterType,
    supported: true,
    mode: "persistent",
    desiredSkills,
    entries,
    warnings,
  };
}

function normalizeConfiguredPaperclipRuntimeSkills(value: unknown): PaperclipSkillEntry[] {
  if (!Array.isArray(value)) return [];
  const out: PaperclipSkillEntry[] = [];
  for (const rawEntry of value) {
    const entry = parseObject(rawEntry);
    const key = asString(entry.key, asString(entry.name, "")).trim();
    const runtimeName = asString(entry.runtimeName, asString(entry.name, "")).trim();
    const source = asString(entry.source, "").trim();
    if (!key || !runtimeName || !source) continue;
    out.push({
      key,
      runtimeName,
      source,
      required: asBoolean(entry.required, false),
      requiredReason:
        typeof entry.requiredReason === "string" && entry.requiredReason.trim().length > 0
          ? entry.requiredReason.trim()
          : null,
    });
  }
  return out;
}

export async function readPaperclipRuntimeSkillEntries(
  config: Record<string, unknown>,
  moduleDir: string,
  additionalCandidates: string[] = [],
): Promise<PaperclipSkillEntry[]> {
  const configuredEntries = normalizeConfiguredPaperclipRuntimeSkills(config.paperclipRuntimeSkills);
  if (configuredEntries.length > 0) return configuredEntries;
  return listPaperclipSkillEntries(moduleDir, additionalCandidates);
}

export async function readPaperclipSkillMarkdown(
  moduleDir: string,
  skillKey: string,
): Promise<string | null> {
  const normalized = skillKey.trim().toLowerCase();
  if (!normalized) return null;

  const entries = await listPaperclipSkillEntries(moduleDir);
  const match = entries.find((entry) => entry.key === normalized);
  if (!match) return null;

  try {
    return await fs.readFile(path.join(match.source, "SKILL.md"), "utf8");
  } catch {
    return null;
  }
}

export function readPaperclipSkillSyncPreference(config: Record<string, unknown>): {
  explicit: boolean;
  desiredSkills: string[];
} {
  const raw = config.paperclipSkillSync;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { explicit: false, desiredSkills: [] };
  }
  const syncConfig = raw as Record<string, unknown>;
  const desiredValues = syncConfig.desiredSkills;
  const desired = Array.isArray(desiredValues)
    ? desiredValues
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean)
    : [];
  return {
    explicit: Object.prototype.hasOwnProperty.call(raw, "desiredSkills"),
    desiredSkills: Array.from(new Set(desired)),
  };
}

function canonicalizeDesiredPaperclipSkillReference(
  reference: string,
  availableEntries: Array<{ key: string; runtimeName?: string | null }>,
): string {
  const normalizedReference = reference.trim().toLowerCase();
  if (!normalizedReference) return "";

  const exactKey = availableEntries.find((entry) => entry.key.trim().toLowerCase() === normalizedReference);
  if (exactKey) return exactKey.key;

  const byRuntimeName = availableEntries.filter((entry) =>
    typeof entry.runtimeName === "string" && entry.runtimeName.trim().toLowerCase() === normalizedReference,
  );
  if (byRuntimeName.length === 1) return byRuntimeName[0]!.key;

  const slugMatches = availableEntries.filter((entry) =>
    entry.key.trim().toLowerCase().split("/").pop() === normalizedReference,
  );
  if (slugMatches.length === 1) return slugMatches[0]!.key;

  return normalizedReference;
}

export function resolvePaperclipDesiredSkillNames(
  config: Record<string, unknown>,
  availableEntries: Array<{ key: string; runtimeName?: string | null; required?: boolean }>,
): string[] {
  const preference = readPaperclipSkillSyncPreference(config);
  const requiredSkills = availableEntries
    .filter((entry) => entry.required)
    .map((entry) => entry.key);
  if (!preference.explicit) {
    return Array.from(new Set(requiredSkills));
  }
  const desiredSkills = preference.desiredSkills
    .map((reference) => canonicalizeDesiredPaperclipSkillReference(reference, availableEntries))
    .filter(Boolean);
  return Array.from(new Set([...requiredSkills, ...desiredSkills]));
}

export function writePaperclipSkillSyncPreference(
  config: Record<string, unknown>,
  desiredSkills: string[],
): Record<string, unknown> {
  const next = { ...config };
  const raw = next.paperclipSkillSync;
  const current =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? { ...(raw as Record<string, unknown>) }
      : {};
  current.desiredSkills = Array.from(
    new Set(
      desiredSkills
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
  next.paperclipSkillSync = current;
  return next;
}

export async function ensurePaperclipSkillSymlink(
  source: string,
  target: string,
  linkSkill: (source: string, target: string) => Promise<void> = (linkSource, linkTarget) =>
    fs.symlink(linkSource, linkTarget),
): Promise<"created" | "repaired" | "skipped"> {
  const existing = await fs.lstat(target).catch(() => null);
  if (!existing) {
    await linkSkill(source, target);
    return "created";
  }

  if (!existing.isSymbolicLink()) {
    return "skipped";
  }

  const linkedPath = await fs.readlink(target).catch(() => null);
  if (!linkedPath) return "skipped";

  const resolvedLinkedPath = path.resolve(path.dirname(target), linkedPath);
  if (resolvedLinkedPath === source) {
    return "skipped";
  }

  const linkedPathExists = await fs.stat(resolvedLinkedPath).then(() => true).catch(() => false);
  if (linkedPathExists) {
    return "skipped";
  }

  await fs.unlink(target);
  await linkSkill(source, target);
  return "repaired";
}

export async function removeMaintainerOnlySkillSymlinks(
  skillsHome: string,
  allowedSkillNames: Iterable<string>,
): Promise<string[]> {
  const allowed = new Set(Array.from(allowedSkillNames));
  try {
    const entries = await fs.readdir(skillsHome, { withFileTypes: true });
    const removed: string[] = [];
    for (const entry of entries) {
      if (allowed.has(entry.name)) continue;

      const target = path.join(skillsHome, entry.name);
      const existing = await fs.lstat(target).catch(() => null);
      if (!existing?.isSymbolicLink()) continue;

      const linkedPath = await fs.readlink(target).catch(() => null);
      if (!linkedPath) continue;

      const resolvedLinkedPath = path.isAbsolute(linkedPath)
        ? linkedPath
        : path.resolve(path.dirname(target), linkedPath);
      if (
        !isMaintainerOnlySkillTarget(linkedPath) &&
        !isMaintainerOnlySkillTarget(resolvedLinkedPath)
      ) {
        continue;
      }

      await fs.unlink(target);
      removed.push(entry.name);
    }

    return removed;
  } catch {
    return [];
  }
}

export async function ensureCommandResolvable(command: string, cwd: string, env: NodeJS.ProcessEnv) {
  const resolved = await resolveCommandPath(command, cwd, env);
  if (resolved) return;
  if (command.includes("/") || command.includes("\\")) {
    const absolute = path.isAbsolute(command) ? command : path.resolve(cwd, command);
    throw new Error(`Command is not executable: "${command}" (resolved: "${absolute}")`);
  }
  throw new Error(`Command not found in PATH: "${command}"`);
}

export async function runChildProcess(
  runId: string,
  command: string,
  args: string[],
  opts: {
    cwd: string;
    env: Record<string, string>;
    timeoutSec: number;
    graceSec: number;
    onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
    onLogError?: (err: unknown, runId: string, message: string) => void;
    onSpawn?: (meta: { pid: number; processGroupId: number | null; startedAt: string }) => Promise<void>;
    stdin?: string;
  },
): Promise<RunProcessResult> {
  const onLogError = opts.onLogError ?? ((err, id, msg) => console.warn({ err, runId: id }, msg));

  return new Promise<RunProcessResult>((resolve, reject) => {
    const rawMerged: NodeJS.ProcessEnv = { ...process.env, ...opts.env };

    // Strip Claude Code nesting-guard env vars so spawned `claude` processes
    // don't refuse to start with "cannot be launched inside another session".
    // These vars leak in when the Paperclip server itself is started from
    // within a Claude Code session (e.g. `npx paperclipai run` in a terminal
    // owned by Claude Code) or when cron inherits a contaminated shell env.
    const CLAUDE_CODE_NESTING_VARS = [
      "CLAUDECODE",
      "CLAUDE_CODE_ENTRYPOINT",
      "CLAUDE_CODE_SESSION",
      "CLAUDE_CODE_PARENT_SESSION",
    ] as const;
    for (const key of CLAUDE_CODE_NESTING_VARS) {
      delete rawMerged[key];
    }

    const mergedEnv = ensurePathInEnv(rawMerged);
    void resolveSpawnTarget(command, args, opts.cwd, mergedEnv)
      .then((target) => {
        const child = spawn(target.command, target.args, {
          cwd: opts.cwd,
          env: mergedEnv,
          detached: process.platform !== "win32",
          shell: false,
          stdio: [opts.stdin != null ? "pipe" : "ignore", "pipe", "pipe"],
        }) as ChildProcessWithEvents;
        const startedAt = new Date().toISOString();
        const processGroupId = resolveProcessGroupId(child);

        const spawnPersistPromise =
          typeof child.pid === "number" && child.pid > 0 && opts.onSpawn
            ? opts.onSpawn({ pid: child.pid, processGroupId, startedAt }).catch((err) => {
              onLogError(err, runId, "failed to record child process metadata");
            })
            : Promise.resolve();

        runningProcesses.set(runId, { child, graceSec: opts.graceSec, processGroupId });

        let timedOut = false;
        let stdout = "";
        let stderr = "";
        let logChain: Promise<void> = Promise.resolve();

        const timeout =
          opts.timeoutSec > 0
            ? setTimeout(() => {
                timedOut = true;
                signalRunningProcess({ child, processGroupId }, "SIGTERM");
                setTimeout(() => {
                  signalRunningProcess({ child, processGroupId }, "SIGKILL");
                }, Math.max(1, opts.graceSec) * 1000);
              }, opts.timeoutSec * 1000)
            : null;

        child.stdout?.on("data", (chunk: unknown) => {
          const readable = child.stdout;
          if (!readable) return;
          readable.pause();
          const text = String(chunk);
          stdout = appendWithCap(stdout, text);
          logChain = logChain
            .then(() => opts.onLog("stdout", text))
            .catch((err) => onLogError(err, runId, "failed to append stdout log chunk"))
            .finally(() => resumeReadable(readable));
        });

        child.stderr?.on("data", (chunk: unknown) => {
          const readable = child.stderr;
          if (!readable) return;
          readable.pause();
          const text = String(chunk);
          stderr = appendWithCap(stderr, text);
          logChain = logChain
            .then(() => opts.onLog("stderr", text))
            .catch((err) => onLogError(err, runId, "failed to append stderr log chunk"))
            .finally(() => resumeReadable(readable));
        });

        const stdin = child.stdin;
        if (opts.stdin != null && stdin) {
          stdin.on("error", (err) => {
            const code = (err as NodeJS.ErrnoException).code;
            if (code === "EPIPE" || code === "ERR_STREAM_DESTROYED") {
              return;
            }
            onLogError(err, runId, "failed to write stdin to child process");
          });

          void spawnPersistPromise.finally(() => {
            if (child.killed || stdin.destroyed || stdin.writableEnded) return;
            try {
              stdin.write(opts.stdin as string);
              stdin.end();
            } catch (err) {
              const code = (err as NodeJS.ErrnoException).code;
              if (code === "EPIPE" || code === "ERR_STREAM_DESTROYED") {
                return;
              }
              onLogError(err, runId, "failed to write stdin to child process");
            }
          });
        }

        child.on("error", (err: Error) => {
          if (timeout) clearTimeout(timeout);
          runningProcesses.delete(runId);
          const errno = (err as NodeJS.ErrnoException).code;
          const pathValue = mergedEnv.PATH ?? mergedEnv.Path ?? "";
          const msg =
            errno === "ENOENT"
              ? `Failed to start command "${command}" in "${opts.cwd}". Verify adapter command, working directory, and PATH (${pathValue}).`
              : `Failed to start command "${command}" in "${opts.cwd}": ${err.message}`;
          reject(new Error(msg));
        });

        child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
          if (timeout) clearTimeout(timeout);
          runningProcesses.delete(runId);
          void logChain.finally(() => {
            resolve({
              exitCode: code,
              signal,
              timedOut,
              stdout,
              stderr,
              pid: child.pid ?? null,
              startedAt,
            });
          });
        });
      })
      .catch(reject);
  });
}
