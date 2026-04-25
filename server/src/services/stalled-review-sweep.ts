import { and, asc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, agentProjectScopes, agents, issues } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import type { IssueAssignmentWakeupDeps } from "./issue-assignment-wakeup.js";

/**
 * Stalled-review sweep — AIW-139.
 *
 * Rides the existing scheduler tick (alongside `runAssetRetentionSweep` /
 * `runExecutionWorkspaceMaintenance`). Finds `in_review` issues with
 * `updatedAt` older than the threshold, then either re-wakes the current
 * reviewer (Action B primary, Action A rare policy-stage path) or escalates
 * to a manager (Action C) when no reviewer can be resolved.
 *
 * Observability: every act-upon decision writes one `activity_log` row
 * keyed `entity_type='issue'`, `action='issue.stalled_review_swept'`. The
 * null-target path writes `action='issue.stalled_review_sweep_no_target'`.
 * Structured server logs are prefixed `[stalled-review-sweep]`.
 */

const SWEEP_ACTOR_ID = "stalled-review-sweep";
const SWEEP_ACTION = "issue.stalled_review_swept";
const SWEEP_NO_TARGET_ACTION = "issue.stalled_review_sweep_no_target";

const PROJECT_LEAD_ARCHETYPES = [
  "project_lead",
  "technical_project_lead",
  "project_tech_lead",
] as const;

const PROJECT_LEAD_PRIORITY: Record<string, number> = {
  project_lead: 500,
  technical_project_lead: 450,
  project_tech_lead: 450,
};

const OFFICE_OPERATOR_ARCHETYPE_KEY = "chief_of_staff";
const INELIGIBLE_AGENT_STATUSES = ["terminated", "pending_approval"];

export interface IssueServiceForSweep {
  update: (
    id: string,
    data: { assigneeAgentId?: string | null },
    dbOrTx?: unknown,
  ) => Promise<unknown>;
  addComment: (
    issueId: string,
    body: string,
    actor: { agentId?: string; userId?: string; runId?: string | null },
  ) => Promise<unknown>;
}

export interface StalledReviewSweepDeps {
  heartbeat: IssueAssignmentWakeupDeps;
  issueService: IssueServiceForSweep;
}

export interface StalledReviewSweepOptions {
  now?: Date;
  thresholdHours?: number;
  maxWakesPerDay?: number;
  batchSize?: number;
  enabled?: boolean;
  /** Minimum gap between sweeps; honoured unless `force` is true. */
  intervalMinutes?: number;
  /** Bypass the throttle (tests + manual runs). */
  force?: boolean;
}

export interface StalledReviewSweepResult {
  scanned: number;
  acted: number;
  rewokenAssignee: number;
  rewokenParticipant: number;
  escalated: number;
  skippedRateCap: number;
  skippedNoTarget: number;
  skippedThrottled: boolean;
}

function emptyResult(throttled = false): StalledReviewSweepResult {
  return {
    scanned: 0,
    acted: 0,
    rewokenAssignee: 0,
    rewokenParticipant: 0,
    escalated: 0,
    skippedRateCap: 0,
    skippedNoTarget: 0,
    skippedThrottled: throttled,
  };
}

let lastSweepAt: Date | null = null;

/** Test-only — reset the module-level throttle so the next call runs. */
export function __resetStalledReviewSweepState(): void {
  lastSweepAt = null;
}

