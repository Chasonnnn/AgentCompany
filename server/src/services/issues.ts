import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, not, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agents,
  agentProjectScopes,
  assets,
  companies,
  companyMemberships,
  documents,
  goals,
  heartbeatRuns,
  executionWorkspaces,
  issueAttachments,
  issueInboxArchives,
  issueLabels,
  issueRelations,
  issueComments,
  issueDocuments,
  issueReadStates,
  issues,
  labels,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import type { IssueRelationIssueSummary } from "@paperclipai/shared";
import { extractAgentMentionIds, extractProjectMentionIds, isUuidLike } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import {
  defaultIssueExecutionWorkspaceSettingsForProject,
  gateProjectExecutionWorkspacePolicy,
  issueExecutionWorkspaceModeForPersistedWorkspace,
  parseIssueExecutionWorkspaceSettings,
  parseProjectExecutionWorkspacePolicy,
} from "./execution-workspace-policy.js";
import { instanceSettingsService } from "./instance-settings.js";
import { redactCurrentUserText } from "../log-redaction.js";
import { resolveIssueGoalId, resolveNextIssueGoalId } from "./issue-goal-fallback.js";
import { getDefaultCompanyGoal } from "./goals.js";
import {
  ISSUE_TREE_CONTROL_INTERACTION_WAKE_REASONS,
  issueTreeControlService,
  type ActiveIssueTreePauseHoldGate,
} from "./issue-tree-control.js";

const ALL_ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled"];
const EXECUTING_ISSUE_STATUSES = new Set(["in_progress", "in_review", "blocked"]);
const TERMINAL_ISSUE_STATUSES = new Set(["done", "cancelled"]);
const CHECKOUT_ALLOWED_EXPECTED_STATUSES = new Set(["backlog", "todo", "blocked"]);
const ISSUE_STATUS_TRANSITIONS: Record<string, readonly string[]> = {
  backlog: ["todo", "in_progress", "blocked", "done", "cancelled"],
  todo: ["backlog", "in_progress", "blocked", "done", "cancelled"],
  in_progress: ["todo", "in_review", "blocked", "done", "cancelled"],
  in_review: ["todo", "in_progress", "blocked", "done", "cancelled"],
  blocked: ["todo", "in_progress", "done", "cancelled"],
  done: ["todo"],
  cancelled: ["todo"],
};
const MAX_ISSUE_COMMENT_PAGE_LIMIT = 500;
export const ISSUE_LIST_DEFAULT_LIMIT = 500;
export const ISSUE_LIST_MAX_LIMIT = 1000;
const ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE = 500;
export const MAX_CHILD_ISSUES_CREATED_BY_HELPER = 25;
const MAX_CHILD_COMPLETION_SUMMARIES = 20;
const CHILD_COMPLETION_SUMMARY_BODY_MAX_CHARS = 500;
function assertTransition(from: string, to: string) {
  if (from === to) return;
  if (!ALL_ISSUE_STATUSES.includes(from)) {
    throw conflict(`Unknown issue status: ${from}`);
  }
  if (!ALL_ISSUE_STATUSES.includes(to)) {
    throw conflict(`Unknown issue status: ${to}`);
  }
  const allowedTransitions = ISSUE_STATUS_TRANSITIONS[from] ?? [];
  if (!allowedTransitions.includes(to)) {
    throw conflict("Illegal issue status transition", {
      fromStatus: from,
      toStatus: to,
      allowedStatuses: allowedTransitions,
    });
  }
}

function normalizeCheckoutExpectedStatuses(expectedStatuses: string[]) {
  const normalized = [...new Set(expectedStatuses)];
  const invalidStatuses = normalized.filter((status) => !CHECKOUT_ALLOWED_EXPECTED_STATUSES.has(status));
  if (invalidStatuses.length > 0) {
    throw unprocessable("Checkout expectedStatuses can only include backlog, todo, or blocked", {
      invalidExpectedStatuses: invalidStatuses,
      allowedExpectedStatuses: [...CHECKOUT_ALLOWED_EXPECTED_STATUSES],
    });
  }
  return normalized;
}

function applyStatusSideEffects(
  status: string | undefined,
  patch: Partial<typeof issues.$inferInsert>,
): Partial<typeof issues.$inferInsert> {
  if (!status) return patch;

  if (status === "in_progress" && !patch.startedAt) {
    patch.startedAt = new Date();
  }
  if (status === "done") {
    patch.completedAt = new Date();
  }
  if (status === "cancelled") {
    patch.cancelledAt = new Date();
  }
  return patch;
}

function readStringFromRecord(record: unknown, key: string) {
  if (!record || typeof record !== "object") return null;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readLatestWakeCommentId(record: unknown) {
  if (!record || typeof record !== "object") return null;
  const value = (record as Record<string, unknown>).wakeCommentIds;
  if (Array.isArray(value)) {
    const latest = value
      .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      .at(-1);
    if (latest) return latest.trim();
  }
  return readStringFromRecord(record, "wakeCommentId") ?? readStringFromRecord(record, "commentId");
}

export interface IssueFilters {
  status?: string;
  assigneeAgentId?: string;
  participantAgentId?: string;
  assigneeUserId?: string;
  touchedByUserId?: string;
  inboxArchivedByUserId?: string;
  unreadForUserId?: string;
  projectId?: string;
  executionWorkspaceId?: string;
  parentId?: string;
  descendantOf?: string;
  labelId?: string;
  originKind?: string;
  originId?: string;
  includeRoutineExecutions?: boolean;
  q?: string;
  limit?: number;
}

type IssueRow = typeof issues.$inferSelect;
type IssueLabelRow = typeof labels.$inferSelect;
type IssueActiveRunRow = {
  id: string;
  status: string;
  agentId: string;
  invocationSource: string;
  triggerDetail: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
};
type IssueWithLabels = IssueRow & { labels: IssueLabelRow[]; labelIds: string[] };
type IssueWithLabelsAndRun = IssueWithLabels & { activeRun: IssueActiveRunRow | null };
type IssueUserCommentStats = {
  issueId: string;
  myLastCommentAt: Date | null;
  lastExternalCommentAt: Date | null;
};
type IssueReadStat = {
  issueId: string;
  myLastReadAt: Date | null;
};
type IssueLastActivityStat = {
  issueId: string;
  latestCommentAt: Date | null;
  latestLogAt: Date | null;
};
type IssueUserContextInput = {
  createdByUserId: string | null;
  assigneeUserId: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};
type ProjectGoalReader = Pick<Db, "select">;
type DbReader = Pick<Db, "select">;
type IssueCreateInput = Omit<typeof issues.$inferInsert, "companyId" | "projectId"> & {
  projectId?: string | null;
  labelIds?: string[];
  blockedByIssueIds?: string[];
  inheritExecutionWorkspaceFromIssueId?: string | null;
};
type IssueChildCreateInput = IssueCreateInput & {
  acceptanceCriteria?: string[];
  blockParentUntilDone?: boolean;
  actorAgentId?: string | null;
  actorUserId?: string | null;
};
type IssueUpdateInput = Partial<Omit<typeof issues.$inferInsert, "projectId">> & {
  projectId?: string | null;
  labelIds?: string[];
  blockedByIssueIds?: string[];
  actorAgentId?: string | null;
  actorUserId?: string | null;
};
type IssueRelationSummaryMap = {
  blockedBy: IssueRelationIssueSummary[];
  blocks: IssueRelationIssueSummary[];
};
export type IssueDependencyReadiness = {
  issueId: string;
  blockerIssueIds: string[];
  unresolvedBlockerIssueIds: string[];
  unresolvedBlockerCount: number;
  allBlockersDone: boolean;
  isDependencyReady: boolean;
};
export type ChildIssueCompletionSummary = {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  updatedAt: Date;
  summary: string | null;
};

function sameRunLock(checkoutRunId: string | null, actorRunId: string | null) {
  if (actorRunId) return checkoutRunId === actorRunId;
  return checkoutRunId == null;
}

const TERMINAL_HEARTBEAT_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out"]);

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export function clampIssueListLimit(limit: number): number {
  return Math.min(ISSUE_LIST_MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

function chunkList<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function truncateInlineSummary(value: string | null | undefined, maxChars = CHILD_COMPLETION_SUMMARY_BODY_MAX_CHARS) {
  const normalized = value?.trim();
  if (!normalized) return null;
  return normalized.length > maxChars ? `${normalized.slice(0, Math.max(0, maxChars - 15)).trimEnd()} [truncated]` : normalized;
}

function appendAcceptanceCriteriaToDescription(description: string | null | undefined, acceptanceCriteria: string[] | undefined) {
  const criteria = (acceptanceCriteria ?? []).map((item) => item.trim()).filter(Boolean);
  if (criteria.length === 0) return description ?? null;
  const base = description?.trim() ?? "";
  const criteriaMarkdown = ["## Acceptance Criteria", "", ...criteria.map((item) => `- ${item}`)].join("\n");
  return base ? `${base}\n\n${criteriaMarkdown}` : criteriaMarkdown;
}

function createIssueDependencyReadiness(issueId: string): IssueDependencyReadiness {
  return {
    issueId,
    blockerIssueIds: [],
    unresolvedBlockerIssueIds: [],
    unresolvedBlockerCount: 0,
    allBlockersDone: true,
    isDependencyReady: true,
  };
}

async function listIssueDependencyReadinessMap(
  dbOrTx: Pick<Db, "select">,
  companyId: string,
  issueIds: string[],
) {
  const uniqueIssueIds = [...new Set(issueIds.filter(Boolean))];
  const readinessMap = new Map<string, IssueDependencyReadiness>();
  for (const issueId of uniqueIssueIds) {
    readinessMap.set(issueId, createIssueDependencyReadiness(issueId));
  }
  if (uniqueIssueIds.length === 0) return readinessMap;

  const blockerRows = await dbOrTx
    .select({
      issueId: issueRelations.relatedIssueId,
      blockerIssueId: issueRelations.issueId,
      blockerStatus: issues.status,
    })
    .from(issueRelations)
    .innerJoin(issues, eq(issueRelations.issueId, issues.id))
    .where(
      and(
        eq(issueRelations.companyId, companyId),
        eq(issueRelations.type, "blocks"),
        inArray(issueRelations.relatedIssueId, uniqueIssueIds),
      ),
    )
    .orderBy(asc(issues.identifier), asc(issues.id));

  for (const row of blockerRows) {
    const current = readinessMap.get(row.issueId) ?? createIssueDependencyReadiness(row.issueId);
    current.blockerIssueIds.push(row.blockerIssueId);
    // Only done blockers resolve dependents; cancelled blockers stay unresolved
    // until an operator removes or replaces the blocker relationship explicitly.
    if (row.blockerStatus !== "done") {
      current.unresolvedBlockerIssueIds.push(row.blockerIssueId);
      current.unresolvedBlockerCount += 1;
      current.allBlockersDone = false;
      current.isDependencyReady = false;
    }
    readinessMap.set(row.issueId, current);
  }

  return readinessMap;
}

async function listUnresolvedBlockerIssueIds(
  dbOrTx: Pick<Db, "select">,
  companyId: string,
  blockerIssueIds: string[],
) {
  const uniqueBlockerIssueIds = [...new Set(blockerIssueIds.filter(Boolean))];
  if (uniqueBlockerIssueIds.length === 0) return [];
  return dbOrTx
    .select({ id: issues.id })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        inArray(issues.id, uniqueBlockerIssueIds),
        // Cancelled blockers intentionally remain unresolved until the relation changes.
        ne(issues.status, "done"),
      ),
    )
    .then((rows) => rows.map((row) => row.id));
}
async function getProjectDefaultGoalId(
  db: ProjectGoalReader,
  companyId: string,
  projectId: string | null | undefined,
) {
  if (!projectId) return null;
  const row = await db
    .select({ goalId: projects.goalId })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  return row?.goalId ?? null;
}

async function getWorkspaceInheritanceIssue(
  db: DbReader,
  companyId: string,
  issueId: string,
) {
  const issue = await db
    .select({
      id: issues.id,
      projectId: issues.projectId,
      projectWorkspaceId: issues.projectWorkspaceId,
      executionWorkspaceId: issues.executionWorkspaceId,
      executionWorkspaceSettings: issues.executionWorkspaceSettings,
    })
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  if (!issue) {
    throw notFound("Workspace inheritance issue not found");
  }
  return issue;
}

function touchedByUserCondition(companyId: string, userId: string) {
  return sql<boolean>`
    (
      ${issues.createdByUserId} = ${userId}
      OR ${issues.assigneeUserId} = ${userId}
      OR EXISTS (
        SELECT 1
        FROM ${issueReadStates}
        WHERE ${issueReadStates.issueId} = ${issues.id}
          AND ${issueReadStates.companyId} = ${companyId}
          AND ${issueReadStates.userId} = ${userId}
      )
      OR EXISTS (
        SELECT 1
        FROM ${issueComments}
        WHERE ${issueComments.issueId} = ${issues.id}
          AND ${issueComments.companyId} = ${companyId}
          AND ${issueComments.authorUserId} = ${userId}
      )
    )
  `;
}

function participatedByAgentCondition(companyId: string, agentId: string) {
  return sql<boolean>`
    (
      ${issues.createdByAgentId} = ${agentId}
      OR ${issues.assigneeAgentId} = ${agentId}
      OR EXISTS (
        SELECT 1
        FROM ${issueComments}
        WHERE ${issueComments.issueId} = ${issues.id}
          AND ${issueComments.companyId} = ${companyId}
          AND ${issueComments.authorAgentId} = ${agentId}
      )
      OR EXISTS (
        SELECT 1
        FROM ${activityLog}
        WHERE ${activityLog.companyId} = ${companyId}
          AND ${activityLog.entityType} = 'issue'
          AND ${activityLog.entityId} = ${issues.id}::text
          AND ${activityLog.agentId} = ${agentId}
      )
    )
  `;
}

function myLastCommentAtExpr(companyId: string, userId: string) {
  return sql<Date | null>`
    (
      SELECT MAX(${issueComments.createdAt})
      FROM ${issueComments}
      WHERE ${issueComments.issueId} = ${issues.id}
        AND ${issueComments.companyId} = ${companyId}
        AND ${issueComments.authorUserId} = ${userId}
    )
  `;
}

function myLastReadAtExpr(companyId: string, userId: string) {
  return sql<Date | null>`
    (
      SELECT MAX(${issueReadStates.lastReadAt})
      FROM ${issueReadStates}
      WHERE ${issueReadStates.issueId} = ${issues.id}
        AND ${issueReadStates.companyId} = ${companyId}
        AND ${issueReadStates.userId} = ${userId}
    )
  `;
}

function myLastTouchAtExpr(companyId: string, userId: string) {
  const myLastCommentAt = myLastCommentAtExpr(companyId, userId);
  const myLastReadAt = myLastReadAtExpr(companyId, userId);
  return sql<Date | null>`
    GREATEST(
      COALESCE(${myLastCommentAt}, to_timestamp(0)),
      COALESCE(${myLastReadAt}, to_timestamp(0)),
      COALESCE(CASE WHEN ${issues.createdByUserId} = ${userId} THEN ${issues.createdAt} ELSE NULL END, to_timestamp(0)),
      COALESCE(CASE WHEN ${issues.assigneeUserId} = ${userId} THEN ${issues.updatedAt} ELSE NULL END, to_timestamp(0))
    )
  `;
}

function lastExternalCommentAtExpr(companyId: string, userId: string) {
  return sql<Date | null>`
    (
      SELECT MAX(${issueComments.createdAt})
      FROM ${issueComments}
      WHERE ${issueComments.issueId} = ${issues.id}
        AND ${issueComments.companyId} = ${companyId}
        AND (
          ${issueComments.authorUserId} IS NULL
          OR ${issueComments.authorUserId} <> ${userId}
        )
    )
  `;
}

function issueLastActivityAtExpr(companyId: string, userId: string) {
  const lastExternalCommentAt = lastExternalCommentAtExpr(companyId, userId);
  const myLastTouchAt = myLastTouchAtExpr(companyId, userId);
  return sql<Date>`
    GREATEST(
      COALESCE(${lastExternalCommentAt}, to_timestamp(0)),
      CASE
        WHEN ${issues.updatedAt} > COALESCE(${myLastTouchAt}, to_timestamp(0))
        THEN ${issues.updatedAt}
        ELSE to_timestamp(0)
      END
    )
  `;
}

const ISSUE_LOCAL_INBOX_ACTIVITY_ACTIONS = [
  "issue.read_marked",
  "issue.read_unmarked",
  "issue.inbox_archived",
  "issue.inbox_unarchived",
] as const;

function issueLatestCommentAtExpr(companyId: string) {
  return sql<Date | null>`
    (
      SELECT MAX(${issueComments.createdAt})
      FROM ${issueComments}
      WHERE ${issueComments.issueId} = ${issues.id}
        AND ${issueComments.companyId} = ${companyId}
    )
  `;
}

function issueLatestLogAtExpr(companyId: string) {
  return sql<Date | null>`
    (
      SELECT MAX(${activityLog.createdAt})
      FROM ${activityLog}
      WHERE ${activityLog.companyId} = ${companyId}
        AND ${activityLog.entityType} = 'issue'
        AND ${activityLog.entityId} = ${issues.id}::text
        AND ${activityLog.action} NOT IN (${sql.join(
          ISSUE_LOCAL_INBOX_ACTIVITY_ACTIONS.map((action) => sql`${action}`),
          sql`, `,
        )})
    )
  `;
}

function issueCanonicalLastActivityAtExpr(companyId: string) {
  const latestCommentAt = issueLatestCommentAtExpr(companyId);
  const latestLogAt = issueLatestLogAtExpr(companyId);
  return sql<Date>`
    GREATEST(
      ${issues.updatedAt},
      COALESCE(${latestCommentAt}, to_timestamp(0)),
      COALESCE(${latestLogAt}, to_timestamp(0))
    )
  `;
}

function unreadForUserCondition(companyId: string, userId: string) {
  const touchedCondition = touchedByUserCondition(companyId, userId);
  const myLastTouchAt = myLastTouchAtExpr(companyId, userId);
  return sql<boolean>`
    (
      ${touchedCondition}
      AND EXISTS (
        SELECT 1
        FROM ${issueComments}
        WHERE ${issueComments.issueId} = ${issues.id}
          AND ${issueComments.companyId} = ${companyId}
          AND (
            ${issueComments.authorUserId} IS NULL
            OR ${issueComments.authorUserId} <> ${userId}
          )
          AND ${issueComments.createdAt} > ${myLastTouchAt}
      )
    )
  `;
}

function inboxVisibleForUserCondition(companyId: string, userId: string) {
  const issueLastActivityAt = issueLastActivityAtExpr(companyId, userId);
  return sql<boolean>`
    NOT EXISTS (
      SELECT 1
      FROM ${issueInboxArchives}
      WHERE ${issueInboxArchives.issueId} = ${issues.id}
        AND ${issueInboxArchives.companyId} = ${companyId}
        AND ${issueInboxArchives.userId} = ${userId}
        AND ${issueInboxArchives.archivedAt} >= ${issueLastActivityAt}
    )
  `;
}

/** Named entities commonly emitted in saved issue bodies; unknown `&name;` sequences are left unchanged. */
const WELL_KNOWN_NAMED_HTML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  copy: "\u00A9",
  gt: ">",
  lt: "<",
  nbsp: "\u00A0",
  quot: '"',
  ensp: "\u2002",
  emsp: "\u2003",
  thinsp: "\u2009",
};

