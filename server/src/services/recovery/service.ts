import { and, asc, desc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentWakeupRequests,
  agents,
  approvals,
  companies,
  heartbeatRuns,
  issueApprovals,
  issueRelations,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { clampIssueRequestDepth } from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { logActivity } from "../activity-log.js";
import { budgetService } from "../budgets.js";
import { issueService } from "../issues.js";
import { classifyIssueGraphLiveness, type IssueLivenessFinding } from "./issue-graph-liveness.js";
import {
  RECOVERY_ORIGIN_KINDS,
  buildIssueGraphLivenessLeafKey,
} from "./origins.js";
import { isAutomaticRecoverySuppressedByPauseHold } from "./pause-hold-guard.js";

const ACTIVE_ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked"];
const EXECUTION_PATH_RUN_STATUSES = ["queued", "running", "scheduled_retry"];
const WAKE_PATH_STATUSES = ["queued", "deferred_issue_execution"];
const INVOKABLE_AGENT_STATUSES = new Set(["active", "idle", "running", "error"]);
const DEFAULT_MAX_COMPANIES_PER_SWEEP = 10;
const DEFAULT_MAX_FINDINGS_PER_COMPANY = 8;
const DEFAULT_MAX_STRANDED_RECOVERIES_PER_COMPANY = 12;
const MAX_RECOVERY_TICKS = 50;

type EnqueueWakeup = (
  agentId: string,
  opts?: {
    source?: "timer" | "assignment" | "on_demand" | "automation";
    triggerDetail?: "manual" | "ping" | "callback" | "system";
    reason?: string | null;
    payload?: Record<string, unknown> | null;
    idempotencyKey?: string | null;
    requestedByActorType?: "user" | "agent" | "system";
    requestedByActorId?: string | null;
    contextSnapshot?: Record<string, unknown>;
  },
) => Promise<unknown | null>;

export interface RecoverySweepResult {
  scannedCompanies: number;
  classifiedIssues: number;
  findings: number;
  suppressedByPauseHold: number;
  skippedExisting: number;
  skippedNoOwner: number;
  skippedBudget: number;
  createdRecoveryIssues: number;
  strandedScanned: number;
  strandedRecovered: number;
  failed: number;
}

export interface RecoverySweepTick extends RecoverySweepResult {
  at: string;
}

const recoveryTicks: RecoverySweepTick[] = [];

function pushRecoveryTick(result: RecoverySweepResult, now: Date) {
  recoveryTicks.unshift({ ...result, at: now.toISOString() });
  recoveryTicks.splice(MAX_RECOVERY_TICKS);
}

export function listRecoverySweepTicks(limit = 20): RecoverySweepTick[] {
  const bounded = Math.max(1, Math.min(MAX_RECOVERY_TICKS, Math.floor(limit)));
  return recoveryTicks.slice(0, bounded);
}

function emptyResult(): RecoverySweepResult {
  return {
    scannedCompanies: 0,
    classifiedIssues: 0,
    findings: 0,
    suppressedByPauseHold: 0,
    skippedExisting: 0,
    skippedNoOwner: 0,
    skippedBudget: 0,
    createdRecoveryIssues: 0,
    strandedScanned: 0,
    strandedRecovered: 0,
    failed: 0,
  };
}

function recoveryTitle(finding: IssueLivenessFinding) {
  const label = finding.identifier ?? finding.issueId;
  return `Recover liveness for ${label}`;
}

function recoveryDescription(finding: IssueLivenessFinding) {
  const path = finding.dependencyPath.length > 0
    ? finding.dependencyPath.map((entry) => `- ${entry.identifier ?? entry.issueId}: ${entry.title} (${entry.status})`).join("\n")
    : "- none";
  const candidateLines = finding.recommendedOwnerCandidates.length > 0
    ? finding.recommendedOwnerCandidates.map((candidate) => `- ${candidate.agentId}: ${candidate.reason}`).join("\n")
    : "- none";
  return [
    "Paperclip recovery detected an issue graph liveness break.",
    "",
    "## Finding",
    "",
    `- State: \`${finding.state}\``,
    `- Severity: \`${finding.severity}\``,
    `- Reason: ${finding.reason}`,
    `- Incident key: \`${finding.incidentKey}\``,
    "",
    "## Dependency Path",
    "",
    path,
    "",
    "## Recommended Action",
    "",
    finding.recommendedAction,
    "",
    "## Owner Candidates",
    "",
    candidateLines,
  ].join("\n");
}

function strandedWakeKey(issueId: string) {
  return `stranded_issue_recovery:${issueId}`;
}

export function recoveryService(db: Db, deps?: { enqueueWakeup?: EnqueueWakeup }) {
  const issuesSvc = issueService(db);
  const budgets = budgetService(db);

  async function findOpenRecoveryIssue(companyId: string, originKind: string, originId: string, originFingerprint?: string) {
    const rows = await db
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, originKind),
          eq(issues.originId, originId),
          originFingerprint ? eq(issues.originFingerprint, originFingerprint) : undefined,
          isNull(issues.hiddenAt),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async function chooseOwner(finding: IssueLivenessFinding) {
    for (const agentId of finding.recommendedOwnerCandidateAgentIds) {
      const agent = await db
        .select({ id: agents.id, companyId: agents.companyId, status: agents.status })
        .from(agents)
        .where(eq(agents.id, agentId))
        .then((rows) => rows[0] ?? null);
      if (!agent || agent.companyId !== finding.companyId || !INVOKABLE_AGENT_STATUSES.has(agent.status)) continue;
      const budgetBlock = await budgets.getInvocationBlock(finding.companyId, agent.id, {
        issueId: finding.recoveryIssueId,
      });
      if (!budgetBlock) return agent.id;
    }
    return null;
  }

  async function createRecoveryIssue(finding: IssueLivenessFinding, result: RecoverySweepResult) {
    if (await isAutomaticRecoverySuppressedByPauseHold(db, finding.companyId, finding.recoveryIssueId)) {
      result.suppressedByPauseHold += 1;
      return;
    }

    const leafKey = buildIssueGraphLivenessLeafKey({
      companyId: finding.companyId,
      state: finding.state,
      leafIssueId: finding.recoveryIssueId,
    });
    const existing = await findOpenRecoveryIssue(
      finding.companyId,
      RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation,
      finding.incidentKey,
      leafKey,
    );
    if (existing) {
      result.skippedExisting += 1;
      return;
    }

    const sourceIssue = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, finding.companyId), eq(issues.id, finding.issueId)))
      .then((rows) => rows[0] ?? null);
    if (!sourceIssue) {
      result.failed += 1;
      return;
    }

    const ownerAgentId = await chooseOwner(finding);
    if (!ownerAgentId) {
      result.skippedNoOwner += 1;
      return;
    }

    try {
      const recovery = await issuesSvc.create(finding.companyId, {
        title: recoveryTitle(finding),
        description: recoveryDescription(finding),
        status: "todo",
        priority: finding.severity === "critical" ? "high" : "medium",
        parentId: finding.issueId,
        projectId: sourceIssue.projectId,
        goalId: sourceIssue.goalId,
        billingCode: sourceIssue.billingCode,
        assigneeAgentId: ownerAgentId,
        originKind: RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation,
        originId: finding.incidentKey,
        originFingerprint: leafKey,
        requestDepth: clampIssueRequestDepth(sourceIssue.requestDepth + 1),
      });
      result.createdRecoveryIssues += 1;
      await logActivity(db, {
        companyId: finding.companyId,
        actorType: "system",
        actorId: "system",
        agentId: ownerAgentId,
        action: "issue.recovery_created",
        entityType: "issue",
        entityId: recovery.id,
        details: {
          source: "recovery.issue_graph_liveness",
          sourceIssueId: finding.issueId,
          recoveryIssueId: finding.recoveryIssueId,
          state: finding.state,
          incidentKey: finding.incidentKey,
        },
      });
      if (deps?.enqueueWakeup) {
        await deps.enqueueWakeup(ownerAgentId, {
          source: "assignment",
          triggerDetail: "system",
          reason: "issue_assigned",
          payload: { issueId: recovery.id, sourceIssueId: finding.issueId, recoveryState: finding.state },
          idempotencyKey: `recovery:${recovery.id}`,
          requestedByActorType: "system",
          requestedByActorId: "recovery",
          contextSnapshot: {
            issueId: recovery.id,
            taskId: recovery.id,
            taskKey: recovery.id,
            wakeReason: "issue_assigned",
            source: RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation,
            sourceIssueId: finding.issueId,
            recoveryState: finding.state,
          },
        });
      }
    } catch (err) {
      const maybe = err as { code?: string; constraint?: string; message?: string };
      const uniqueConflict = maybe.code === "23505" &&
        typeof maybe.message === "string" &&
        (
          maybe.message.includes("issues_active_liveness_recovery_incident_uq") ||
          maybe.message.includes("issues_active_liveness_recovery_leaf_uq")
        );
      if (uniqueConflict) {
        result.skippedExisting += 1;
        return;
      }
      result.failed += 1;
      logger.warn({ err, finding }, "recovery issue creation failed");
    }
  }

  async function loadClassificationInput(companyId: string) {
    const [issueRows, relationRows, agentRows, activeRows, wakeRows, interactionRows, approvalRows, openRecoveryRows] =
      await Promise.all([
        db
          .select()
          .from(issues)
          .where(and(eq(issues.companyId, companyId), isNull(issues.hiddenAt), inArray(issues.status, ACTIVE_ISSUE_STATUSES))),
        db
          .select({
            companyId: issueRelations.companyId,
            blockerIssueId: issueRelations.issueId,
            blockedIssueId: issueRelations.relatedIssueId,
          })
          .from(issueRelations)
          .where(and(eq(issueRelations.companyId, companyId), eq(issueRelations.type, "blocks"))),
        db
          .select()
          .from(agents)
          .where(eq(agents.companyId, companyId)),
        db
          .select({
            companyId: heartbeatRuns.companyId,
            issueId: sql<string | null>`${heartbeatRuns.contextSnapshot}->>'issueId'`,
            agentId: heartbeatRuns.agentId,
            status: heartbeatRuns.status,
          })
          .from(heartbeatRuns)
          .where(and(eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.status, EXECUTION_PATH_RUN_STATUSES))),
        db
          .select({
            companyId: agentWakeupRequests.companyId,
            issueId: sql<string | null>`${agentWakeupRequests.payload}->>'issueId'`,
            agentId: agentWakeupRequests.agentId,
            status: agentWakeupRequests.status,
          })
          .from(agentWakeupRequests)
          .where(and(eq(agentWakeupRequests.companyId, companyId), inArray(agentWakeupRequests.status, WAKE_PATH_STATUSES))),
        db
          .select({
            companyId: issueThreadInteractions.companyId,
            issueId: issueThreadInteractions.issueId,
            status: issueThreadInteractions.status,
          })
          .from(issueThreadInteractions)
          .where(and(eq(issueThreadInteractions.companyId, companyId), eq(issueThreadInteractions.status, "pending"))),
        db
          .select({
            companyId: issueApprovals.companyId,
            issueId: issueApprovals.issueId,
            status: approvals.status,
          })
          .from(issueApprovals)
          .innerJoin(approvals, eq(approvals.id, issueApprovals.approvalId))
          .where(and(eq(issueApprovals.companyId, companyId), inArray(approvals.status, ["pending", "revision_requested"]))),
        db
          .select({
            companyId: issues.companyId,
            issueId: issues.parentId,
            status: issues.status,
          })
          .from(issues)
          .where(
            and(
              eq(issues.companyId, companyId),
              eq(issues.originKind, RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation),
              isNull(issues.hiddenAt),
              notInArray(issues.status, ["done", "cancelled"]),
            ),
          ),
      ]);

    return {
      issues: issueRows,
      relations: relationRows,
      agents: agentRows,
      activeRuns: activeRows.filter((row): row is typeof row & { issueId: string } => row.issueId !== null),
      queuedWakeRequests: wakeRows.filter((row): row is typeof row & { issueId: string } => row.issueId !== null),
      pendingInteractions: interactionRows,
      pendingApprovals: approvalRows,
      openRecoveryIssues: openRecoveryRows.filter(
        (row): row is typeof row & { issueId: string } => row.issueId !== null,
      ),
    };
  }

  async function recoverStrandedAssignedWork(companyId: string, result: RecoverySweepResult, opts: { limit: number }) {
    if (!deps?.enqueueWakeup) return;
    const candidates = await db
      .select({
        issue: issues,
        agentId: agents.id,
        agentStatus: agents.status,
      })
      .from(issues)
      .innerJoin(agents, eq(agents.id, issues.assigneeAgentId))
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(agents.companyId, companyId),
          isNull(issues.hiddenAt),
          isNull(issues.assigneeUserId),
          inArray(issues.status, ["backlog", "todo", "in_progress"]),
          inArray(agents.status, ["active", "idle", "running", "error"]),
          sql`not exists (
            select 1 from ${heartbeatRuns}
            where ${heartbeatRuns.companyId} = ${issues.companyId}
              and ${heartbeatRuns.agentId} = ${issues.assigneeAgentId}
              and ${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')
              and (${heartbeatRuns.contextSnapshot}->>'issueId') = ${issues.id}::text
          )`,
          sql`not exists (
            select 1 from ${agentWakeupRequests}
            where ${agentWakeupRequests.companyId} = ${issues.companyId}
              and ${agentWakeupRequests.agentId} = ${issues.assigneeAgentId}
              and ${agentWakeupRequests.status} in ('queued', 'deferred_issue_execution')
              and (${agentWakeupRequests.payload}->>'issueId') = ${issues.id}::text
          )`,
        ),
      )
      .orderBy(asc(issues.updatedAt), asc(issues.id))
      .limit(opts.limit);

    result.strandedScanned += candidates.length;
    const readiness = await issuesSvc.listDependencyReadiness(companyId, candidates.map((row) => row.issue.id));
    for (const candidate of candidates) {
      const issue = candidate.issue;
      if (result.strandedRecovered >= opts.limit) break;
      if (await isAutomaticRecoverySuppressedByPauseHold(db, issue.companyId, issue.id)) {
        result.suppressedByPauseHold += 1;
        continue;
      }
      const dependency = readiness.get(issue.id);
      if (dependency && !dependency.isDependencyReady) continue;
      const budgetBlock = await budgets.getInvocationBlock(issue.companyId, candidate.agentId, {
        issueId: issue.id,
        projectId: issue.projectId,
      });
      if (budgetBlock) {
        result.skippedBudget += 1;
        continue;
      }
      const idempotencyKey = strandedWakeKey(issue.id);
      const existing = await db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, issue.companyId),
            eq(agentWakeupRequests.idempotencyKey, idempotencyKey),
            inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution", "completed"]),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (existing) {
        result.skippedExisting += 1;
        continue;
      }
      await deps.enqueueWakeup(candidate.agentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: RECOVERY_ORIGIN_KINDS.strandedIssueRecovery,
        payload: { issueId: issue.id, originKind: RECOVERY_ORIGIN_KINDS.strandedIssueRecovery },
        idempotencyKey,
        requestedByActorType: "system",
        requestedByActorId: "recovery",
        contextSnapshot: {
          issueId: issue.id,
          taskId: issue.id,
          taskKey: issue.id,
          wakeReason: RECOVERY_ORIGIN_KINDS.strandedIssueRecovery,
          source: RECOVERY_ORIGIN_KINDS.strandedIssueRecovery,
        },
      });
      result.strandedRecovered += 1;
    }
  }

  async function runGuardedRecoverySweep(opts?: {
    now?: Date;
    companyId?: string;
    maxCompanies?: number;
    maxFindingsPerCompany?: number;
    maxStrandedRecoveriesPerCompany?: number;
  }): Promise<RecoverySweepResult> {
    const now = opts?.now ?? new Date();
    const result = emptyResult();
    const companyRows = opts?.companyId
      ? [{ id: opts.companyId }]
      : await db
        .select({ id: companies.id })
        .from(companies)
        .where(notInArray(companies.status, ["archived"]))
        .orderBy(asc(companies.createdAt), asc(companies.id))
        .limit(opts?.maxCompanies ?? DEFAULT_MAX_COMPANIES_PER_SWEEP);

    for (const company of companyRows) {
      result.scannedCompanies += 1;
      try {
        const input = await loadClassificationInput(company.id);
        result.classifiedIssues += input.issues.length;
        const findings = classifyIssueGraphLiveness(input)
          .slice(0, opts?.maxFindingsPerCompany ?? DEFAULT_MAX_FINDINGS_PER_COMPANY);
        result.findings += findings.length;
        for (const finding of findings) {
          await createRecoveryIssue(finding, result);
        }
        await recoverStrandedAssignedWork(company.id, result, {
          limit: opts?.maxStrandedRecoveriesPerCompany ?? DEFAULT_MAX_STRANDED_RECOVERIES_PER_COMPANY,
        });
      } catch (err) {
        result.failed += 1;
        logger.warn({ err, companyId: company.id }, "recovery sweep failed for company");
      }
    }

    pushRecoveryTick(result, now);
    return result;
  }

  return {
    runGuardedRecoverySweep,
  };
}