export async function runStalledReviewSweep(
  db: Db,
  deps: StalledReviewSweepDeps,
  options: StalledReviewSweepOptions = {},
): Promise<StalledReviewSweepResult> {
  if (options.enabled === false) return emptyResult();

  const now = options.now ?? new Date();
  const intervalMinutes = Math.max(1, options.intervalMinutes ?? 60);
  const thresholdHours = Math.max(1, options.thresholdHours ?? 24);
  const maxWakesPerDay = Math.max(1, options.maxWakesPerDay ?? 2);
  const batchSize = Math.max(1, options.batchSize ?? 200);

  if (!options.force && lastSweepAt) {
    const elapsedMs = now.getTime() - lastSweepAt.getTime();
    if (elapsedMs < intervalMinutes * 60_000) {
      return emptyResult(true);
    }
  }
  lastSweepAt = now;

  const thresholdCutoff = new Date(now.getTime() - thresholdHours * 3_600_000);
  const stale = await db
    .select()
    .from(issues)
    .where(and(eq(issues.status, "in_review"), lt(issues.updatedAt, thresholdCutoff)))
    .orderBy(asc(issues.updatedAt))
    .limit(batchSize);

  const result = emptyResult();
  result.scanned = stale.length;
  if (stale.length === 0) return result;

  const rateCutoff = new Date(now.getTime() - 24 * 3_600_000);
  const issueIds = stale.map((issue) => issue.id);
  const sweepCounts = await loadRecentSweepCounts(db, issueIds, rateCutoff);

  for (const issue of stale) {
    const idleHours = Math.max(
      0,
      Math.round(((now.getTime() - issue.updatedAt.getTime()) / 3_600_000) * 10) / 10,
    );
    const sweepCount = sweepCounts.get(issue.id) ?? 0;

    if (sweepCount >= maxWakesPerDay) {
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: "system",
        actorId: SWEEP_ACTOR_ID,
        action: SWEEP_ACTION,
        entityType: "issue",
        entityId: issue.id,
        details: {
          decision: "skipped_rate_cap",
          idleHours,
          thresholdHours,
          maxPerDay: maxWakesPerDay,
          sweepCount,
        },
      });
      result.skippedRateCap += 1;
      logger.info(
        {
          issueId: issue.id,
          companyId: issue.companyId,
          idleHours,
          sweepCount,
          maxPerDay: maxWakesPerDay,
        },
        "[stalled-review-sweep] skipped_rate_cap",
      );
      continue;
    }

    const decision = await resolveDecision(db, issue);

    if (decision.kind === "no_target") {
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: "system",
        actorId: SWEEP_ACTOR_ID,
        action: SWEEP_NO_TARGET_ACTION,
        entityType: "issue",
        entityId: issue.id,
        details: {
          decision: "no_target",
          idleHours,
          thresholdHours,
          maxPerDay: maxWakesPerDay,
          assigneeAgentId: issue.assigneeAgentId,
          projectId: issue.projectId,
        },
      });
      result.skippedNoTarget += 1;
      logger.warn(
        {
          issueId: issue.id,
          companyId: issue.companyId,
          idleHours,
          assigneeAgentId: issue.assigneeAgentId,
        },
        "[stalled-review-sweep] no_target",
      );
      continue;
    }

    try {
      if (decision.kind === "escalate") {
        await deps.issueService.update(issue.id, { assigneeAgentId: decision.targetAgentId });
        await postSweepComment(
          deps,
          issue.id,
          buildEscalateCommentBody(idleHours, decision.targetAgentName),
        );
        await fireWake(deps, decision.targetAgentId, issue.id, issue.status);
        await logActivity(db, {
          companyId: issue.companyId,
          actorType: "system",
          actorId: SWEEP_ACTOR_ID,
          action: SWEEP_ACTION,
          entityType: "issue",
          entityId: issue.id,
          details: {
            decision: "escalate",
            idleHours,
            thresholdHours,
            maxPerDay: maxWakesPerDay,
            sweepCount,
            escalationTargetAgentId: decision.targetAgentId,
            escalationTargetAgentName: decision.targetAgentName,
            escalationSource: decision.source,
            previousAssigneeAgentId: issue.assigneeAgentId,
          },
        });
        result.escalated += 1;
        result.acted += 1;
        logger.info(
          {
            issueId: issue.id,
            companyId: issue.companyId,
            idleHours,
            escalationTargetAgentId: decision.targetAgentId,
            escalationSource: decision.source,
          },
          "[stalled-review-sweep] escalate",
        );
        continue;
      }

      // Action A / Action B — re-wake the existing reviewer.
      // Wake first, then comment. addComment() touches issues.updatedAt; if the
      // wake throws after the comment lands, the issue would no longer be stale
      // and the next sweep tick would skip it for the full thresholdHours.
      await fireWake(deps, decision.targetAgentId, issue.id, issue.status);
      await postSweepComment(deps, issue.id, buildRewakeCommentBody(idleHours));
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: "system",
        actorId: SWEEP_ACTOR_ID,
        action: SWEEP_ACTION,
        entityType: "issue",
        entityId: issue.id,
        details: {
          decision: decision.kind,
          idleHours,
          thresholdHours,
          maxPerDay: maxWakesPerDay,
          sweepCount,
          reviewerAgentId: decision.targetAgentId,
          reviewerSource: decision.kind === "rewake_assignee" ? "assignee" : "execution_state",
        },
      });
      if (decision.kind === "rewake_assignee") result.rewokenAssignee += 1;
      else result.rewokenParticipant += 1;
      result.acted += 1;
      logger.info(
        {
          issueId: issue.id,
          companyId: issue.companyId,
          idleHours,
          decision: decision.kind,
          reviewerAgentId: decision.targetAgentId,
        },
        "[stalled-review-sweep] rewake",
      );
    } catch (err) {
      logger.error(
        {
          err,
          issueId: issue.id,
          companyId: issue.companyId,
          decisionKind: decision.kind,
        },
        "[stalled-review-sweep] act failed",
      );
    }
  }

  return result;
}