function decodeNumericHtmlEntity(digits: string, radix: 16 | 10): string | null {
  const n = Number.parseInt(digits, radix);
  if (Number.isNaN(n) || n < 0 || n > 0x10ffff) return null;
  try {
    return String.fromCodePoint(n);
  } catch {
    return null;
  }
}

export type DroppedMentionEntry = { token?: string; agentId?: string; name: string };

export type ResolveMentionedAgentsResult = {
  agentIds: string[];
  ambiguousTokens: string[];
  droppedMentions: { terminated: DroppedMentionEntry[] };
};

async function resolveMentionedAgentsImpl(
  db: Db,
  companyId: string,
  body: string,
): Promise<ResolveMentionedAgentsResult> {
  const re = /\B@([^\s@,!?.]+)/g;
  const tokens = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const normalized = normalizeAgentMentionToken(m[1]);
    if (normalized) tokens.add(normalized.toLowerCase());
  }

  const explicitAgentMentionIds = extractAgentMentionIds(body);
  if (tokens.size === 0 && explicitAgentMentionIds.length === 0) {
    return {
      agentIds: [],
      ambiguousTokens: [],
      droppedMentions: { terminated: [] },
    };
  }
  const rows = await db
    .select({ id: agents.id, name: agents.name, status: agents.status })
    .from(agents)
    .where(eq(agents.companyId, companyId));
  const liveRows = rows.filter((row) => row.status !== "terminated");
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const liveById = new Map(liveRows.map((row) => [row.id, row]));
  const resolved = new Set<string>();
  const droppedTerminated: DroppedMentionEntry[] = [];
  const seenTerminatedKeys = new Set<string>();
  const recordDropped = (entry: DroppedMentionEntry) => {
    const key = entry.agentId ?? `name:${entry.name.toLowerCase()}`;
    if (seenTerminatedKeys.has(key)) return;
    seenTerminatedKeys.add(key);
    droppedTerminated.push(entry);
  };
  for (const explicitAgentId of explicitAgentMentionIds) {
    if (liveById.has(explicitAgentId)) {
      resolved.add(explicitAgentId);
      continue;
    }
    const terminatedRow = rowsById.get(explicitAgentId);
    if (terminatedRow && terminatedRow.status === "terminated") {
      recordDropped({ agentId: terminatedRow.id, name: terminatedRow.name });
    }
  }
  const ambiguousTokens: string[] = [];
  for (const token of tokens) {
    const liveMatches = liveRows.filter((agent) => agent.name.toLowerCase() === token);
    if (liveMatches.length === 1) {
      resolved.add(liveMatches[0]!.id);
      continue;
    }
    if (liveMatches.length > 1) {
      ambiguousTokens.push(token);
      continue;
    }
    const terminatedMatches = rows.filter(
      (agent) => agent.status === "terminated" && agent.name.toLowerCase() === token,
    );
    for (const match of terminatedMatches) {
      recordDropped({ token, agentId: match.id, name: match.name });
    }
  }
  return {
    agentIds: [...resolved],
    ambiguousTokens,
    droppedMentions: { terminated: droppedTerminated },
  };
}

/** Decodes HTML character references in a raw @mention capture so UI-encoded bodies match agent names. */
export function normalizeAgentMentionToken(raw: string): string {
  let s = raw.replace(/&#x([0-9a-fA-F]+);/gi, (full, hex: string) => decodeNumericHtmlEntity(hex, 16) ?? full);
  s = s.replace(/&#([0-9]+);/g, (full, dec: string) => decodeNumericHtmlEntity(dec, 10) ?? full);
  s = s.replace(/&([a-z][a-z0-9]*);/gi, (full, name: string) => {
    const decoded = WELL_KNOWN_NAMED_HTML_ENTITIES[name.toLowerCase()];
    return decoded !== undefined ? decoded : full;
  });
  return s.trim();
}

export function deriveIssueUserContext(
  issue: IssueUserContextInput,
  userId: string,
  stats:
    | {
      myLastCommentAt: Date | string | null;
      myLastReadAt: Date | string | null;
      lastExternalCommentAt: Date | string | null;
    }
    | null
    | undefined,
) {
  const normalizeDate = (value: Date | string | null | undefined) => {
    if (!value) return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  };

  const myLastCommentAt = normalizeDate(stats?.myLastCommentAt);
  const myLastReadAt = normalizeDate(stats?.myLastReadAt);
  const createdTouchAt = issue.createdByUserId === userId ? normalizeDate(issue.createdAt) : null;
  const assignedTouchAt = issue.assigneeUserId === userId ? normalizeDate(issue.updatedAt) : null;
  const myLastTouchAt = [myLastCommentAt, myLastReadAt, createdTouchAt, assignedTouchAt]
    .filter((value): value is Date => value instanceof Date)
    .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  const lastExternalCommentAt = normalizeDate(stats?.lastExternalCommentAt);
  const isUnreadForMe = Boolean(
    myLastTouchAt &&
    lastExternalCommentAt &&
    lastExternalCommentAt.getTime() > myLastTouchAt.getTime(),
  );

  return {
    myLastTouchAt,
    lastExternalCommentAt,
    isUnreadForMe,
  };
}

function latestIssueActivityAt(...values: Array<Date | string | null | undefined>): Date | null {
  const normalized = values
    .map((value) => {
      if (!value) return null;
      if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    })
    .filter((value): value is Date => value instanceof Date)
    .sort((a, b) => b.getTime() - a.getTime());
  return normalized[0] ?? null;
}

async function labelMapForIssues(dbOrTx: any, issueIds: string[]): Promise<Map<string, IssueLabelRow[]>> {
  const map = new Map<string, IssueLabelRow[]>();
  if (issueIds.length === 0) return map;
  for (const issueIdChunk of chunkList(issueIds, ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const rows = await dbOrTx
      .select({
        issueId: issueLabels.issueId,
        label: labels,
      })
      .from(issueLabels)
      .innerJoin(labels, eq(issueLabels.labelId, labels.id))
      .where(inArray(issueLabels.issueId, issueIdChunk))
      .orderBy(asc(labels.name), asc(labels.id));

    for (const row of rows) {
      const existing = map.get(row.issueId);
      if (existing) existing.push(row.label);
      else map.set(row.issueId, [row.label]);
    }
  }
  return map;
}

async function withIssueLabels(dbOrTx: any, rows: IssueRow[]): Promise<IssueWithLabels[]> {
  if (rows.length === 0) return [];
  const labelsByIssueId = await labelMapForIssues(dbOrTx, rows.map((row) => row.id));
  return rows.map((row) => {
    const issueLabels = labelsByIssueId.get(row.id) ?? [];
    return {
      ...row,
      labels: issueLabels,
      labelIds: issueLabels.map((label) => label.id),
    };
  });
}

const ACTIVE_RUN_STATUSES = ["queued", "running", "scheduled_retry"];

async function activeRunMapForIssues(
  dbOrTx: any,
  issueRows: IssueWithLabels[],
): Promise<Map<string, IssueActiveRunRow>> {
  const map = new Map<string, IssueActiveRunRow>();
  const issueIds = issueRows.map((row) => row.id);
  const runIds = issueRows
    .map((row) => row.executionRunId)
    .filter((id): id is string => id != null);

  for (const runIdChunk of chunkList([...new Set(runIds)], ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const rows = await dbOrTx
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        agentId: heartbeatRuns.agentId,
        invocationSource: heartbeatRuns.invocationSource,
        triggerDetail: heartbeatRuns.triggerDetail,
        startedAt: heartbeatRuns.startedAt,
        finishedAt: heartbeatRuns.finishedAt,
        createdAt: heartbeatRuns.createdAt,
      })
      .from(heartbeatRuns)
      .where(
        and(
          inArray(heartbeatRuns.id, runIdChunk),
          inArray(heartbeatRuns.status, ACTIVE_RUN_STATUSES),
        ),
      );

    for (const row of rows) {
      map.set(row.id, row);
    }
  }
  for (const issueIdChunk of chunkList(issueIds, ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const rows = await dbOrTx
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        agentId: heartbeatRuns.agentId,
        invocationSource: heartbeatRuns.invocationSource,
        triggerDetail: heartbeatRuns.triggerDetail,
        startedAt: heartbeatRuns.startedAt,
        finishedAt: heartbeatRuns.finishedAt,
        createdAt: heartbeatRuns.createdAt,
        issueId: sql<string>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`,
      })
      .from(heartbeatRuns)
      .where(
        and(
          inArray(heartbeatRuns.status, ACTIVE_RUN_STATUSES),
          inArray(sql<string>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`, issueIdChunk),
        ),
      )
      .orderBy(
        sql`case when ${heartbeatRuns.status} = 'running' then 0 when ${heartbeatRuns.status} = 'queued' then 1 else 2 end`,
        asc(heartbeatRuns.createdAt),
      );

    for (const row of rows) {
      if (!row.issueId || map.has(row.issueId)) continue;
      map.set(row.issueId, row);
    }
  }
  return map;
}

