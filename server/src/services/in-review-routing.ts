import { and, asc, eq, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issues } from "@paperclipai/db";

/**
 * Auto-route reviewer selection for the plain `status: in_review` path on
 * `PATCH /api/issues/:id` (AIW-137). When an issue transitions to `in_review`
 * without an execution policy review stage and without an explicit reviewer,
 * the handler calls these helpers to pick a least-loaded QA/Evals continuity
 * owner in the same company and build the system-authored routing comment.
 *
 * Scope: selection lives here so it is testable in isolation. The route-level
 * gating, wake enqueue, and activity log emission live in `routes/issues.ts`.
 */

const QA_ARCHETYPE_KEY = "qa_evals_continuity_owner";
const TERMINATED_STATUS = "terminated";

/**
 * Open-issue load definition. Matches the convention in the office-coordination
 * load-balance path — counts `todo`, `in_progress`, `in_review`, and `blocked`.
 * `backlog` is intentionally excluded (future work, not active load).
 */
const OPEN_ISSUE_STATUSES = ["todo", "in_progress", "in_review", "blocked"] as const;

export interface LeastLoadedQaReviewerCandidate {
  id: string;
  name: string;
  openIssueCount: number;
  createdAt: Date;
}

export interface SelectLeastLoadedQaReviewerResult {
  reviewer: LeastLoadedQaReviewerCandidate | null;
  candidateCount: number;
}

export interface SelectLeastLoadedQaReviewerOptions {
  companyId: string;
  excludeAgentId?: string | null;
}

/**
 * Pick the least-loaded non-excluded `qa_evals_continuity_owner` in a company.
 *
 * - Filter: `companyId = ?`, `archetypeKey = "qa_evals_continuity_owner"`,
 *   `status != "terminated"`, and `id != excludeAgentId` when provided.
 * - Load: count of issues in that company currently assigned to the candidate
 *   where `issues.status IN ('todo','in_progress','in_review','blocked')`.
 * - Sort: `openIssueCount ASC, createdAt ASC` (oldest tiebreak).
 *
 * Returns both the selected reviewer (or null if none eligible) and the total
 * candidate count before selection, for the activity-log detail payload.
 */
export async function selectLeastLoadedQaReviewer(
  db: Db,
  options: SelectLeastLoadedQaReviewerOptions,
): Promise<SelectLeastLoadedQaReviewerResult> {
  const { companyId, excludeAgentId } = options;
  const openLoad = sql<number>`cast(coalesce(count(${issues.id}) filter (where ${issues.status} = any(array[${sql.join(
    OPEN_ISSUE_STATUSES.map((status) => sql`${status}`),
    sql`, `,
  )}]::text[]) and ${issues.assigneeAgentId} = ${agents.id}), 0) as int)`;

  const baseFilter = and(
    eq(agents.companyId, companyId),
    eq(agents.archetypeKey, QA_ARCHETYPE_KEY),
    ne(agents.status, TERMINATED_STATUS),
    excludeAgentId ? ne(agents.id, excludeAgentId) : undefined,
  );

  const rows = await db
    .select({
      id: agents.id,
      name: agents.name,
      createdAt: agents.createdAt,
      openIssueCount: openLoad,
    })
    .from(agents)
    .leftJoin(issues, eq(issues.assigneeAgentId, agents.id))
    .where(baseFilter)
    .groupBy(agents.id, agents.name, agents.createdAt)
    .orderBy(asc(openLoad), asc(agents.createdAt));

  if (rows.length === 0) {
    return { reviewer: null, candidateCount: 0 };
  }

  const first = rows[0];
  return {
    reviewer: {
      id: first.id,
      name: first.name,
      openIssueCount: first.openIssueCount,
      createdAt: first.createdAt,
    },
    candidateCount: rows.length,
  };
}

export interface AutoRouteCommentInput {
  executor: { id: string; name: string } | null;
  reviewer: { id: string; name: string };
  routedBy: "auto" | "explicit";
}

/**
 * Build the system-authored comment body posted to the issue thread when the
 * auto-route gate fires (or the explicit-reviewer path fires). Uses Paperclip
 * agent-mention links so the UI renders the participants.
 */
export function buildAutoRouteComment(input: AutoRouteCommentInput): string {
  const reviewerMention = `[@${input.reviewer.name}](agent://${input.reviewer.id})`;
  if (input.routedBy === "explicit") {
    return `Routed for QA review — reviewer: ${reviewerMention}.`;
  }
  const executorMention = input.executor
    ? `[@${input.executor.name}](agent://${input.executor.id})`
    : "unknown executor";
  return `Auto-routed for QA review — executor: ${executorMention}, reviewer: ${reviewerMention} (least-loaded among qa_evals_continuity_owner).`;
}

/**
 * Error returned when the route-level auto-route gate cannot satisfy the
 * caller's request. The shape matches the existing `in_review entry gate`
 * 422 envelope so callers see consistent `details.missing`.
 */
export interface InReviewRoutingGateError {
  error: string;
  details: { missing: string[] };
}

export function inReviewRoutingMissingReviewerError(): InReviewRoutingGateError {
  return {
    error: "in_review requires explicit reviewer routing",
    details: { missing: ["reviewerAgentId", "executionPolicy"] },
  };
}

