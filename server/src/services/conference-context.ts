import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { Db } from "@paperclipai/db";
import { approvals, issueApprovals } from "@paperclipai/db";
import type {
  ConferenceContext,
  ConferenceExecutionWorkspaceSummary,
  ConferenceProjectWorkspaceSummary,
  GitSnapshot,
  GitSnapshotFile,
  GitSnapshotStatusCode,
  RequestBoardApprovalPayload,
} from "@paperclipai/shared";
import {
  conferenceContextSchema,
  normalizeRequestBoardApprovalPayload,
} from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";
import { redactEventPayload } from "../redaction.js";
import { logActivity } from "./activity-log.js";
import { executionWorkspaceService } from "./execution-workspaces.js";
import { issueService } from "./issues.js";
import { projectService } from "./projects.js";

const execFileAsync = promisify(execFile);
const GIT_SNAPSHOT_STATUS_CODES = new Set<GitSnapshotStatusCode>([" ", "M", "T", "A", "D", "R", "C", "U", "?"]);
export const MAX_CONFERENCE_CONTEXT_CHANGED_FILES = 50;

export type ConferenceContextActor = "board" | "agent";

type ParsedPorcelainStatusLine = {
  path: string;
  previousPath: string | null;
  indexStatus: GitSnapshotStatusCode;
  worktreeStatus: GitSnapshotStatusCode;
  status: `${GitSnapshotStatusCode}${GitSnapshotStatusCode}`;
};

export type InspectedGitSnapshot = {
  snapshot: GitSnapshot | null;
  isMergedIntoBase: boolean | null;
};

type CreateConferenceApprovalInput = {
  companyId: string;
  issueId: string;
  payload: unknown;
  requestedByAgentId?: string | null;
  requestedByUserId?: string | null;
  actorType: "agent" | "user";
  actorId: string;
  agentId?: string | null;
  runId?: string | null;
};

function readNullableString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function runGit(cwd: string, args: string[]) {
  return await execFileAsync("git", ["-C", cwd, ...args], { cwd });
}

function buildDisplayPath(targetPath: string | null, rootPath: string | null) {
  if (!targetPath) return null;
  const resolvedTarget = path.resolve(targetPath);
  const targetBase = path.basename(resolvedTarget) || resolvedTarget;
  if (!rootPath) return targetBase;

  const resolvedRoot = path.resolve(rootPath);
  const rootBase = path.basename(resolvedRoot) || resolvedRoot;
  if (resolvedTarget === resolvedRoot) return rootBase;
  if (resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    const relativePath = path.relative(resolvedRoot, resolvedTarget);
    return relativePath.length > 0 ? path.join(rootBase, relativePath) : rootBase;
  }
  return targetBase;
}

function isGitSnapshotStatusCode(value: string): value is GitSnapshotStatusCode {
  return GIT_SNAPSHOT_STATUS_CODES.has(value as GitSnapshotStatusCode);
}

function parsePorcelainStatusLine(line: string): ParsedPorcelainStatusLine | null {
  if (line.length < 3) return null;
  const indexStatus = line.slice(0, 1);
  const worktreeStatus = line.slice(1, 2);
  if (!isGitSnapshotStatusCode(indexStatus) || !isGitSnapshotStatusCode(worktreeStatus)) {
    return null;
  }

  const rawPath = line.slice(3).trim();
  if (rawPath.length === 0) return null;

  const isRenameOrCopy = indexStatus === "R" || indexStatus === "C" || worktreeStatus === "R" || worktreeStatus === "C";
  if (isRenameOrCopy && rawPath.includes(" -> ")) {
    const [previousPath, nextPath] = rawPath.split(" -> ", 2);
    if (!previousPath || !nextPath) return null;
    return {
      path: nextPath,
      previousPath,
      indexStatus,
      worktreeStatus,
      status: `${indexStatus}${worktreeStatus}`,
    };
  }

  return {
    path: rawPath,
    previousPath: null,
    indexStatus,
    worktreeStatus,
    status: `${indexStatus}${worktreeStatus}`,
  };
}