type SweepDecision =
  | { kind: "rewake_assignee"; targetAgentId: string }
  | { kind: "rewake_participant"; targetAgentId: string }
  | { kind: "escalate"; targetAgentId: string; targetAgentName: string; source: EscalationSource }
  | { kind: "no_target" };

type EscalationSource = "project_lead" | "reports_to" | "office_operator";

async function resolveDecision(
  db: Db,
  issue: typeof issues.$inferSelect,
): Promise<SweepDecision> {
  // Action B primary — existing assignee is a valid reviewer.
  if (issue.assigneeAgentId) {
    const valid = await isAgentEligible(db, issue.companyId, issue.assigneeAgentId);
    if (valid) {
      return { kind: "rewake_assignee", targetAgentId: issue.assigneeAgentId };
    }
  }

  // Action A rare — policy-driven `executionState.currentParticipant` is set
  // to a distinct agent (different from the row assignee, which Action B
  // already handles). Only fires when policy-stage wiring left a participant
  // mismatched with the row.
  const participantAgentId = readCurrentParticipantAgentId(issue.executionState);
  if (
    participantAgentId &&
    participantAgentId !== issue.assigneeAgentId &&
    (await isAgentEligible(db, issue.companyId, participantAgentId))
  ) {
    return { kind: "rewake_participant", targetAgentId: participantAgentId };
  }

  // Action C — escalate.
  const target = await resolveEscalationTarget(db, issue);
  if (target) {
    return {
      kind: "escalate",
      targetAgentId: target.id,
      targetAgentName: target.name,
      source: target.source,
    };
  }

  return { kind: "no_target" };
}

interface EscalationCandidate {
  id: string;
  name: string;
  source: EscalationSource;
}

async function resolveEscalationTarget(
  db: Db,
  issue: typeof issues.$inferSelect,
): Promise<EscalationCandidate | null> {
  // 1. Project-scoped project lead.
  if (issue.projectId) {
    const rows = await db
      .select({
        id: agents.id,
        name: agents.name,
        status: agents.status,
        archetypeKey: agents.archetypeKey,
        createdAt: agents.createdAt,
      })
      .from(agentProjectScopes)
      .innerJoin(agents, eq(agents.id, agentProjectScopes.agentId))
      .where(
        and(
          eq(agentProjectScopes.projectId, issue.projectId),
          eq(agentProjectScopes.companyId, issue.companyId),
          eq(agentProjectScopes.scopeMode, "leadership_raw"),
          inArray(
            agents.archetypeKey,
            PROJECT_LEAD_ARCHETYPES as unknown as string[],
          ),
        ),
      );

    const eligible = rows.filter((row) => !INELIGIBLE_AGENT_STATUSES.includes(row.status));
    if (eligible.length > 0) {
      eligible.sort((left, right) => {
        const leftPriority = PROJECT_LEAD_PRIORITY[left.archetypeKey] ?? 0;
        const rightPriority = PROJECT_LEAD_PRIORITY[right.archetypeKey] ?? 0;
        if (leftPriority !== rightPriority) return rightPriority - leftPriority;
        return left.createdAt.getTime() - right.createdAt.getTime();
      });
      const pick = eligible[0];
      return { id: pick.id, name: pick.name, source: "project_lead" };
    }
  }

  // 2. Direct manager via reportsTo.
  if (issue.assigneeAgentId) {
    const [row] = await db
      .select({ reportsTo: agents.reportsTo })
      .from(agents)
      .where(eq(agents.id, issue.assigneeAgentId));
    if (row?.reportsTo) {
      const [manager] = await db
        .select({ id: agents.id, name: agents.name, status: agents.status })
        .from(agents)
        .where(eq(agents.id, row.reportsTo));
      if (manager && !INELIGIBLE_AGENT_STATUSES.includes(manager.status)) {
        return { id: manager.id, name: manager.name, source: "reports_to" };
      }
    }
  }

  // 3. Company-level office operator / COO fallback.
  const officeOperators = await db
    .select({ id: agents.id, name: agents.name, status: agents.status, createdAt: agents.createdAt })
    .from(agents)
    .where(
      and(
        eq(agents.companyId, issue.companyId),
        sql`(${agents.role} = 'coo' OR ${agents.archetypeKey} = ${OFFICE_OPERATOR_ARCHETYPE_KEY})`,
      ),
    );
  const eligibleOperator = officeOperators
    .filter((row) => !INELIGIBLE_AGENT_STATUSES.includes(row.status))
    .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())[0];
  if (eligibleOperator) {
    return { id: eligibleOperator.id, name: eligibleOperator.name, source: "office_operator" };
  }

  return null;
}