function withActiveRuns(
  issueRows: IssueWithLabels[],
  runMap: Map<string, IssueActiveRunRow>,
): IssueWithLabelsAndRun[] {
  return issueRows.map((row) => ({
    ...row,
    activeRun: (row.executionRunId ? (runMap.get(row.executionRunId) ?? null) : null) ?? runMap.get(row.id) ?? null,
  }));
}

async function userCommentStatsForIssues(
  dbOrTx: any,
  companyId: string,
  userId: string,
  issueIds: string[],
): Promise<IssueUserCommentStats[]> {
  const stats: IssueUserCommentStats[] = [];
  for (const issueIdChunk of chunkList(issueIds, ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const rows = await dbOrTx
      .select({
        issueId: issueComments.issueId,
        myLastCommentAt: sql<Date | null>`
          MAX(CASE WHEN ${issueComments.authorUserId} = ${userId} THEN ${issueComments.createdAt} END)
        `,
        lastExternalCommentAt: sql<Date | null>`
          MAX(
            CASE
              WHEN ${issueComments.authorUserId} IS NULL OR ${issueComments.authorUserId} <> ${userId}
              THEN ${issueComments.createdAt}
            END
          )
        `,
      })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.companyId, companyId),
          inArray(issueComments.issueId, issueIdChunk),
        ),
      )
      .groupBy(issueComments.issueId);
    stats.push(...rows);
  }
  return stats;
}

async function userReadStatsForIssues(
  dbOrTx: any,
  companyId: string,
  userId: string,
  issueIds: string[],
): Promise<IssueReadStat[]> {
  const stats: IssueReadStat[] = [];
  for (const issueIdChunk of chunkList(issueIds, ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const rows = await dbOrTx
      .select({
        issueId: issueReadStates.issueId,
        myLastReadAt: issueReadStates.lastReadAt,
      })
      .from(issueReadStates)
      .where(
        and(
          eq(issueReadStates.companyId, companyId),
          eq(issueReadStates.userId, userId),
          inArray(issueReadStates.issueId, issueIdChunk),
        ),
      );
    stats.push(...rows);
  }
  return stats;
}

async function lastActivityStatsForIssues(
  dbOrTx: any,
  companyId: string,
  issueIds: string[],
): Promise<IssueLastActivityStat[]> {
  const byIssueId = new Map<string, IssueLastActivityStat>();
  for (const issueIdChunk of chunkList(issueIds, ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const [commentRows, logRows] = await Promise.all([
      dbOrTx
        .select({
          issueId: issueComments.issueId,
          latestCommentAt: sql<Date | null>`MAX(${issueComments.createdAt})`,
        })
        .from(issueComments)
        .where(
          and(
            eq(issueComments.companyId, companyId),
            inArray(issueComments.issueId, issueIdChunk),
          ),
        )
        .groupBy(issueComments.issueId),
      dbOrTx
        .select({
          issueId: activityLog.entityId,
          latestLogAt: sql<Date | null>`MAX(${activityLog.createdAt})`,
        })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, companyId),
            eq(activityLog.entityType, "issue"),
            inArray(activityLog.entityId, issueIdChunk),
            sql`${activityLog.action} NOT IN (${sql.join(
              ISSUE_LOCAL_INBOX_ACTIVITY_ACTIONS.map((action) => sql`${action}`),
              sql`, `,
            )})`,
          ),
        )
        .groupBy(activityLog.entityId),
    ]);

    for (const row of commentRows) {
      byIssueId.set(row.issueId, {
        issueId: row.issueId,
        latestCommentAt: row.latestCommentAt,
        latestLogAt: null,
      });
    }
    for (const row of logRows) {
      const existing = byIssueId.get(row.issueId);
      if (existing) existing.latestLogAt = row.latestLogAt;
      else {
        byIssueId.set(row.issueId, {
          issueId: row.issueId,
          latestCommentAt: null,
          latestLogAt: row.latestLogAt,
        });
      }
    }
  }
  return [...byIssueId.values()];
}