export async function inspectGitSnapshot(input: {
  workspacePath: string;
  baseRef?: string | null;
  maxFiles?: number;
}): Promise<InspectedGitSnapshot> {
  const workspacePath = path.resolve(input.workspacePath);
  const maxFiles = Math.max(1, input.maxFiles ?? MAX_CONFERENCE_CONTEXT_CHANGED_FILES);

  let rootPath: string | null = null;
  try {
    rootPath = (await runGit(workspacePath, ["rev-parse", "--show-toplevel"])).stdout.trim() || null;
  } catch {
    return { snapshot: null, isMergedIntoBase: null };
  }
  if (!rootPath) {
    return { snapshot: null, isMergedIntoBase: null };
  }

  let branchName: string | null = null;
  try {
    branchName = (await runGit(workspacePath, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim() || null;
  } catch {
    branchName = null;
  }

  let changedFiles: GitSnapshotFile[] = [];
  let dirtyEntryCount = 0;
  let untrackedEntryCount = 0;
  let changedFileCount = 0;
  try {
    const statusOutput = (await runGit(
      workspacePath,
      ["status", "--porcelain=v1", "--untracked-files=all"],
    )).stdout;
    for (const line of statusOutput.split(/\r?\n/)) {
      if (!line) continue;
      const parsed = parsePorcelainStatusLine(line);
      if (!parsed) continue;
      changedFileCount += 1;
      if (parsed.indexStatus === "?" && parsed.worktreeStatus === "?") {
        untrackedEntryCount += 1;
      } else {
        dirtyEntryCount += 1;
      }
      if (changedFiles.length < maxFiles) {
        changedFiles.push(parsed);
      }
    }
  } catch {
    changedFiles = [];
    dirtyEntryCount = 0;
    untrackedEntryCount = 0;
    changedFileCount = 0;
  }

  const baseRef = readNullableString(input.baseRef);
  let aheadCount: number | null = null;
  let behindCount: number | null = null;
  let isMergedIntoBase: boolean | null = null;

  if (baseRef) {
    try {
      const counts = (await runGit(workspacePath, ["rev-list", "--left-right", "--count", `${baseRef}...HEAD`])).stdout.trim();
      const [behindRaw, aheadRaw] = counts.split(/\s+/);
      behindCount = behindRaw ? Number.parseInt(behindRaw, 10) : 0;
      aheadCount = aheadRaw ? Number.parseInt(aheadRaw, 10) : 0;
    } catch {
      aheadCount = null;
      behindCount = null;
    }

    try {
      await runGit(workspacePath, ["merge-base", "--is-ancestor", "HEAD", baseRef]);
      isMergedIntoBase = true;
    } catch (error) {
      const code = typeof error === "object" && error && "code" in error ? (error as { code?: unknown }).code : null;
      if (code === 1) {
        isMergedIntoBase = false;
      } else {
        isMergedIntoBase = null;
      }
    }
  }

  return {
    snapshot: {
      rootPath,
      workspacePath,
      displayRootPath: buildDisplayPath(rootPath, rootPath),
      displayWorkspacePath: buildDisplayPath(workspacePath, rootPath),
      branchName,
      baseRef,
      isGit: true,
      dirty: changedFileCount > 0,
      dirtyEntryCount,
      untrackedEntryCount,
      aheadCount,
      behindCount,
      changedFileCount,
      truncated: changedFileCount > changedFiles.length,
      changedFiles,
    },
    isMergedIntoBase,
  };
}

function summarizeProjectWorkspace(
  workspace: {
    id: string;
    projectId: string;
    name: string;
    sourceType: ConferenceProjectWorkspaceSummary["sourceType"];
    isPrimary: boolean;
    repoUrl: string | null;
    repoRef: string | null;
    defaultRef: string | null;
  } | null | undefined,
): ConferenceProjectWorkspaceSummary | null {
  if (!workspace) return null;
  return {
    id: workspace.id,
    projectId: workspace.projectId,
    name: workspace.name,
    sourceType: workspace.sourceType,
    isPrimary: workspace.isPrimary,
    repoUrl: workspace.repoUrl,
    repoRef: workspace.repoRef,
    defaultRef: workspace.defaultRef,
  };
}

function summarizeExecutionWorkspace(
  workspace: {
    id: string;
    projectId: string;
    projectWorkspaceId: string | null;
    name: string;
    mode: ConferenceExecutionWorkspaceSummary["mode"];
    status: ConferenceExecutionWorkspaceSummary["status"];
    providerType: ConferenceExecutionWorkspaceSummary["providerType"];
    repoUrl: string | null;
    baseRef: string | null;
    branchName: string | null;
  } | null | undefined,
): ConferenceExecutionWorkspaceSummary | null {
  if (!workspace) return null;
  return {
    id: workspace.id,
    projectId: workspace.projectId,
    projectWorkspaceId: workspace.projectWorkspaceId,
    name: workspace.name,
    mode: workspace.mode,
    status: workspace.status,
    providerType: workspace.providerType,
    repoUrl: workspace.repoUrl,
    baseRef: workspace.baseRef,
    branchName: workspace.branchName,
  };
}

export function sanitizeConferenceContextForActor(
  context: ConferenceContext,
  actor: ConferenceContextActor,
): ConferenceContext {
  if (actor === "board" || context.git == null) return context;
  return {
    ...context,
    git: {
      ...context.git,
      rootPath: null,
      workspacePath: null,
    },
  };
}

export function serializeApprovalForActor<T extends { type: string; payload: Record<string, unknown> }>(
  approval: T,
  actor: ConferenceContextActor,
): T {
  const redactedPayload = redactEventPayload(approval.payload) ?? {};
  if (approval.type !== "request_board_approval") {
    return {
      ...approval,
      payload: redactedPayload,
    };
  }

  const repoContextResult = conferenceContextSchema.safeParse(approval.payload.repoContext);
  if (!repoContextResult.success) {
    return {
      ...approval,
      payload: redactedPayload,
    };
  }

  return {
    ...approval,
    payload: {
      ...redactedPayload,
      repoContext: sanitizeConferenceContextForActor(repoContextResult.data, actor),
    },
  };
}

export function conferenceContextService(db: Db) {
  const issuesSvc = issueService(db);
  const projectsSvc = projectService(db);
  const executionWorkspacesSvc = executionWorkspaceService(db);

  async function resolveForIssueRecord(issue: Awaited<ReturnType<ReturnType<typeof issueService>["getById"]>>) {
    if (!issue) return null;

    const project = issue.projectId ? await projectsSvc.getById(issue.projectId) : null;
    const projectWorkspace = issue.projectWorkspaceId
      ? project?.workspaces.find((workspace) => workspace.id === issue.projectWorkspaceId) ?? null
      : project?.primaryWorkspace ?? null;

    const executionWorkspace = issue.executionWorkspaceId
      ? await executionWorkspacesSvc.getById(issue.executionWorkspaceId)
      : null;

    const gitWorkspacePath = executionWorkspace
      ? readNullableString(executionWorkspace.providerRef) ?? readNullableString(executionWorkspace.cwd)
      : readNullableString(projectWorkspace?.cwd);
    const gitBaseRef = executionWorkspace?.baseRef ?? projectWorkspace?.defaultRef ?? projectWorkspace?.repoRef ?? null;
    const gitInspection = gitWorkspacePath
      ? await inspectGitSnapshot({
          workspacePath: gitWorkspacePath,
          baseRef: gitBaseRef,
          maxFiles: MAX_CONFERENCE_CONTEXT_CHANGED_FILES,
        })
      : { snapshot: null, isMergedIntoBase: null };

    return {
      capturedAt: new Date().toISOString(),
      projectWorkspace: summarizeProjectWorkspace(projectWorkspace),
      executionWorkspace: summarizeExecutionWorkspace(
        executionWorkspace
          ? {
              id: executionWorkspace.id,
              projectId: executionWorkspace.projectId,
              projectWorkspaceId: executionWorkspace.projectWorkspaceId,
              name: executionWorkspace.name,
              mode: executionWorkspace.mode,
              status: executionWorkspace.status,
              providerType: executionWorkspace.providerType,
              repoUrl: executionWorkspace.repoUrl,
              baseRef: executionWorkspace.baseRef,
              branchName: executionWorkspace.branchName,
            }
          : null,
      ),
      git: gitInspection.snapshot,
    } satisfies ConferenceContext;
  }

  return {
    resolveForIssue: async (issueRef: string) => {
      const issue = await issuesSvc.getById(issueRef);
      return resolveForIssueRecord(issue);
    },
    resolveForIssueRecord,
  };
}

export function conferenceApprovalService(db: Db) {
  const issuesSvc = issueService(db);

  return {
    createRequestBoardApproval: async (input: CreateConferenceApprovalInput) => {
      return db.transaction(async (tx) => {
        const issue = await issueService(tx as unknown as Db).getById(input.issueId);
        if (!issue) throw notFound("Issue not found");
        if (issue.companyId !== input.companyId) {
          throw unprocessable("Issue and approval must belong to the same company");
        }

        const normalizedPayload = normalizeRequestBoardApprovalPayload(input.payload);
        const repoContext = await conferenceContextService(tx as unknown as Db).resolveForIssueRecord(issue);
        const payload: RequestBoardApprovalPayload = {
          ...normalizedPayload,
          ...(repoContext ? { repoContext } : {}),
        };
        const now = new Date();

        const approval = await tx
          .insert(approvals)
          .values({
            companyId: input.companyId,
            type: "request_board_approval",
            requestedByAgentId: input.requestedByAgentId ?? null,
            requestedByUserId: input.requestedByUserId ?? null,
            status: "pending",
            payload,
            decisionNote: null,
            decidedByUserId: null,
            decidedAt: null,
            updatedAt: now,
          })
          .returning()
          .then((rows) => rows[0] ?? null);

        if (!approval) {
          throw unprocessable("Unable to create conference approval");
        }

        await tx.insert(issueApprovals).values({
          companyId: input.companyId,
          issueId: issue.id,
          approvalId: approval.id,
          linkedByAgentId: input.agentId ?? null,
          linkedByUserId: input.actorType === "user" ? input.actorId : null,
        });

        await logActivity(tx as unknown as Db, {
          companyId: input.companyId,
          actorType: input.actorType,
          actorId: input.actorId,
          agentId: input.agentId ?? null,
          runId: input.runId ?? null,
          action: "approval.created",
          entityType: "approval",
          entityId: approval.id,
          details: { type: approval.type, issueIds: [issue.id] },
        });

        return approval;
      });
    },
  };
}