async function isAgentEligible(db: Db, companyId: string, agentId: string): Promise<boolean> {
  const [row] = await db
    .select({ status: agents.status })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)));
  if (!row) return false;
  return !INELIGIBLE_AGENT_STATUSES.includes(row.status);
}

async function loadRecentSweepCounts(
  db: Db,
  issueIds: string[],
  cutoff: Date,
): Promise<Map<string, number>> {
  if (issueIds.length === 0) return new Map();
  // Count only acted-upon decisions. The rate-cap branch writes audit rows under
  // the same SWEEP_ACTION with `details.decision = "skipped_rate_cap"`; if those
  // were counted, every subsequent sweep would add another skip row and the cap
  // would latch into a permanent block once it was hit.
  const rows = await db
    .select({ entityId: activityLog.entityId, count: sql<number>`cast(count(*) as int)` })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.entityType, "issue"),
        eq(activityLog.action, SWEEP_ACTION),
        inArray(activityLog.entityId, issueIds),
        gt(activityLog.createdAt, cutoff),
        sql`(${activityLog.details} ->> 'decision') is distinct from 'skipped_rate_cap'`,
      ),
    )
    .groupBy(activityLog.entityId);
  const map = new Map<string, number>();
  for (const row of rows) {
    map.set(row.entityId, Number(row.count));
  }
  return map;
}

function readCurrentParticipantAgentId(
  executionState: Record<string, unknown> | null | undefined,
): string | null {
  if (!executionState || typeof executionState !== "object") return null;
  const participant = (executionState as Record<string, unknown>).currentParticipant;
  if (!participant || typeof participant !== "object") return null;
  const principalType = (participant as Record<string, unknown>).type;
  if (principalType !== "agent") return null;
  const principalId = (participant as Record<string, unknown>).agentId;
  if (typeof principalId !== "string" || principalId.length === 0) return null;
  return principalId;
}

async function fireWake(
  deps: StalledReviewSweepDeps,
  agentId: string,
  issueId: string,
  issueStatus: string,
): Promise<void> {
  await deps.heartbeat.wakeup(agentId, {
    source: "automation",
    triggerDetail: "system",
    reason: "review_stalled",
    payload: { issueId, mutation: "sweep" },
    requestedByActorType: "system",
    requestedByActorId: null,
    contextSnapshot: {
      issueId,
      taskId: issueId,
      wakeReason: "review_stalled",
      source: "stalled-review-sweep",
      issueStatus,
    },
  });
}

async function postSweepComment(
  deps: StalledReviewSweepDeps,
  issueId: string,
  body: string,
): Promise<void> {
  await deps.issueService.addComment(issueId, body, { runId: null });
}

function buildRewakeCommentBody(idleHours: number): string {
  const formatted = formatIdleHours(idleHours);
  return (
    `**Stalled-review sweep** — re-woke the current reviewer after ${formatted} idle in \`in_review\`. ` +
    "Escalation will follow on the next sweep cycle if there is no progress."
  );
}

function buildEscalateCommentBody(idleHours: number, managerName: string): string {
  const formatted = formatIdleHours(idleHours);
  return (
    `**Stalled-review sweep** — no reviewer action for ${formatted}; escalating to ${managerName}. ` +
    "Prior reviewer context is preserved in the thread; lock columns were cleared on reassignment."
  );
}

function formatIdleHours(idleHours: number): string {
  if (idleHours < 1) return "<1h";
  if (idleHours < 48) return `${Math.round(idleHours)}h`;
  const days = Math.floor(idleHours / 24);
  return `${days}d`;
}