export function issueService(db: Db) {
  const instanceSettings = instanceSettingsService(db);
  const treeControlSvc = issueTreeControlService(db);

  async function getIssueByUuid(id: string) {
    const row = await db
      .select()
      .from(issues)
      .where(eq(issues.id, id))
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
    const [enriched] = await withIssueLabels(db, [row]);
    return enriched;
  }

  async function getIssueByIdentifier(identifier: string) {
    const row = await db
      .select()
      .from(issues)
      .where(eq(issues.identifier, identifier.toUpperCase()))
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
    const [enriched] = await withIssueLabels(db, [row]);
    return enriched;
  }

  function redactIssueComment<T extends { body: string }>(comment: T, censorUsernameInLogs: boolean): T {
    return {
      ...comment,
      body: redactCurrentUserText(comment.body, { enabled: censorUsernameInLogs }),
    };
  }

  async function assertAssignableAgent(companyId: string, agentId: string) {
    const assignee = await db
      .select({
        id: agents.id,
        companyId: agents.companyId,
        status: agents.status,
      })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);

    if (!assignee) throw notFound("Assignee agent not found");
    if (assignee.companyId !== companyId) {
      throw unprocessable("Assignee must belong to same company");
    }
    if (assignee.status === "pending_approval") {
      throw conflict("Cannot assign work to pending approval agents");
    }
    if (assignee.status === "terminated") {
      throw conflict("Cannot assign work to terminated agents");
    }
  }

  async function isTreeHoldInteractionCheckoutAllowed(
    companyId: string,
    checkoutRunId: string | null,
    _gate: ActiveIssueTreePauseHoldGate,
  ) {
    if (!checkoutRunId) return false;
    const run = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.id, checkoutRunId), eq(heartbeatRuns.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    const wakeReason =
      readStringFromRecord(run?.contextSnapshot, "wakeReason") ??
      readStringFromRecord(run?.contextSnapshot, "reason");
    return Boolean(
      wakeReason &&
      ISSUE_TREE_CONTROL_INTERACTION_WAKE_REASONS.has(wakeReason) &&
      readLatestWakeCommentId(run?.contextSnapshot),
    );
  }

  async function assertAssignableUser(companyId: string, userId: string) {
    const membership = await db
      .select({ id: companyMemberships.id })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, userId),
          eq(companyMemberships.status, "active"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!membership) {
      throw notFound("Assignee user not found");
    }
  }

  async function assertValidProject(
    companyId: string,
    projectId: string,
    dbOrTx: DbReader = db,
  ) {
    const project = await dbOrTx
      .select({ id: projects.id, companyId: projects.companyId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .then((rows) => rows[0] ?? null);
    if (!project) throw notFound("Project not found");
    if (project.companyId !== companyId) throw unprocessable("Project must belong to same company");
  }

  async function resolveProjectIdFromProjectWorkspace(
    companyId: string,
    projectWorkspaceId: string | null | undefined,
    dbOrTx: DbReader = db,
  ) {
    if (!projectWorkspaceId) return null;
    const workspace = await dbOrTx
      .select({
        id: projectWorkspaces.id,
        companyId: projectWorkspaces.companyId,
        projectId: projectWorkspaces.projectId,
      })
      .from(projectWorkspaces)
      .where(eq(projectWorkspaces.id, projectWorkspaceId))
      .then((rows) => rows[0] ?? null);
    if (!workspace) throw notFound("Project workspace not found");
    if (workspace.companyId !== companyId) {
      throw unprocessable("Project workspace must belong to same company");
    }
    return workspace.projectId;
  }

  async function resolveProjectIdFromExecutionWorkspace(
    companyId: string,
    executionWorkspaceId: string | null | undefined,
    dbOrTx: DbReader = db,
  ) {
    if (!executionWorkspaceId) return null;
    const workspace = await dbOrTx
      .select({
        id: executionWorkspaces.id,
        companyId: executionWorkspaces.companyId,
        projectId: executionWorkspaces.projectId,
      })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, executionWorkspaceId))
      .then((rows) => rows[0] ?? null);
    if (!workspace) throw notFound("Execution workspace not found");
    if (workspace.companyId !== companyId) {
      throw unprocessable("Execution workspace must belong to same company");
    }
    return workspace.projectId;
  }

  async function resolveProjectIdFromParentIssue(
    companyId: string,
    parentId: string | null | undefined,
    dbOrTx: DbReader = db,
  ) {
    if (!parentId) return null;
    const parent = await dbOrTx
      .select({
        id: issues.id,
        companyId: issues.companyId,
        projectId: issues.projectId,
      })
      .from(issues)
      .where(eq(issues.id, parentId))
      .then((rows) => rows[0] ?? null);
    if (!parent) throw notFound("Parent issue not found");
    if (parent.companyId !== companyId) throw unprocessable("Parent issue must belong to same company");
    return parent.projectId;
  }

  async function resolveProjectIdFromSingleExecutionScope(
    companyId: string,
    assigneeAgentId: string | null | undefined,
    dbOrTx: DbReader = db,
  ) {
    if (!assigneeAgentId) return null;
    const now = new Date();
    const rows = await dbOrTx
      .select({
        projectId: agentProjectScopes.projectId,
      })
      .from(agentProjectScopes)
      .where(
        and(
          eq(agentProjectScopes.companyId, companyId),
          eq(agentProjectScopes.agentId, assigneeAgentId),
          eq(agentProjectScopes.scopeMode, "execution"),
          or(isNull(agentProjectScopes.activeTo), gt(agentProjectScopes.activeTo, now)),
        ),
      );
    const distinctProjectIds = [...new Set(rows.map((row) => row.projectId))];
    return distinctProjectIds.length === 1 ? distinctProjectIds[0] : null;
  }

  async function resolveRequiredProjectId(
    {
      companyId,
      explicitProjectId,
      projectWorkspaceId,
      executionWorkspaceId,
      parentId,
      assigneeAgentId,
      fallbackProjectId,
    }: {
      companyId: string;
      explicitProjectId?: string | null;
      projectWorkspaceId?: string | null;
      executionWorkspaceId?: string | null;
      parentId?: string | null;
      assigneeAgentId?: string | null;
      fallbackProjectId?: string | null;
    },
    dbOrTx: DbReader = db,
  ) {
    if (explicitProjectId) {
      await assertValidProject(companyId, explicitProjectId, dbOrTx);
      return explicitProjectId;
    }
    const projectWorkspaceProjectId = await resolveProjectIdFromProjectWorkspace(companyId, projectWorkspaceId, dbOrTx);
    if (projectWorkspaceProjectId) return projectWorkspaceProjectId;
    const executionWorkspaceProjectId = await resolveProjectIdFromExecutionWorkspace(companyId, executionWorkspaceId, dbOrTx);
    if (executionWorkspaceProjectId) return executionWorkspaceProjectId;
    const parentProjectId = await resolveProjectIdFromParentIssue(companyId, parentId, dbOrTx);
    if (parentProjectId) return parentProjectId;
    if (fallbackProjectId) return fallbackProjectId;
    const singleScopeProjectId = await resolveProjectIdFromSingleExecutionScope(companyId, assigneeAgentId, dbOrTx);
    if (singleScopeProjectId) return singleScopeProjectId;
    throw unprocessable("Issues must belong to a project");
  }

  async function assertValidProjectWorkspace(
    companyId: string,
    projectId: string | null | undefined,
    projectWorkspaceId: string,
    dbOrTx: DbReader = db,
  ) {
    const workspace = await dbOrTx
      .select({
        id: projectWorkspaces.id,
        companyId: projectWorkspaces.companyId,
        projectId: projectWorkspaces.projectId,
      })
      .from(projectWorkspaces)
      .where(eq(projectWorkspaces.id, projectWorkspaceId))
      .then((rows) => rows[0] ?? null);
    if (!workspace) throw notFound("Project workspace not found");
    if (workspace.companyId !== companyId) throw unprocessable("Project workspace must belong to same company");
    if (projectId && workspace.projectId !== projectId) {
      throw unprocessable("Project workspace must belong to the selected project");
    }
  }

  async function assertValidExecutionWorkspace(
    companyId: string,
    projectId: string | null | undefined,
    executionWorkspaceId: string,
    dbOrTx: DbReader = db,
  ) {
    const workspace = await dbOrTx
      .select({
        id: executionWorkspaces.id,
        companyId: executionWorkspaces.companyId,
        projectId: executionWorkspaces.projectId,
      })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, executionWorkspaceId))
      .then((rows) => rows[0] ?? null);
    if (!workspace) throw notFound("Execution workspace not found");
    if (workspace.companyId !== companyId) throw unprocessable("Execution workspace must belong to same company");
    if (projectId && workspace.projectId !== projectId) {
      throw unprocessable("Execution workspace must belong to the selected project");
    }
  }

  async function assertValidLabelIds(companyId: string, labelIds: string[], dbOrTx: any = db) {
    if (labelIds.length === 0) return;
    const existing = await dbOrTx
      .select({ id: labels.id })
      .from(labels)
      .where(and(eq(labels.companyId, companyId), inArray(labels.id, labelIds)));
    if (existing.length !== new Set(labelIds).size) {
      throw unprocessable("One or more labels are invalid for this company");
    }
  }

  async function syncIssueLabels(
    issueId: string,
    companyId: string,
    labelIds: string[],
    dbOrTx: any = db,
  ) {
    const deduped = [...new Set(labelIds)];
    await assertValidLabelIds(companyId, deduped, dbOrTx);
    await dbOrTx.delete(issueLabels).where(eq(issueLabels.issueId, issueId));
    if (deduped.length === 0) return;
    await dbOrTx.insert(issueLabels).values(
      deduped.map((labelId) => ({
        issueId,
        labelId,
        companyId,
      })),
    );
  }

  async function getIssueRelationSummaryMap(
    companyId: string,
    issueIds: string[],
    dbOrTx: DbReader = db,
  ): Promise<Map<string, IssueRelationSummaryMap>> {
    const uniqueIssueIds = [...new Set(issueIds)];
    const empty = new Map<string, IssueRelationSummaryMap>();
    for (const issueId of uniqueIssueIds) {
      empty.set(issueId, { blockedBy: [], blocks: [] });
    }
    if (uniqueIssueIds.length === 0) return empty;

    const [blockedByRows, blockingRows] = await Promise.all([
      dbOrTx
        .select({
          currentIssueId: issueRelations.relatedIssueId,
          relatedId: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          priority: issues.priority,
          assigneeAgentId: issues.assigneeAgentId,
          assigneeUserId: issues.assigneeUserId,
        })
        .from(issueRelations)
        .innerJoin(issues, eq(issueRelations.issueId, issues.id))
        .where(
          and(
            eq(issueRelations.companyId, companyId),
            eq(issueRelations.type, "blocks"),
            inArray(issueRelations.relatedIssueId, uniqueIssueIds),
          ),
        ),
      dbOrTx
        .select({
          currentIssueId: issueRelations.issueId,
          relatedId: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          priority: issues.priority,
          assigneeAgentId: issues.assigneeAgentId,
          assigneeUserId: issues.assigneeUserId,
        })
        .from(issueRelations)
        .innerJoin(issues, eq(issueRelations.relatedIssueId, issues.id))
        .where(
          and(
            eq(issueRelations.companyId, companyId),
            eq(issueRelations.type, "blocks"),
            inArray(issueRelations.issueId, uniqueIssueIds),
          ),
        ),
    ]);

    for (const row of blockedByRows) {
      empty.get(row.currentIssueId)?.blockedBy.push({
        id: row.relatedId,
        identifier: row.identifier,
        title: row.title,
        status: row.status as IssueRelationIssueSummary["status"],
        priority: row.priority as IssueRelationIssueSummary["priority"],
        assigneeAgentId: row.assigneeAgentId,
        assigneeUserId: row.assigneeUserId,
      });
    }
    for (const row of blockingRows) {
      empty.get(row.currentIssueId)?.blocks.push({
        id: row.relatedId,
        identifier: row.identifier,
        title: row.title,
        status: row.status as IssueRelationIssueSummary["status"],
        priority: row.priority as IssueRelationIssueSummary["priority"],
        assigneeAgentId: row.assigneeAgentId,
        assigneeUserId: row.assigneeUserId,
      });
    }

    for (const relations of empty.values()) {
      relations.blockedBy.sort((a, b) => a.title.localeCompare(b.title));
      relations.blocks.sort((a, b) => a.title.localeCompare(b.title));
    }

    return empty;
  }

  async function assertNoBlockingCycles(
    companyId: string,
    issueId: string,
    blockerIssueIds: string[],
    dbOrTx: DbReader = db,
  ) {
    if (blockerIssueIds.length === 0) return;

    const rows = await dbOrTx
      .select({
        blockerIssueId: issueRelations.issueId,
        blockedIssueId: issueRelations.relatedIssueId,
      })
      .from(issueRelations)
      .where(and(eq(issueRelations.companyId, companyId), eq(issueRelations.type, "blocks")));

    const adjacency = new Map<string, string[]>();
    for (const row of rows) {
      const list = adjacency.get(row.blockerIssueId) ?? [];
      list.push(row.blockedIssueId);
      adjacency.set(row.blockerIssueId, list);
    }

    for (const blockerIssueId of blockerIssueIds) {
      const queue = [...(adjacency.get(issueId) ?? [])];
      const visited = new Set<string>([issueId]);
      while (queue.length > 0) {
        const current = queue.shift()!;
        if (current === blockerIssueId) {
          throw unprocessable("Blocking relations cannot contain cycles");
        }
        if (visited.has(current)) continue;
        visited.add(current);
        queue.push(...(adjacency.get(current) ?? []));
      }
    }
  }

  async function syncBlockedByIssueIds(
    issueId: string,
    companyId: string,
    blockedByIssueIds: string[],
    actor: { agentId?: string | null; userId?: string | null } = {},
    dbOrTx: any = db,
  ) {
    const deduped = [...new Set(blockedByIssueIds)];
    if (deduped.some((candidate) => candidate === issueId)) {
      throw unprocessable("Issue cannot be blocked by itself");
    }

    if (deduped.length > 0) {
      const lockedIssueIds = [issueId, ...deduped].sort();
      await dbOrTx.execute(
        sql`SELECT ${issues.id} FROM ${issues}
            WHERE ${and(eq(issues.companyId, companyId), inArray(issues.id, lockedIssueIds))}
            ORDER BY ${issues.id}
            FOR UPDATE`,
      );
      const relatedIssues = await dbOrTx
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), inArray(issues.id, deduped)));
      if (relatedIssues.length !== deduped.length) {
        throw unprocessable("Blocked-by issues must belong to the same company");
      }
      await assertNoBlockingCycles(companyId, issueId, deduped, dbOrTx);
    }

    await dbOrTx
      .delete(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.relatedIssueId, issueId),
          eq(issueRelations.type, "blocks"),
        ),
      );

    if (deduped.length === 0) return;

    await dbOrTx.insert(issueRelations).values(
      deduped.map((blockerIssueId) => ({
        companyId,
        issueId: blockerIssueId,
        relatedIssueId: issueId,
        type: "blocks",
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.userId ?? null,
      })),
    );
  }

  async function isTerminalOrMissingHeartbeatRun(runId: string) {
    const run = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    if (!run) return true;
    return TERMINAL_HEARTBEAT_RUN_STATUSES.has(run.status);
  }

  async function adoptStaleCheckoutRun(input: {
    issueId: string;
    actorAgentId: string;
    actorRunId: string;
    expectedCheckoutRunId: string;
  }) {
    const stale = await isTerminalOrMissingHeartbeatRun(input.expectedCheckoutRunId);
    if (!stale) return null;

    const now = new Date();
    const adopted = await db
      .update(issues)
      .set({
        checkoutRunId: input.actorRunId,
        executionRunId: input.actorRunId,
        executionLockedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(issues.id, input.issueId),
          eq(issues.status, "in_progress"),
          eq(issues.assigneeAgentId, input.actorAgentId),
          eq(issues.checkoutRunId, input.expectedCheckoutRunId),
        ),
      )
      .returning({
        id: issues.id,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .then((rows) => rows[0] ?? null);

    return adopted;
  }

  async function adoptUnownedCheckoutRun(input: {
    issueId: string;
    actorAgentId: string;
    actorRunId: string;
  }) {
    const now = new Date();
    const adopted = await db
      .update(issues)
      .set({
        checkoutRunId: input.actorRunId,
        executionRunId: input.actorRunId,
        executionLockedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(issues.id, input.issueId),
          eq(issues.status, "in_progress"),
          eq(issues.assigneeAgentId, input.actorAgentId),
          isNull(issues.checkoutRunId),
          or(isNull(issues.executionRunId), eq(issues.executionRunId, input.actorRunId)),
        ),
      )
      .returning({
        id: issues.id,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .then((rows) => rows[0] ?? null);

    return adopted;
  }

  async function clearExecutionRunIfTerminal(issueId: string): Promise<boolean> {
    return db.transaction(async (tx) => {
      await tx.execute(
        sql`select ${issues.id} from ${issues} where ${issues.id} = ${issueId} for update`,
      );
      const issue = await tx
        .select({ executionRunId: issues.executionRunId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      if (!issue?.executionRunId) return false;

      await tx.execute(
        sql`select ${heartbeatRuns.id} from ${heartbeatRuns} where ${heartbeatRuns.id} = ${issue.executionRunId} for update`,
      );
      const run = await tx
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, issue.executionRunId))
        .then((rows) => rows[0] ?? null);
      if (run && !TERMINAL_HEARTBEAT_RUN_STATUSES.has(run.status)) return false;

      const updated = await tx
        .update(issues)
        .set({
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(issues.id, issueId),
            eq(issues.executionRunId, issue.executionRunId),
          ),
        )
        .returning({ id: issues.id })
        .then((rows) => rows[0] ?? null);

      return Boolean(updated);
    });
  }

  return {
    clearExecutionRunIfTerminal,

    list: async (companyId: string, filters?: IssueFilters) => {
      const conditions = [eq(issues.companyId, companyId)];
      const limit = typeof filters?.limit === "number" && Number.isFinite(filters.limit)
        ? clampIssueListLimit(filters.limit)
        : undefined;
      const touchedByUserId = filters?.touchedByUserId?.trim() || undefined;
      const inboxArchivedByUserId = filters?.inboxArchivedByUserId?.trim() || undefined;
      const unreadForUserId = filters?.unreadForUserId?.trim() || undefined;
      const contextUserId = unreadForUserId ?? touchedByUserId ?? inboxArchivedByUserId;
      const rawSearch = filters?.q?.trim() ?? "";
      const hasSearch = rawSearch.length > 0;
      const escapedSearch = hasSearch ? escapeLikePattern(rawSearch) : "";
      const startsWithPattern = `${escapedSearch}%`;
      const containsPattern = `%${escapedSearch}%`;
      const titleStartsWithMatch = sql<boolean>`${issues.title} ILIKE ${startsWithPattern} ESCAPE '\\'`;
      const titleContainsMatch = sql<boolean>`${issues.title} ILIKE ${containsPattern} ESCAPE '\\'`;
      const identifierStartsWithMatch = sql<boolean>`${issues.identifier} ILIKE ${startsWithPattern} ESCAPE '\\'`;
      const identifierContainsMatch = sql<boolean>`${issues.identifier} ILIKE ${containsPattern} ESCAPE '\\'`;
      const descriptionContainsMatch = sql<boolean>`${issues.description} ILIKE ${containsPattern} ESCAPE '\\'`;
      const commentContainsMatch = sql<boolean>`
        EXISTS (
          SELECT 1
          FROM ${issueComments}
          WHERE ${issueComments.issueId} = ${issues.id}
            AND ${issueComments.companyId} = ${companyId}
            AND ${issueComments.body} ILIKE ${containsPattern} ESCAPE '\\'
        )
      `;
      if (filters?.descendantOf) {
        conditions.push(sql<boolean>`
          ${issues.id} IN (
            WITH RECURSIVE descendants(id) AS (
              SELECT ${issues.id}
              FROM ${issues}
              WHERE ${issues.companyId} = ${companyId}
                AND ${issues.parentId} = ${filters.descendantOf}
              UNION
              SELECT ${issues.id}
              FROM ${issues}
              JOIN descendants ON ${issues.parentId} = descendants.id
              WHERE ${issues.companyId} = ${companyId}
            )
            SELECT id FROM descendants
          )
        `);
      }
      if (filters?.status) {
        const statuses = filters.status.split(",").map((s) => s.trim());
        conditions.push(statuses.length === 1 ? eq(issues.status, statuses[0]) : inArray(issues.status, statuses));
      }
      if (filters?.assigneeAgentId) {
        conditions.push(eq(issues.assigneeAgentId, filters.assigneeAgentId));
      }
      if (filters?.participantAgentId) {
        conditions.push(participatedByAgentCondition(companyId, filters.participantAgentId));
      }
      if (filters?.assigneeUserId) {
        conditions.push(eq(issues.assigneeUserId, filters.assigneeUserId));
      }
      if (touchedByUserId) {
        conditions.push(touchedByUserCondition(companyId, touchedByUserId));
      }
      if (inboxArchivedByUserId) {
        conditions.push(inboxVisibleForUserCondition(companyId, inboxArchivedByUserId));
      }
      if (unreadForUserId) {
        conditions.push(unreadForUserCondition(companyId, unreadForUserId));
      }
      if (filters?.projectId) conditions.push(eq(issues.projectId, filters.projectId));
      if (filters?.executionWorkspaceId) {
        conditions.push(eq(issues.executionWorkspaceId, filters.executionWorkspaceId));
      }
      if (filters?.parentId) conditions.push(eq(issues.parentId, filters.parentId));
      if (filters?.originKind) conditions.push(eq(issues.originKind, filters.originKind));
      if (filters?.originId) conditions.push(eq(issues.originId, filters.originId));
      if (filters?.labelId) {
        const labeledIssueIds = await db
          .select({ issueId: issueLabels.issueId })
          .from(issueLabels)
          .where(and(eq(issueLabels.companyId, companyId), eq(issueLabels.labelId, filters.labelId)));
        if (labeledIssueIds.length === 0) return [];
        conditions.push(inArray(issues.id, labeledIssueIds.map((row) => row.issueId)));
      }
      if (hasSearch) {
        conditions.push(
          or(
            titleContainsMatch,
            identifierContainsMatch,
            descriptionContainsMatch,
            commentContainsMatch,
          )!,
        );
      }
      if (!filters?.includeRoutineExecutions && !filters?.originKind && !filters?.originId) {
        conditions.push(ne(issues.originKind, "routine_execution"));
      }
      conditions.push(isNull(issues.hiddenAt));

      const priorityOrder = sql`CASE ${issues.priority} WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`;
      const searchOrder = sql<number>`
        CASE
          WHEN ${titleStartsWithMatch} THEN 0
          WHEN ${titleContainsMatch} THEN 1
          WHEN ${identifierStartsWithMatch} THEN 2
          WHEN ${identifierContainsMatch} THEN 3
          WHEN ${commentContainsMatch} THEN 4
          WHEN ${descriptionContainsMatch} THEN 5
          ELSE 6
        END
      `;
      const canonicalLastActivityAt = issueCanonicalLastActivityAtExpr(companyId);
      const baseQuery = db
        .select()
        .from(issues)
        .where(and(...conditions))
        .orderBy(
          hasSearch ? asc(searchOrder) : asc(priorityOrder),
          asc(priorityOrder),
          desc(canonicalLastActivityAt),
          desc(issues.updatedAt),
        );
      const rows = limit === undefined ? await baseQuery : await baseQuery.limit(limit);
      const withLabels = await withIssueLabels(db, rows);
      const runMap = await activeRunMapForIssues(db, withLabels);
      const withRuns = withActiveRuns(withLabels, runMap);
      if (withRuns.length === 0) {
        return withRuns;
      }

      const issueIds = withRuns.map((row) => row.id);
      const [statsRows, readRows, lastActivityRows] = await Promise.all([
        contextUserId
          ? userCommentStatsForIssues(db, companyId, contextUserId, issueIds)
          : Promise.resolve([]),
        contextUserId
          ? userReadStatsForIssues(db, companyId, contextUserId, issueIds)
          : Promise.resolve([]),
        lastActivityStatsForIssues(db, companyId, issueIds),
      ]);
      const statsByIssueId = new Map(statsRows.map((row) => [row.issueId, row]));
      const lastActivityByIssueId = new Map(lastActivityRows.map((row) => [row.issueId, row]));

      if (!contextUserId) {
        return withRuns.map((row) => {
          const activity = lastActivityByIssueId.get(row.id);
          const lastActivityAt = latestIssueActivityAt(
            row.updatedAt,
            activity?.latestCommentAt ?? null,
            activity?.latestLogAt ?? null,
          ) ?? row.updatedAt;
          return {
            ...row,
            lastActivityAt,
          };
        });
      }

      const readByIssueId = new Map(readRows.map((row) => [row.issueId, row.myLastReadAt]));

      return withRuns.map((row) => {
        const activity = lastActivityByIssueId.get(row.id);
        const lastActivityAt = latestIssueActivityAt(
          row.updatedAt,
          activity?.latestCommentAt ?? null,
          activity?.latestLogAt ?? null,
        ) ?? row.updatedAt;
        return {
          ...row,
          lastActivityAt,
          ...deriveIssueUserContext(row, contextUserId, {
            myLastCommentAt: statsByIssueId.get(row.id)?.myLastCommentAt ?? null,
            myLastReadAt: readByIssueId.get(row.id) ?? null,
            lastExternalCommentAt: statsByIssueId.get(row.id)?.lastExternalCommentAt ?? null,
          }),
        };
      });
    },

    countUnreadTouchedByUser: async (companyId: string, userId: string, status?: string) => {
      const conditions = [
        eq(issues.companyId, companyId),
        isNull(issues.hiddenAt),
        unreadForUserCondition(companyId, userId),
        ne(issues.originKind, "routine_execution"),
      ];
      if (status) {
        const statuses = status.split(",").map((s) => s.trim()).filter(Boolean);
        if (statuses.length === 1) {
          conditions.push(eq(issues.status, statuses[0]));
        } else if (statuses.length > 1) {
          conditions.push(inArray(issues.status, statuses));
        }
      }
      const [row] = await db
        .select({ count: sql<number>`count(*)` })
        .from(issues)
        .where(and(...conditions));
      return Number(row?.count ?? 0);
    },

    markRead: async (companyId: string, issueId: string, userId: string, readAt: Date = new Date()) => {
      const now = new Date();
      const [row] = await db
        .insert(issueReadStates)
        .values({
          companyId,
          issueId,
          userId,
          lastReadAt: readAt,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [issueReadStates.companyId, issueReadStates.issueId, issueReadStates.userId],
          set: {
            lastReadAt: readAt,
            updatedAt: now,
          },
        })
        .returning();
      return row;
    },

    markUnread: async (companyId: string, issueId: string, userId: string) => {
      const deleted = await db
        .delete(issueReadStates)
        .where(
          and(
            eq(issueReadStates.companyId, companyId),
            eq(issueReadStates.issueId, issueId),
            eq(issueReadStates.userId, userId),
          ),
        )
        .returning();
      return deleted.length > 0;
    },

    archiveInbox: async (companyId: string, issueId: string, userId: string, archivedAt: Date = new Date()) => {
      const now = new Date();
      const [row] = await db
        .insert(issueInboxArchives)
        .values({
          companyId,
          issueId,
          userId,
          archivedAt,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [issueInboxArchives.companyId, issueInboxArchives.issueId, issueInboxArchives.userId],
          set: {
            archivedAt,
            updatedAt: now,
          },
        })
        .returning();
      return row;
    },

    unarchiveInbox: async (companyId: string, issueId: string, userId: string) => {
      const [row] = await db
        .delete(issueInboxArchives)
        .where(
          and(
            eq(issueInboxArchives.companyId, companyId),
            eq(issueInboxArchives.issueId, issueId),
            eq(issueInboxArchives.userId, userId),
          ),
        )
        .returning();
      return row ?? null;
    },

    getById: async (raw: string) => {
      const id = raw.trim();
      if (/^[A-Z]+-\d+$/i.test(id)) {
        return getIssueByIdentifier(id);
      }
      if (!isUuidLike(id)) {
        return null;
      }
      return getIssueByUuid(id);
    },

    getByIdentifier: async (identifier: string) => {
      return getIssueByIdentifier(identifier);
    },

    getRelationSummaries: async (issueId: string) => {
      const issue = await db
        .select({ id: issues.id, companyId: issues.companyId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      if (!issue) throw notFound("Issue not found");
      const relations = await getIssueRelationSummaryMap(issue.companyId, [issueId], db);
      return relations.get(issueId) ?? { blockedBy: [], blocks: [] };
    },

    getDependencyReadiness: async (issueId: string, dbOrTx: any = db) => {
      const issue = await dbOrTx
        .select({ id: issues.id, companyId: issues.companyId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows: Array<{ id: string; companyId: string }>) => rows[0] ?? null);
      if (!issue) throw notFound("Issue not found");
      const readiness = await listIssueDependencyReadinessMap(dbOrTx, issue.companyId, [issueId]);
      return readiness.get(issueId) ?? createIssueDependencyReadiness(issueId);
    },

    listDependencyReadiness: async (companyId: string, issueIds: string[], dbOrTx: any = db) => {
      return listIssueDependencyReadinessMap(dbOrTx, companyId, issueIds);
    },

    listBlockerWaitingOnInfo: async (
      companyId: string,
      blockerIssueIds: string[],
    ): Promise<Map<string, { identifier: string | null; openChildCount: number }>> => {
      if (blockerIssueIds.length === 0) return new Map();
      const blockerRows = await db
        .select({ id: issues.id, identifier: issues.identifier })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), inArray(issues.id, blockerIssueIds)));
      const childrenRows = await db
        .select({
          parentId: issues.parentId,
          count: sql<number>`count(*)::int`,
        })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            inArray(issues.parentId, blockerIssueIds),
            not(inArray(issues.status, ["done", "cancelled"])),
            isNull(issues.hiddenAt),
          ),
        )
        .groupBy(issues.parentId);
      const childCountByBlockerId = new Map<string, number>();
      for (const row of childrenRows) {
        if (row.parentId) childCountByBlockerId.set(row.parentId, Number(row.count));
      }
      const result = new Map<string, { identifier: string | null; openChildCount: number }>();
      for (const row of blockerRows) {
        result.set(row.id, {
          identifier: row.identifier ?? null,
          openChildCount: childCountByBlockerId.get(row.id) ?? 0,
        });
      }
      return result;
    },

    listWakeableBlockedDependents: async (blockerIssueId: string) => {
      const blockerIssue = await db
        .select({ id: issues.id, companyId: issues.companyId })
        .from(issues)
        .where(eq(issues.id, blockerIssueId))
        .then((rows) => rows[0] ?? null);
      if (!blockerIssue) return [];

      const candidates = await db
        .select({
          id: issues.id,
          assigneeAgentId: issues.assigneeAgentId,
          status: issues.status,
        })
        .from(issueRelations)
        .innerJoin(issues, eq(issueRelations.relatedIssueId, issues.id))
        .where(
          and(
            eq(issueRelations.companyId, blockerIssue.companyId),
            eq(issueRelations.type, "blocks"),
            eq(issueRelations.issueId, blockerIssueId),
          ),
        );
      if (candidates.length === 0) return [];

      const candidateIds = candidates.map((candidate) => candidate.id);
      const blockerRows = await db
        .select({
          issueId: issueRelations.relatedIssueId,
          blockerIssueId: issueRelations.issueId,
          blockerStatus: issues.status,
        })
        .from(issueRelations)
        .innerJoin(issues, eq(issueRelations.issueId, issues.id))
        .where(
          and(
            eq(issueRelations.companyId, blockerIssue.companyId),
            eq(issueRelations.type, "blocks"),
            inArray(issueRelations.relatedIssueId, candidateIds),
          ),
        );

      const blockersByIssueId = new Map<string, Array<{ blockerIssueId: string; blockerStatus: string }>>();
      for (const row of blockerRows) {
        const list = blockersByIssueId.get(row.issueId) ?? [];
        list.push({ blockerIssueId: row.blockerIssueId, blockerStatus: row.blockerStatus });
        blockersByIssueId.set(row.issueId, list);
      }

      return candidates
        .filter((candidate) => candidate.assigneeAgentId && !["backlog", "done", "cancelled"].includes(candidate.status))
        .map((candidate) => {
          const blockers = blockersByIssueId.get(candidate.id) ?? [];
          return {
            ...candidate,
            blockerIssueIds: blockers.map((blocker) => blocker.blockerIssueId),
            allBlockersDone: blockers.length > 0 && blockers.every((blocker) => blocker.blockerStatus === "done"),
          };
        })
        .filter((candidate) => candidate.allBlockersDone)
        .map((candidate) => ({
          id: candidate.id,
          assigneeAgentId: candidate.assigneeAgentId!,
          blockerIssueIds: candidate.blockerIssueIds,
        }));
    },

    getWakeableParentAfterChildCompletion: async (parentIssueId: string) => {
      const parent = await db
        .select({
          id: issues.id,
          assigneeAgentId: issues.assigneeAgentId,
          status: issues.status,
          companyId: issues.companyId,
        })
        .from(issues)
        .where(eq(issues.id, parentIssueId))
        .then((rows) => rows[0] ?? null);
      if (!parent || !parent.assigneeAgentId || ["backlog", "done", "cancelled"].includes(parent.status)) {
        return null;
      }

      const children = await db
        .select({ id: issues.id, status: issues.status })
        .from(issues)
        .where(and(eq(issues.companyId, parent.companyId), eq(issues.parentId, parentIssueId)));
      if (children.length === 0) return null;
      if (!children.every((child) => child.status === "done" || child.status === "cancelled")) {
        return null;
      }

      return {
        id: parent.id,
        assigneeAgentId: parent.assigneeAgentId,
        childIssueIds: children.map((child) => child.id),
      };
    },

    createChild: async (
      parentIssueId: string,
      data: IssueChildCreateInput,
    ) => {
      const parent = await db
        .select()
        .from(issues)
        .where(eq(issues.id, parentIssueId))
        .then((rows) => rows[0] ?? null);
      if (!parent) throw notFound("Parent issue not found");

      const [{ childCount }] = await db
        .select({ childCount: sql<number>`count(*)::int` })
        .from(issues)
        .where(and(eq(issues.companyId, parent.companyId), eq(issues.parentId, parent.id)));
      if (childCount >= MAX_CHILD_ISSUES_CREATED_BY_HELPER) {
        throw unprocessable(`Parent issue already has the maximum ${MAX_CHILD_ISSUES_CREATED_BY_HELPER} child issues for this helper`);
      }

      const {
        acceptanceCriteria,
        blockParentUntilDone,
        actorAgentId,
        actorUserId,
        ...issueData
      } = data;
      const child = await issueService(db).create(parent.companyId, {
        ...issueData,
        parentId: parent.id,
        projectId: issueData.projectId ?? parent.projectId,
        goalId: issueData.goalId ?? parent.goalId,
        requestDepth: Math.max(parent.requestDepth + 1, issueData.requestDepth ?? 0),
        description: appendAcceptanceCriteriaToDescription(issueData.description, acceptanceCriteria),
        inheritExecutionWorkspaceFromIssueId: parent.id,
      });

      if (blockParentUntilDone) {
        const existingBlockers = await db
          .select({ blockerIssueId: issueRelations.issueId })
          .from(issueRelations)
          .where(and(eq(issueRelations.companyId, parent.companyId), eq(issueRelations.relatedIssueId, parent.id), eq(issueRelations.type, "blocks")));
        await syncBlockedByIssueIds(
          parent.id,
          parent.companyId,
          [...new Set([...existingBlockers.map((row) => row.blockerIssueId), child.id])],
          { agentId: actorAgentId ?? null, userId: actorUserId ?? null },
        );
      }

      return {
        issue: child,
        parentBlockerAdded: Boolean(blockParentUntilDone),
      };
    },

    create: async (
      companyId: string,
      data: IssueCreateInput,
    ) => {
      const {
        labelIds: inputLabelIds,
        blockedByIssueIds,
        inheritExecutionWorkspaceFromIssueId,
        ...issueData
      } = data;
      const isolatedWorkspacesEnabled = (await instanceSettings.getExperimental()).enableIsolatedWorkspaces;
      const requestedStatus = issueData.status ?? "todo";
      if (!isolatedWorkspacesEnabled) {
        delete issueData.executionWorkspaceId;
        delete issueData.executionWorkspacePreference;
        delete issueData.executionWorkspaceSettings;
      }
      if (data.assigneeAgentId && data.assigneeUserId) {
        throw unprocessable("Issue can only have one assignee");
      }
      if (data.assigneeAgentId) {
        await assertAssignableAgent(companyId, data.assigneeAgentId);
      }
      if (data.assigneeUserId) {
        await assertAssignableUser(companyId, data.assigneeUserId);
      }
      if (EXECUTING_ISSUE_STATUSES.has(requestedStatus) && !data.assigneeAgentId && !data.assigneeUserId) {
        throw unprocessable(`${requestedStatus} issues require an assignee`);
      }
      return db.transaction(async (tx) => {
        const defaultCompanyGoal = await getDefaultCompanyGoal(tx, companyId);
        let projectWorkspaceId = issueData.projectWorkspaceId ?? null;
        let executionWorkspaceId = issueData.executionWorkspaceId ?? null;
        let executionWorkspacePreference = issueData.executionWorkspacePreference ?? null;
        let executionWorkspaceSettings =
          (issueData.executionWorkspaceSettings as Record<string, unknown> | null | undefined) ?? null;
        const workspaceInheritanceIssueId = inheritExecutionWorkspaceFromIssueId ?? null;
        let fallbackProjectId: string | null = null;
        const hasExplicitExecutionWorkspaceOverride =
          issueData.executionWorkspaceId !== undefined ||
          issueData.executionWorkspacePreference !== undefined ||
          issueData.executionWorkspaceSettings !== undefined;
        if (workspaceInheritanceIssueId) {
          const workspaceSource = await getWorkspaceInheritanceIssue(tx, companyId, workspaceInheritanceIssueId);
          fallbackProjectId = workspaceSource.projectId;
          if (projectWorkspaceId == null && workspaceSource.projectWorkspaceId) {
            projectWorkspaceId = workspaceSource.projectWorkspaceId;
          }
          if (
            isolatedWorkspacesEnabled &&
            !hasExplicitExecutionWorkspaceOverride &&
            workspaceSource.executionWorkspaceId
          ) {
            const sourceWorkspace = await tx
              .select({
                id: executionWorkspaces.id,
                mode: executionWorkspaces.mode,
              })
              .from(executionWorkspaces)
              .where(eq(executionWorkspaces.id, workspaceSource.executionWorkspaceId))
              .then((rows) => rows[0] ?? null);
            if (sourceWorkspace) {
              executionWorkspaceId = sourceWorkspace.id;
              executionWorkspacePreference = "reuse_existing";
              executionWorkspaceSettings = {
                ...((workspaceSource.executionWorkspaceSettings as Record<string, unknown> | null | undefined) ?? {}),
                mode: issueExecutionWorkspaceModeForPersistedWorkspace(sourceWorkspace.mode),
              };
            }
          }
        }
        const projectId = await resolveRequiredProjectId({
          companyId,
          explicitProjectId: issueData.projectId,
          projectWorkspaceId,
          executionWorkspaceId,
          parentId: issueData.parentId ?? null,
          assigneeAgentId: issueData.assigneeAgentId ?? null,
          fallbackProjectId,
        }, tx);
        const projectGoalId = await getProjectDefaultGoalId(tx, companyId, projectId);
        if (
          executionWorkspaceSettings == null &&
          executionWorkspaceId == null &&
          projectId
        ) {
          const project = await tx
            .select({ executionWorkspacePolicy: projects.executionWorkspacePolicy })
            .from(projects)
            .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
            .then((rows) => rows[0] ?? null);
          executionWorkspaceSettings =
            defaultIssueExecutionWorkspaceSettingsForProject(
              gateProjectExecutionWorkspacePolicy(
                parseProjectExecutionWorkspacePolicy(project?.executionWorkspacePolicy),
                isolatedWorkspacesEnabled,
              ),
            ) as Record<string, unknown> | null;
        }
        if (!projectWorkspaceId) {
          const project = await tx
            .select({
              executionWorkspacePolicy: projects.executionWorkspacePolicy,
            })
            .from(projects)
            .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
            .then((rows) => rows[0] ?? null);
          const projectPolicy = parseProjectExecutionWorkspacePolicy(project?.executionWorkspacePolicy);
          projectWorkspaceId = projectPolicy?.defaultProjectWorkspaceId ?? null;
          if (!projectWorkspaceId) {
            projectWorkspaceId = await tx
              .select({ id: projectWorkspaces.id })
              .from(projectWorkspaces)
              .where(and(eq(projectWorkspaces.projectId, projectId), eq(projectWorkspaces.companyId, companyId)))
              .orderBy(desc(projectWorkspaces.isPrimary), asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id))
              .then((rows) => rows[0]?.id ?? null);
          }
        }
        if (projectWorkspaceId) {
          await assertValidProjectWorkspace(companyId, projectId, projectWorkspaceId, tx);
        }
        if (executionWorkspaceId) {
          await assertValidExecutionWorkspace(companyId, projectId, executionWorkspaceId, tx);
        }
        // Self-correcting counter: use MAX(issue_number) + 1 if the counter
        // has drifted below the actual max, preventing identifier collisions.
        const [maxRow] = await tx
          .select({ maxNum: sql<number>`coalesce(max(${issues.issueNumber}), 0)` })
          .from(issues)
          .where(eq(issues.companyId, companyId));
        const currentMax = maxRow?.maxNum ?? 0;

        const [company] = await tx
          .update(companies)
          .set({
            issueCounter: sql`greatest(${companies.issueCounter}, ${currentMax}) + 1`,
          })
          .where(eq(companies.id, companyId))
          .returning({ issueCounter: companies.issueCounter, issuePrefix: companies.issuePrefix });

        const issueNumber = company.issueCounter;
        const identifier = `${company.issuePrefix}-${issueNumber}`;

        const values = {
          ...issueData,
          projectId,
          originKind: issueData.originKind ?? "manual",
          goalId: resolveIssueGoalId({
            projectId,
            goalId: issueData.goalId,
            projectGoalId,
            defaultGoalId: defaultCompanyGoal?.id ?? null,
          }),
          ...(projectWorkspaceId ? { projectWorkspaceId } : {}),
          ...(executionWorkspaceId ? { executionWorkspaceId } : {}),
          ...(executionWorkspacePreference ? { executionWorkspacePreference } : {}),
          ...(executionWorkspaceSettings ? { executionWorkspaceSettings } : {}),
          companyId,
          issueNumber,
          identifier,
        } as typeof issues.$inferInsert;
        if (values.status === "in_progress" && !values.startedAt) {
          values.startedAt = new Date();
        }
        if (values.status === "done") {
          values.completedAt = new Date();
        }
        if (values.status === "cancelled") {
          values.cancelledAt = new Date();
        }

        const [issue] = await tx.insert(issues).values(values).returning();
        if (inputLabelIds) {
          await syncIssueLabels(issue.id, companyId, inputLabelIds, tx);
        }
        if (blockedByIssueIds !== undefined) {
          await syncBlockedByIssueIds(
            issue.id,
            companyId,
            blockedByIssueIds,
            {
              agentId: issueData.createdByAgentId ?? null,
              userId: issueData.createdByUserId ?? null,
            },
            tx,
          );
        }
        const [enriched] = await withIssueLabels(tx, [issue]);
        return enriched;
      });
    },

    update: async (
      id: string,
      data: IssueUpdateInput,
      dbOrTx: any = db,
    ) => {
      const existing = await dbOrTx
        .select()
        .from(issues)
        .where(eq(issues.id, id))
        .then((rows: Array<typeof issues.$inferSelect>) => rows[0] ?? null);
      if (!existing) return null;

      const {
        labelIds: nextLabelIds,
        blockedByIssueIds,
        actorAgentId,
        actorUserId,
        projectId: requestedProjectId,
        ...patchableIssueData
      } = data;
      if (requestedProjectId === null) {
        throw unprocessable("Issues must belong to a project");
      }
      const isolatedWorkspacesEnabled = (await instanceSettings.getExperimental()).enableIsolatedWorkspaces;
      if (!isolatedWorkspacesEnabled) {
        delete patchableIssueData.executionWorkspaceId;
        delete patchableIssueData.executionWorkspacePreference;
        delete patchableIssueData.executionWorkspaceSettings;
      }

      if (patchableIssueData.status) {
        assertTransition(existing.status, patchableIssueData.status);
      }

      const patch: Partial<typeof issues.$inferInsert> = {
        ...patchableIssueData,
        updatedAt: new Date(),
      };

      const nextAssigneeAgentId =
        patchableIssueData.assigneeAgentId !== undefined ? patchableIssueData.assigneeAgentId : existing.assigneeAgentId;
      const nextAssigneeUserId =
        patchableIssueData.assigneeUserId !== undefined ? patchableIssueData.assigneeUserId : existing.assigneeUserId;

      if (nextAssigneeAgentId && nextAssigneeUserId) {
        throw unprocessable("Issue can only have one assignee");
      }
      const nextStatus = patchableIssueData.status !== undefined ? patchableIssueData.status : existing.status;
      if (EXECUTING_ISSUE_STATUSES.has(nextStatus) && !nextAssigneeAgentId && !nextAssigneeUserId) {
        throw unprocessable(`${nextStatus} issues require an assignee`);
      }
      const nextProjectId = await resolveRequiredProjectId({
        companyId: existing.companyId,
        explicitProjectId: requestedProjectId !== undefined ? requestedProjectId : existing.projectId,
        projectWorkspaceId:
          patchableIssueData.projectWorkspaceId !== undefined ? patchableIssueData.projectWorkspaceId : existing.projectWorkspaceId,
        executionWorkspaceId:
          patchableIssueData.executionWorkspaceId !== undefined ? patchableIssueData.executionWorkspaceId : existing.executionWorkspaceId,
        parentId: patchableIssueData.parentId !== undefined ? patchableIssueData.parentId : existing.parentId,
        assigneeAgentId: nextAssigneeAgentId,
        fallbackProjectId: existing.projectId,
      }, dbOrTx);
      patch.projectId = nextProjectId;
      if (patch.status === "in_progress") {
        const unresolvedBlockerIssueIds = blockedByIssueIds !== undefined
          ? await listUnresolvedBlockerIssueIds(dbOrTx, existing.companyId, blockedByIssueIds)
          : (
              await listIssueDependencyReadinessMap(dbOrTx, existing.companyId, [id])
            ).get(id)?.unresolvedBlockerIssueIds ?? [];
        if (unresolvedBlockerIssueIds.length > 0) {
          throw unprocessable("Issue is blocked by unresolved blockers", { unresolvedBlockerIssueIds });
        }
      }
      if (patchableIssueData.assigneeAgentId) {
        await assertAssignableAgent(existing.companyId, patchableIssueData.assigneeAgentId);
      }
      if (patchableIssueData.assigneeUserId) {
        await assertAssignableUser(existing.companyId, patchableIssueData.assigneeUserId);
      }
      const nextProjectWorkspaceId =
        patchableIssueData.projectWorkspaceId !== undefined ? patchableIssueData.projectWorkspaceId : existing.projectWorkspaceId;
      const nextExecutionWorkspaceId =
        patchableIssueData.executionWorkspaceId !== undefined ? patchableIssueData.executionWorkspaceId : existing.executionWorkspaceId;
      if (nextProjectWorkspaceId) {
        await assertValidProjectWorkspace(existing.companyId, nextProjectId, nextProjectWorkspaceId);
      }
      if (nextExecutionWorkspaceId) {
        await assertValidExecutionWorkspace(existing.companyId, nextProjectId, nextExecutionWorkspaceId);
      }

      applyStatusSideEffects(patchableIssueData.status, patch);
      if (patchableIssueData.status && patchableIssueData.status !== "done") {
        patch.completedAt = null;
      }
      if (patchableIssueData.status && patchableIssueData.status !== "cancelled") {
        patch.cancelledAt = null;
      }
      if (patchableIssueData.status && patchableIssueData.status !== "in_progress") {
        patch.checkoutRunId = null;
        // Fix B: also clear the execution lock when leaving in_progress
        patch.executionRunId = null;
        patch.executionAgentNameKey = null;
        patch.executionLockedAt = null;
      }
      if (
        (patchableIssueData.assigneeAgentId !== undefined && patchableIssueData.assigneeAgentId !== existing.assigneeAgentId) ||
        (patchableIssueData.assigneeUserId !== undefined && patchableIssueData.assigneeUserId !== existing.assigneeUserId)
      ) {
        patch.checkoutRunId = null;
        // Fix B: clear execution lock on reassignment, matching checkoutRunId clear
        patch.executionRunId = null;
        patch.executionAgentNameKey = null;
        patch.executionLockedAt = null;
      }

      const runUpdate = async (tx: any) => {
        const defaultCompanyGoal = await getDefaultCompanyGoal(tx, existing.companyId);
        const [currentProjectGoalId, nextProjectGoalId] = await Promise.all([
          getProjectDefaultGoalId(tx, existing.companyId, existing.projectId),
          getProjectDefaultGoalId(
            tx,
            existing.companyId,
            nextProjectId,
          ),
        ]);
        patch.goalId = resolveNextIssueGoalId({
          currentProjectId: existing.projectId,
          currentGoalId: existing.goalId,
          currentProjectGoalId,
          projectId: nextProjectId === existing.projectId && requestedProjectId === undefined ? undefined : nextProjectId,
          goalId: patchableIssueData.goalId,
          projectGoalId: nextProjectGoalId,
          defaultGoalId: defaultCompanyGoal?.id ?? null,
        });
        const updated = await tx
          .update(issues)
          .set(patch)
          .where(eq(issues.id, id))
          .returning()
          .then((rows: Array<typeof issues.$inferSelect>) => rows[0] ?? null);
        if (!updated) return null;
        if (nextLabelIds !== undefined) {
          await syncIssueLabels(updated.id, existing.companyId, nextLabelIds, tx);
        }
        if (blockedByIssueIds !== undefined) {
          await syncBlockedByIssueIds(
            updated.id,
            existing.companyId,
            blockedByIssueIds,
            {
              agentId: actorAgentId ?? null,
              userId: actorUserId ?? null,
            },
            tx,
          );
        }
        const [enriched] = await withIssueLabels(tx, [updated]);
        return enriched;
      };

      return dbOrTx === db ? db.transaction(runUpdate) : runUpdate(dbOrTx);
    },

    clearExecutionWorkspaceEnvironmentSelection: async (companyId: string, environmentId: string) => {
      const rows = await db
        .select({
          id: issues.id,
          executionWorkspaceSettings: issues.executionWorkspaceSettings,
        })
        .from(issues)
        .where(eq(issues.companyId, companyId));

      let cleared = 0;
      for (const row of rows) {
        const settings = parseIssueExecutionWorkspaceSettings(row.executionWorkspaceSettings);
        if (settings?.environmentId !== environmentId) continue;

        await db
          .update(issues)
          .set({
            executionWorkspaceSettings: {
              ...settings,
              environmentId: null,
            },
            updatedAt: new Date(),
          })
          .where(eq(issues.id, row.id));
        cleared += 1;
      }

      return cleared;
    },

    remove: (id: string) =>
      db.transaction(async (tx) => {
        const attachmentAssetIds = await tx
          .select({ assetId: issueAttachments.assetId })
          .from(issueAttachments)
          .where(eq(issueAttachments.issueId, id));
        const issueDocumentIds = await tx
          .select({ documentId: issueDocuments.documentId })
          .from(issueDocuments)
          .where(eq(issueDocuments.issueId, id));

        const removedIssue = await tx
          .delete(issues)
          .where(eq(issues.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);

        if (removedIssue && attachmentAssetIds.length > 0) {
          await tx
            .delete(assets)
            .where(inArray(assets.id, attachmentAssetIds.map((row) => row.assetId)));
        }

        if (removedIssue && issueDocumentIds.length > 0) {
          await tx
            .delete(documents)
            .where(inArray(documents.id, issueDocumentIds.map((row) => row.documentId)));
        }

        if (!removedIssue) return null;
        const [enriched] = await withIssueLabels(tx, [removedIssue]);
        return enriched;
      }),

    checkout: async (id: string, agentId: string, expectedStatuses: string[], checkoutRunId: string | null) => {
      const issueCompany = await db
        .select({ companyId: issues.companyId })
        .from(issues)
        .where(eq(issues.id, id))
        .then((rows) => rows[0] ?? null);
      if (!issueCompany) throw notFound("Issue not found");
      await assertAssignableAgent(issueCompany.companyId, agentId);
      const allowedExpectedStatuses = normalizeCheckoutExpectedStatuses(expectedStatuses);

      const now = new Date();
      const activePauseHold = await treeControlSvc.getActivePauseHoldGate(issueCompany.companyId, id);
      if (
        activePauseHold &&
        !(await isTreeHoldInteractionCheckoutAllowed(issueCompany.companyId, checkoutRunId, activePauseHold))
      ) {
        throw conflict("Issue checkout blocked by active subtree pause hold", {
          issueId: id,
          holdId: activePauseHold.holdId,
          rootIssueId: activePauseHold.rootIssueId,
          mode: activePauseHold.mode,
          securityPrinciples: ["Complete Mediation", "Fail Securely", "Secure Defaults"],
        });
      }

      await clearExecutionRunIfTerminal(id);

      const dependencyReadiness = await listIssueDependencyReadinessMap(db, issueCompany.companyId, [id]);
      const unresolvedBlockerIssueIds = dependencyReadiness.get(id)?.unresolvedBlockerIssueIds ?? [];
      if (unresolvedBlockerIssueIds.length > 0) {
        throw unprocessable("Issue is blocked by unresolved blockers", { unresolvedBlockerIssueIds });
      }

      const sameRunAssigneeCondition = checkoutRunId
        ? and(
          eq(issues.assigneeAgentId, agentId),
          or(isNull(issues.checkoutRunId), eq(issues.checkoutRunId, checkoutRunId)),
        )
        : and(eq(issues.assigneeAgentId, agentId), isNull(issues.checkoutRunId));
      const executionLockCondition = checkoutRunId
        ? or(isNull(issues.executionRunId), eq(issues.executionRunId, checkoutRunId))
        : isNull(issues.executionRunId);
      const updated = await db
        .update(issues)
        .set({
          assigneeAgentId: agentId,
          assigneeUserId: null,
          checkoutRunId,
          executionRunId: checkoutRunId,
          status: "in_progress",
          startedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(issues.id, id),
            inArray(issues.status, allowedExpectedStatuses),
            or(isNull(issues.assigneeAgentId), sameRunAssigneeCondition),
            executionLockCondition,
          ),
        )
        .returning()
        .then((rows) => rows[0] ?? null);

      if (updated) {
        const [enriched] = await withIssueLabels(db, [updated]);
        return enriched;
      }

      const current = await db
        .select({
          id: issues.id,
          status: issues.status,
          assigneeAgentId: issues.assigneeAgentId,
          checkoutRunId: issues.checkoutRunId,
          executionRunId: issues.executionRunId,
        })
        .from(issues)
        .where(eq(issues.id, id))
        .then((rows) => rows[0] ?? null);

      if (!current) throw notFound("Issue not found");

      if (
        current.assigneeAgentId === agentId &&
        current.status === "in_progress" &&
        current.checkoutRunId == null &&
        (current.executionRunId == null || current.executionRunId === checkoutRunId) &&
        checkoutRunId
      ) {
        const adopted = await db
          .update(issues)
          .set({
            checkoutRunId,
            executionRunId: checkoutRunId,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(issues.id, id),
              eq(issues.status, "in_progress"),
              eq(issues.assigneeAgentId, agentId),
              isNull(issues.checkoutRunId),
              or(isNull(issues.executionRunId), eq(issues.executionRunId, checkoutRunId)),
            ),
          )
          .returning()
          .then((rows) => rows[0] ?? null);
        if (adopted) return adopted;
      }

      if (
        checkoutRunId &&
        current.assigneeAgentId === agentId &&
        current.status === "in_progress" &&
        current.checkoutRunId &&
        current.checkoutRunId !== checkoutRunId
      ) {
        const adopted = await adoptStaleCheckoutRun({
          issueId: id,
          actorAgentId: agentId,
          actorRunId: checkoutRunId,
          expectedCheckoutRunId: current.checkoutRunId,
        });
        if (adopted) {
          const row = await db.select().from(issues).where(eq(issues.id, id)).then((rows) => rows[0] ?? null);
          if (!row) throw notFound("Issue not found");
          const [enriched] = await withIssueLabels(db, [row]);
          return enriched;
        }
      }

      // If this run already owns it and it's in_progress, return it (no self-409)
      if (
        current.assigneeAgentId === agentId &&
        current.status === "in_progress" &&
        sameRunLock(current.checkoutRunId, checkoutRunId)
      ) {
        const row = await db.select().from(issues).where(eq(issues.id, id)).then((rows) => rows[0] ?? null);
        if (!row) throw notFound("Issue not found");
        const [enriched] = await withIssueLabels(db, [row]);
        return enriched;
      }

      throw conflict("Issue checkout conflict", {
        issueId: current.id,
        status: current.status,
        assigneeAgentId: current.assigneeAgentId,
        checkoutRunId: current.checkoutRunId,
        executionRunId: current.executionRunId,
      });
    },

    assertCheckoutOwner: async (id: string, actorAgentId: string, actorRunId: string | null) => {
      await clearExecutionRunIfTerminal(id);
      const current = await db
        .select({
          id: issues.id,
          status: issues.status,
          assigneeAgentId: issues.assigneeAgentId,
          checkoutRunId: issues.checkoutRunId,
          executionRunId: issues.executionRunId,
        })
        .from(issues)
        .where(eq(issues.id, id))
        .then((rows) => rows[0] ?? null);

      if (!current) throw notFound("Issue not found");

      if (
        current.status === "in_progress" &&
        current.assigneeAgentId === actorAgentId &&
        sameRunLock(current.checkoutRunId, actorRunId)
      ) {
        return { ...current, adoptedFromRunId: null as string | null };
      }

      if (
        actorRunId &&
        current.status === "in_progress" &&
        current.assigneeAgentId === actorAgentId &&
        current.checkoutRunId == null &&
        (current.executionRunId == null || current.executionRunId === actorRunId)
      ) {
        const adopted = await adoptUnownedCheckoutRun({
          issueId: id,
          actorAgentId,
          actorRunId,
        });

        if (adopted) {
          return {
            ...adopted,
            adoptedFromRunId: null as string | null,
          };
        }
      }

      if (
        actorRunId &&
        current.status === "in_progress" &&
        current.assigneeAgentId === actorAgentId &&
        current.checkoutRunId &&
        current.checkoutRunId !== actorRunId
      ) {
        const adopted = await adoptStaleCheckoutRun({
          issueId: id,
          actorAgentId,
          actorRunId,
          expectedCheckoutRunId: current.checkoutRunId,
        });

        if (adopted) {
          return {
            ...adopted,
            adoptedFromRunId: current.checkoutRunId,
          };
        }
      }

      throw conflict("run_id_mismatch", {
        issueId: current.id,
        status: current.status,
        assigneeAgentId: current.assigneeAgentId,
        checkoutRunId: current.checkoutRunId,
        executionRunId: current.executionRunId,
        actorAgentId,
        actorRunId,
      });
    },

    release: async (id: string, actorAgentId?: string, actorRunId?: string | null) => {
      await clearExecutionRunIfTerminal(id);
      const existing = await db
        .select()
        .from(issues)
        .where(eq(issues.id, id))
        .then((rows) => rows[0] ?? null);

      if (!existing) return null;
      if (actorAgentId && existing.assigneeAgentId && existing.assigneeAgentId !== actorAgentId) {
        throw conflict("Only assignee can release issue");
      }
      if (
        actorAgentId &&
        existing.status === "in_progress" &&
        existing.assigneeAgentId === actorAgentId &&
        existing.checkoutRunId &&
        !sameRunLock(existing.checkoutRunId, actorRunId ?? null)
      ) {
        const stale = await isTerminalOrMissingHeartbeatRun(existing.checkoutRunId);
        if (!stale) {
          throw conflict("Only checkout run can release issue", {
            issueId: existing.id,
            assigneeAgentId: existing.assigneeAgentId,
            checkoutRunId: existing.checkoutRunId,
            actorRunId: actorRunId ?? null,
          });
        }
      }

      const nextStatus = TERMINAL_ISSUE_STATUSES.has(existing.status) ? existing.status : "todo";
      const updated = await db
        .update(issues)
        .set({
          status: nextStatus,
          assigneeAgentId: null,
          assigneeUserId: null,
          checkoutRunId: null,
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(issues.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!updated) return null;
      const [enriched] = await withIssueLabels(db, [updated]);
      return enriched;
    },

    adminForceRelease: async (id: string, options: { clearAssignee?: boolean } = {}) =>
      db.transaction(async (tx) => {
        await tx.execute(
          sql`select ${issues.id} from ${issues} where ${issues.id} = ${id} for update`,
        );
        const existing = await tx
          .select({
            id: issues.id,
            checkoutRunId: issues.checkoutRunId,
            executionRunId: issues.executionRunId,
          })
          .from(issues)
          .where(eq(issues.id, id))
          .then((rows) => rows[0] ?? null);
        if (!existing) return null;

        const patch: Partial<typeof issues.$inferInsert> = {
          checkoutRunId: null,
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          updatedAt: new Date(),
        };
        if (options.clearAssignee) {
          patch.assigneeAgentId = null;
        }

        const updated = await tx
          .update(issues)
          .set(patch)
          .where(eq(issues.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!updated) return null;

        const [enriched] = await withIssueLabels(tx, [updated]);
        return {
          issue: enriched,
          previous: {
            checkoutRunId: existing.checkoutRunId,
            executionRunId: existing.executionRunId,
          },
        };
      }),

    listLabels: (companyId: string) =>
      db.select().from(labels).where(eq(labels.companyId, companyId)).orderBy(asc(labels.name), asc(labels.id)),

    getLabelById: (id: string) =>
      db
        .select()
        .from(labels)
        .where(eq(labels.id, id))
        .then((rows) => rows[0] ?? null),

    createLabel: async (companyId: string, data: Pick<typeof labels.$inferInsert, "name" | "color">) => {
      const [created] = await db
        .insert(labels)
        .values({
          companyId,
          name: data.name.trim(),
          color: data.color,
        })
        .returning();
      return created;
    },

    deleteLabel: async (id: string) =>
      db
        .delete(labels)
        .where(eq(labels.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),

    listComments: async (
      issueId: string,
      opts?: {
        afterCommentId?: string | null;
        order?: "asc" | "desc";
        limit?: number | null;
      },
    ) => {
      const order = opts?.order === "asc" ? "asc" : "desc";
      const afterCommentId = opts?.afterCommentId?.trim() || null;
      const limit =
        opts?.limit && opts.limit > 0
          ? Math.min(Math.floor(opts.limit), MAX_ISSUE_COMMENT_PAGE_LIMIT)
          : null;

      const conditions = [eq(issueComments.issueId, issueId)];
      if (afterCommentId) {
        const anchor = await db
          .select({
            id: issueComments.id,
            createdAt: issueComments.createdAt,
          })
          .from(issueComments)
          .where(and(eq(issueComments.issueId, issueId), eq(issueComments.id, afterCommentId)))
          .then((rows) => rows[0] ?? null);

        if (!anchor) return [];
        conditions.push(
          order === "asc"
            ? or(
                gt(issueComments.createdAt, anchor.createdAt),
                and(eq(issueComments.createdAt, anchor.createdAt), gt(issueComments.id, anchor.id)),
              )!
            : or(
                lt(issueComments.createdAt, anchor.createdAt),
                and(eq(issueComments.createdAt, anchor.createdAt), lt(issueComments.id, anchor.id)),
              )!,
        );
      }

      const query = db
        .select()
        .from(issueComments)
        .where(and(...conditions))
        .orderBy(
          order === "asc" ? asc(issueComments.createdAt) : desc(issueComments.createdAt),
          order === "asc" ? asc(issueComments.id) : desc(issueComments.id),
        );

      const comments = limit ? await query.limit(limit) : await query;
      const { censorUsernameInLogs } = await instanceSettings.getGeneral();
      return comments.map((comment) => redactIssueComment(comment, censorUsernameInLogs));
    },

    getCommentCursor: async (issueId: string) => {
      const [latest, countRow] = await Promise.all([
        db
          .select({
            latestCommentId: issueComments.id,
            latestCommentAt: issueComments.createdAt,
          })
          .from(issueComments)
          .where(eq(issueComments.issueId, issueId))
          .orderBy(desc(issueComments.createdAt), desc(issueComments.id))
          .limit(1)
          .then((rows) => rows[0] ?? null),
        db
          .select({
            totalComments: sql<number>`count(*)::int`,
          })
          .from(issueComments)
          .where(eq(issueComments.issueId, issueId))
          .then((rows) => rows[0] ?? null),
      ]);

      return {
        totalComments: Number(countRow?.totalComments ?? 0),
        latestCommentId: latest?.latestCommentId ?? null,
        latestCommentAt: latest?.latestCommentAt ?? null,
      };
    },

    getComment: (commentId: string) =>
      instanceSettings.getGeneral().then(({ censorUsernameInLogs }) =>
        db
        .select()
        .from(issueComments)
        .where(eq(issueComments.id, commentId))
        .then((rows) => {
          const comment = rows[0] ?? null;
          return comment ? redactIssueComment(comment, censorUsernameInLogs) : null;
        })),

    removeComment: async (commentId: string) => {
      const currentUserRedactionOptions = {
        enabled: (await instanceSettings.getGeneral()).censorUsernameInLogs,
      };

      return db.transaction(async (tx) => {
        const [comment] = await tx
          .delete(issueComments)
          .where(eq(issueComments.id, commentId))
          .returning();

        if (!comment) return null;

        await tx
          .update(issues)
          .set({ updatedAt: new Date() })
          .where(eq(issues.id, comment.issueId));

        return redactIssueComment(comment, currentUserRedactionOptions.enabled);
      });
    },

    addComment: async (
      issueId: string,
      body: string,
      actor: { agentId?: string; userId?: string; runId?: string | null },
    ) => {
      const issue = await db
        .select({ companyId: issues.companyId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);

      if (!issue) throw notFound("Issue not found");

      const currentUserRedactionOptions = {
        enabled: (await instanceSettings.getGeneral()).censorUsernameInLogs,
      };
      const redactedBody = redactCurrentUserText(body, currentUserRedactionOptions);
      const [comment] = await db
        .insert(issueComments)
        .values({
          companyId: issue.companyId,
          issueId,
          authorAgentId: actor.agentId ?? null,
          authorUserId: actor.userId ?? null,
          createdByRunId: actor.runId ?? null,
          body: redactedBody,
        })
        .returning();

      // Update issue's updatedAt so comment activity is reflected in recency sorting
      await db
        .update(issues)
        .set({ updatedAt: new Date() })
        .where(eq(issues.id, issueId));

      return redactIssueComment(comment, currentUserRedactionOptions.enabled);
    },

    createAttachment: async (input: {
      issueId: string;
      issueCommentId?: string | null;
      provider: string;
      objectKey: string;
      contentType: string;
      byteSize: number;
      sha256: string;
      originalFilename?: string | null;
      createdByAgentId?: string | null;
      createdByUserId?: string | null;
      scanStatus?: "pending_scan" | "clean" | "quarantined" | "scan_failed";
      scanProvider?: string | null;
      scanCompletedAt?: Date | null;
      quarantinedAt?: Date | null;
      quarantineReason?: string | null;
      retentionClass?: "standard" | "evidence" | "company_brand" | "temporary";
      expiresAt?: Date | null;
      legalHold?: boolean;
    }) => {
      const issue = await db
        .select({ id: issues.id, companyId: issues.companyId })
        .from(issues)
        .where(eq(issues.id, input.issueId))
        .then((rows) => rows[0] ?? null);
      if (!issue) throw notFound("Issue not found");

      if (input.issueCommentId) {
        const comment = await db
          .select({ id: issueComments.id, companyId: issueComments.companyId, issueId: issueComments.issueId })
          .from(issueComments)
          .where(eq(issueComments.id, input.issueCommentId))
          .then((rows) => rows[0] ?? null);
        if (!comment) throw notFound("Issue comment not found");
        if (comment.companyId !== issue.companyId || comment.issueId !== issue.id) {
          throw unprocessable("Attachment comment must belong to same issue and company");
        }
      }

      return db.transaction(async (tx) => {
        const [asset] = await tx
          .insert(assets)
          .values({
            companyId: issue.companyId,
            provider: input.provider,
            objectKey: input.objectKey,
            contentType: input.contentType,
            byteSize: input.byteSize,
            sha256: input.sha256,
            originalFilename: input.originalFilename ?? null,
            createdByAgentId: input.createdByAgentId ?? null,
            createdByUserId: input.createdByUserId ?? null,
            scanStatus: input.scanStatus ?? "pending_scan",
            scanProvider: input.scanProvider ?? null,
            scanCompletedAt: input.scanCompletedAt ?? null,
            quarantinedAt: input.quarantinedAt ?? null,
            quarantineReason: input.quarantineReason ?? null,
            retentionClass: input.retentionClass ?? "evidence",
            expiresAt: input.expiresAt ?? null,
            legalHold: input.legalHold ?? false,
          })
          .returning();

        const [attachment] = await tx
          .insert(issueAttachments)
          .values({
            companyId: issue.companyId,
            issueId: issue.id,
            assetId: asset.id,
            issueCommentId: input.issueCommentId ?? null,
          })
          .returning();

        return {
          id: attachment.id,
          companyId: attachment.companyId,
          issueId: attachment.issueId,
          issueCommentId: attachment.issueCommentId,
          assetId: attachment.assetId,
          provider: asset.provider,
          objectKey: asset.objectKey,
          contentType: asset.contentType,
          byteSize: asset.byteSize,
          sha256: asset.sha256,
          originalFilename: asset.originalFilename,
          createdByAgentId: asset.createdByAgentId,
          createdByUserId: asset.createdByUserId,
          scanStatus: asset.scanStatus,
          scanProvider: asset.scanProvider,
          scanCompletedAt: asset.scanCompletedAt,
          quarantinedAt: asset.quarantinedAt,
          quarantineReason: asset.quarantineReason,
          retentionClass: asset.retentionClass,
          expiresAt: asset.expiresAt,
          legalHold: asset.legalHold,
          deletedAt: asset.deletedAt,
          createdAt: attachment.createdAt,
          updatedAt: attachment.updatedAt,
        };
      });
    },

    listAttachments: async (issueId: string) =>
      db
        .select({
          id: issueAttachments.id,
          companyId: issueAttachments.companyId,
          issueId: issueAttachments.issueId,
          issueCommentId: issueAttachments.issueCommentId,
          assetId: issueAttachments.assetId,
          provider: assets.provider,
          objectKey: assets.objectKey,
          contentType: assets.contentType,
          byteSize: assets.byteSize,
          sha256: assets.sha256,
          originalFilename: assets.originalFilename,
          createdByAgentId: assets.createdByAgentId,
          createdByUserId: assets.createdByUserId,
          scanStatus: assets.scanStatus,
          scanProvider: assets.scanProvider,
          scanCompletedAt: assets.scanCompletedAt,
          quarantinedAt: assets.quarantinedAt,
          quarantineReason: assets.quarantineReason,
          retentionClass: assets.retentionClass,
          expiresAt: assets.expiresAt,
          legalHold: assets.legalHold,
          deletedAt: assets.deletedAt,
          createdAt: issueAttachments.createdAt,
          updatedAt: issueAttachments.updatedAt,
        })
        .from(issueAttachments)
        .innerJoin(assets, eq(issueAttachments.assetId, assets.id))
        .where(eq(issueAttachments.issueId, issueId))
        .orderBy(desc(issueAttachments.createdAt)),

    getAttachmentById: async (id: string) =>
      db
        .select({
          id: issueAttachments.id,
          companyId: issueAttachments.companyId,
          issueId: issueAttachments.issueId,
          issueCommentId: issueAttachments.issueCommentId,
          assetId: issueAttachments.assetId,
          provider: assets.provider,
          objectKey: assets.objectKey,
          contentType: assets.contentType,
          byteSize: assets.byteSize,
          sha256: assets.sha256,
          originalFilename: assets.originalFilename,
          createdByAgentId: assets.createdByAgentId,
          createdByUserId: assets.createdByUserId,
          scanStatus: assets.scanStatus,
          scanProvider: assets.scanProvider,
          scanCompletedAt: assets.scanCompletedAt,
          quarantinedAt: assets.quarantinedAt,
          quarantineReason: assets.quarantineReason,
          retentionClass: assets.retentionClass,
          expiresAt: assets.expiresAt,
          legalHold: assets.legalHold,
          deletedAt: assets.deletedAt,
          createdAt: issueAttachments.createdAt,
          updatedAt: issueAttachments.updatedAt,
        })
        .from(issueAttachments)
        .innerJoin(assets, eq(issueAttachments.assetId, assets.id))
        .where(eq(issueAttachments.id, id))
        .then((rows) => rows[0] ?? null),

    removeAttachment: async (id: string) =>
      db.transaction(async (tx) => {
        const existing = await tx
          .select({
            id: issueAttachments.id,
            companyId: issueAttachments.companyId,
            issueId: issueAttachments.issueId,
            issueCommentId: issueAttachments.issueCommentId,
            assetId: issueAttachments.assetId,
            provider: assets.provider,
            objectKey: assets.objectKey,
            contentType: assets.contentType,
            byteSize: assets.byteSize,
            sha256: assets.sha256,
            originalFilename: assets.originalFilename,
            createdByAgentId: assets.createdByAgentId,
            createdByUserId: assets.createdByUserId,
            scanStatus: assets.scanStatus,
            scanProvider: assets.scanProvider,
            scanCompletedAt: assets.scanCompletedAt,
            quarantinedAt: assets.quarantinedAt,
            quarantineReason: assets.quarantineReason,
            retentionClass: assets.retentionClass,
            expiresAt: assets.expiresAt,
            legalHold: assets.legalHold,
            deletedAt: assets.deletedAt,
            createdAt: issueAttachments.createdAt,
            updatedAt: issueAttachments.updatedAt,
          })
          .from(issueAttachments)
          .innerJoin(assets, eq(issueAttachments.assetId, assets.id))
          .where(eq(issueAttachments.id, id))
          .then((rows) => rows[0] ?? null);
        if (!existing) return null;

        await tx.delete(issueAttachments).where(eq(issueAttachments.id, id));
        await tx
          .update(assets)
          .set({ deletedAt: new Date(), updatedAt: new Date() })
          .where(eq(assets.id, existing.assetId));
        return existing;
      }),

    resolveMentionedAgents: (companyId: string, body: string) =>
      resolveMentionedAgentsImpl(db, companyId, body),

    findMentionedAgents: async (companyId: string, body: string) => {
      const result = await resolveMentionedAgentsImpl(db, companyId, body);
      return {
        agentIds: result.agentIds,
        droppedMentions: result.droppedMentions,
      };
    },

    getAgentStatusById: async (agentId: string): Promise<string | null> => {
      const row = await db
        .select({ status: agents.status })
        .from(agents)
        .where(eq(agents.id, agentId))
        .then((rows) => rows[0] ?? null);
      return row?.status ?? null;
    },

    findMentionedProjectIds: async (issueId: string) => {
      const issue = await db
        .select({
          companyId: issues.companyId,
          title: issues.title,
          description: issues.description,
        })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      if (!issue) return [];

      const comments = await db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, issueId));

      const mentionedIds = new Set<string>();
      for (const source of [
        issue.title,
        issue.description ?? "",
        ...comments.map((comment) => comment.body),
      ]) {
        for (const projectId of extractProjectMentionIds(source)) {
          mentionedIds.add(projectId);
        }
      }
      if (mentionedIds.size === 0) return [];

      const rows = await db
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(
            eq(projects.companyId, issue.companyId),
            inArray(projects.id, [...mentionedIds]),
          ),
        );
      const valid = new Set(rows.map((row) => row.id));
      return [...mentionedIds].filter((projectId) => valid.has(projectId));
    },

    getAncestors: async (issueId: string) => {
      const raw: Array<{
        id: string; identifier: string | null; title: string; description: string | null;
        status: string; priority: string;
        assigneeAgentId: string | null; projectId: string | null; goalId: string | null;
      }> = [];
      const visited = new Set<string>([issueId]);
      const start = await db.select().from(issues).where(eq(issues.id, issueId)).then(r => r[0] ?? null);
      let currentId = start?.parentId ?? null;
      while (currentId && !visited.has(currentId) && raw.length < 50) {
        visited.add(currentId);
        const parent = await db.select({
          id: issues.id, identifier: issues.identifier, title: issues.title, description: issues.description,
          status: issues.status, priority: issues.priority,
          assigneeAgentId: issues.assigneeAgentId, projectId: issues.projectId,
          goalId: issues.goalId, parentId: issues.parentId,
        }).from(issues).where(eq(issues.id, currentId)).then(r => r[0] ?? null);
        if (!parent) break;
        raw.push({
          id: parent.id, identifier: parent.identifier ?? null, title: parent.title, description: parent.description ?? null,
          status: parent.status, priority: parent.priority,
          assigneeAgentId: parent.assigneeAgentId ?? null,
          projectId: parent.projectId ?? null, goalId: parent.goalId ?? null,
        });
        currentId = parent.parentId ?? null;
      }

      // Batch-fetch referenced projects and goals
      const projectIds = [...new Set(raw.map(a => a.projectId).filter((id): id is string => id != null))];
      const goalIds = [...new Set(raw.map(a => a.goalId).filter((id): id is string => id != null))];

      const projectMap = new Map<string, {
        id: string;
        name: string;
        description: string | null;
        status: string;
        goalId: string | null;
        workspaces: Array<{
          id: string;
          companyId: string;
          projectId: string;
          name: string;
          cwd: string | null;
          repoUrl: string | null;
          repoRef: string | null;
          metadata: Record<string, unknown> | null;
          isPrimary: boolean;
          createdAt: Date;
          updatedAt: Date;
        }>;
        primaryWorkspace: {
          id: string;
          companyId: string;
          projectId: string;
          name: string;
          cwd: string | null;
          repoUrl: string | null;
          repoRef: string | null;
          metadata: Record<string, unknown> | null;
          isPrimary: boolean;
          createdAt: Date;
          updatedAt: Date;
        } | null;
      }>();
      const goalMap = new Map<string, { id: string; title: string; description: string | null; level: string; status: string }>();

      if (projectIds.length > 0) {
        const workspaceRows = await db
          .select()
          .from(projectWorkspaces)
          .where(inArray(projectWorkspaces.projectId, projectIds))
          .orderBy(desc(projectWorkspaces.isPrimary), asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id));
        const workspaceMap = new Map<string, Array<(typeof workspaceRows)[number]>>();
        for (const workspace of workspaceRows) {
          const existing = workspaceMap.get(workspace.projectId);
          if (existing) existing.push(workspace);
          else workspaceMap.set(workspace.projectId, [workspace]);
        }

        const rows = await db.select({
          id: projects.id, name: projects.name, description: projects.description,
          status: projects.status, goalId: projects.goalId,
        }).from(projects).where(inArray(projects.id, projectIds));
        for (const r of rows) {
          const projectWorkspaceRows = workspaceMap.get(r.id) ?? [];
          const workspaces = projectWorkspaceRows.map((workspace) => ({
            id: workspace.id,
            companyId: workspace.companyId,
            projectId: workspace.projectId,
            name: workspace.name,
            cwd: workspace.cwd,
            repoUrl: workspace.repoUrl ?? null,
            repoRef: workspace.repoRef ?? null,
            metadata: (workspace.metadata as Record<string, unknown> | null) ?? null,
            isPrimary: workspace.isPrimary,
            createdAt: workspace.createdAt,
            updatedAt: workspace.updatedAt,
          }));
          const primaryWorkspace = workspaces.find((workspace) => workspace.isPrimary) ?? workspaces[0] ?? null;
          projectMap.set(r.id, {
            ...r,
            workspaces,
            primaryWorkspace,
          });
          // Also collect goalIds from projects
          if (r.goalId && !goalIds.includes(r.goalId)) goalIds.push(r.goalId);
        }
      }

      if (goalIds.length > 0) {
        const rows = await db.select({
          id: goals.id, title: goals.title, description: goals.description,
          level: goals.level, status: goals.status,
        }).from(goals).where(inArray(goals.id, goalIds));
        for (const r of rows) goalMap.set(r.id, r);
      }

      return raw.map(a => ({
        ...a,
        project: a.projectId ? projectMap.get(a.projectId) ?? null : null,
        goal: a.goalId ? goalMap.get(a.goalId) ?? null : null,
      }));
    },
  };
}
