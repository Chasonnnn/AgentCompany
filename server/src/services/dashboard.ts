import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvals, companies, costEvents, heartbeatRuns, issueDecisionQuestions, issues } from "@paperclipai/db";
import {
  COMPUTED_AGENT_STATES,
  groupOperatorState,
  type ComputedAgentState,
  type DashboardSummary,
} from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { agentService } from "./agents.js";
import { budgetService } from "./budgets.js";
import { buildIssueContinuitySummary } from "./issue-continuity-summary.js";
import { buildIssueOperatorState } from "./issue-operator-state.js";

function getLast14Days() {
  return Array.from({ length: 14 }, (_, index) => {
    const date = new Date();
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCDate(date.getUTCDate() - (13 - index));
    return date.toISOString().slice(0, 10);
  });
}

export function dashboardService(db: Db) {
  const budgets = budgetService(db);
  const agentSvc = agentService(db);
  return {
    summary: async (companyId: string): Promise<DashboardSummary> => {
      const company = await db
        .select()
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);

      if (!company) throw notFound("Company not found");

      const agentRows = await db
        .select({ status: agents.status, count: sql<number>`count(*)` })
        .from(agents)
        .where(eq(agents.companyId, companyId))
        .groupBy(agents.status);

      const taskRows = await db
        .select({ status: issues.status, count: sql<number>`count(*)` })
        .from(issues)
        .where(eq(issues.companyId, companyId))
        .groupBy(issues.status);

      const [
        pendingApprovals,
        continuityRows,
        simplificationReport,
        openDecisionQuestionCount,
        blockingDecisionQuestionCount,
        openDecisionQuestionRows,
        runRows,
      ] = await Promise.all([
        db
          .select({ count: sql<number>`count(*)` })
          .from(approvals)
          .where(and(eq(approvals.companyId, companyId), eq(approvals.status, "pending")))
          .then((rows) => Number(rows[0]?.count ?? 0)),
        db
          .select({
            assigneeAgentId: issues.assigneeAgentId,
            continuityState: issues.continuityState,
            executionState: issues.executionState,
            status: issues.status,
          })
          .from(issues)
          .where(and(eq(issues.companyId, companyId), sql`${issues.hiddenAt} is null`, sql`${issues.status} <> 'done'`, sql`${issues.status} <> 'cancelled'`)),
        agentSvc.orgSimplificationForCompany(companyId),
        db
          .select({ count: sql<number>`count(*)` })
          .from(issueDecisionQuestions)
          .where(and(eq(issueDecisionQuestions.companyId, companyId), eq(issueDecisionQuestions.status, "open")))
          .then((rows) => Number(rows[0]?.count ?? 0)),
        db
          .select({ count: sql<number>`count(*)` })
          .from(issueDecisionQuestions)
          .where(
            and(
              eq(issueDecisionQuestions.companyId, companyId),
              eq(issueDecisionQuestions.status, "open"),
              eq(issueDecisionQuestions.blocking, true),
            ),
          )
          .then((rows) => Number(rows[0]?.count ?? 0)),
        db
          .select({
            id: issueDecisionQuestions.id,
            issueId: issueDecisionQuestions.issueId,
            title: issueDecisionQuestions.title,
            blocking: issueDecisionQuestions.blocking,
            createdAt: issueDecisionQuestions.createdAt,
            issueIdentifier: issues.identifier,
            issueTitle: issues.title,
          })
          .from(issueDecisionQuestions)
          .innerJoin(issues, eq(issueDecisionQuestions.issueId, issues.id))
          .where(and(eq(issueDecisionQuestions.companyId, companyId), eq(issueDecisionQuestions.status, "open")))
          .orderBy(sql`${issueDecisionQuestions.createdAt} desc`)
          .limit(8),
        db
          .select({
            createdAt: heartbeatRuns.createdAt,
            status: heartbeatRuns.status,
          })
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.companyId, companyId),
              gte(heartbeatRuns.createdAt, (() => {
                const date = new Date();
                date.setUTCHours(0, 0, 0, 0);
                date.setUTCDate(date.getUTCDate() - 13);
                return date;
              })()),
            ),
          ),
      ]);

      const agentCounts: DashboardSummary["agents"] = {
        active: 0,
        running: 0,
        paused: 0,
        error: 0,
        composition: simplificationReport.counts,
      };
      for (const row of agentRows) {
        const count = Number(row.count);
        switch (row.status) {
          case "idle":
          case "active":
          case "pending_approval":
            agentCounts.active += count;
            break;
          case "running":
            agentCounts.running += count;
            break;
          case "paused":
            agentCounts.paused += count;
            break;
          case "error":
            agentCounts.error += count;
            break;
          default:
            break;
        }
      }

      const taskCounts: DashboardSummary["tasks"] = {
        open: 0,
        inProgress: 0,
        blocked: 0,
        done: 0,
        operatorStates: [],
        computedAgentStates: [],
      };
      const activeContinuityOwners = new Set<string>();
      const executionHealth = {
        activeContinuityOwners: 0,
        blockedMissingDocs: 0,
        staleProgress: 0,
        invalidHandoff: 0,
        openReviewFindings: 0,
        returnedBranches: 0,
        handoffPending: 0,
      };
      const operatorStateCounts = new Map<string, number>();
      const operatorStateReasons = new Map<string, number>();
      const computedAgentStateCounts = new Map<ComputedAgentState, number>(
        COMPUTED_AGENT_STATES.map((state) => [state, 0]),
      );
      const computedAgentStateDetail = new Map<ComputedAgentState, Map<string, number>>(
        COMPUTED_AGENT_STATES.map((state) => [state, new Map<string, number>()]),
      );
      const loggedCoverageMisses = new Set<string>();
      for (const row of taskRows) {
        const count = Number(row.count);
        if (row.status === "in_progress") taskCounts.inProgress += count;
        if (row.status === "blocked") taskCounts.blocked += count;
        if (row.status === "done") taskCounts.done += count;
        if (row.status !== "done" && row.status !== "cancelled") taskCounts.open += count;
      }

      for (const row of continuityRows) {
        const summary = buildIssueContinuitySummary({
          continuityState: row.continuityState,
          executionState: row.executionState,
        });
        const operator = buildIssueOperatorState({
          issueId: "",
          status: row.status as any,
          continuitySummary: summary,
        });
        operatorStateCounts.set(operator.operatorState, (operatorStateCounts.get(operator.operatorState) ?? 0) + 1);
        operatorStateReasons.set(
          `${operator.operatorState}::${operator.operatorReason}`,
          (operatorStateReasons.get(`${operator.operatorState}::${operator.operatorReason}`) ?? 0) + 1,
        );
        const grouped = groupOperatorState(operator.operatorState, {
          onCoverageMiss: (miss) => {
            if (loggedCoverageMisses.has(miss.detailed)) return;
            loggedCoverageMisses.add(miss.detailed);
            logger.warn(
              {
                companyId,
                detailedOperatorState: miss.detailed,
                fallbackComputedAgentState: miss.fallback,
                event: "computed_agent_state.coverage_miss",
              },
              "Unmapped detailed operator state fell back to idle; update groupOperatorState mapping.",
            );
          },
        });
        computedAgentStateCounts.set(grouped, (computedAgentStateCounts.get(grouped) ?? 0) + 1);
        const detailBucket = computedAgentStateDetail.get(grouped);
        if (detailBucket) {
          detailBucket.set(
            operator.operatorState,
            (detailBucket.get(operator.operatorState) ?? 0) + 1,
          );
        }
        const state = row.continuityState as {
          status?: string | null;
          health?: string | null;
          returnedBranchIssueIds?: string[];
        } | null;
        if ((summary?.status === "active" || summary?.status === "ready" || summary?.status === "handoff_pending") && row.assigneeAgentId) {
          activeContinuityOwners.add(row.assigneeAgentId);
        }
        if (state?.health === "missing_required_docs") executionHealth.blockedMissingDocs += 1;
        if (state?.health === "stale_progress") executionHealth.staleProgress += 1;
        if (state?.health === "invalid_handoff") executionHealth.invalidHandoff += 1;
        if (summary?.openReviewFindings) executionHealth.openReviewFindings += 1;
        executionHealth.returnedBranches += state?.returnedBranchIssueIds?.length ?? 0;
        if (state?.status === "handoff_pending") executionHealth.handoffPending += 1;
      }
      executionHealth.activeContinuityOwners = activeContinuityOwners.size;
      taskCounts.operatorStates = Array.from(operatorStateCounts.entries()).map(([state, count]) => ({
        state,
        count,
      }));
      taskCounts.computedAgentStates = COMPUTED_AGENT_STATES.map((state) => ({
        state,
        count: computedAgentStateCounts.get(state) ?? 0,
        detailedStates: Array.from(computedAgentStateDetail.get(state)?.entries() ?? [])
          .map(([detailed, count]) => ({ state: detailed, count }))
          .sort((a, b) => b.count - a.count || a.state.localeCompare(b.state)),
      }));

      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const [{ monthSpend }] = await db
        .select({
          monthSpend: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
        })
        .from(costEvents)
        .where(
          and(
            eq(costEvents.companyId, companyId),
            gte(costEvents.occurredAt, monthStart),
          ),
        );

      const monthSpendCents = Number(monthSpend);
      const utilization =
        company.budgetMonthlyCents > 0
          ? (monthSpendCents / company.budgetMonthlyCents) * 100
          : 0;
      const budgetOverview = await budgets.overview(companyId);
      const runActivityByDate = new Map(
        getLast14Days().map((date) => [date, {
          date,
          succeeded: 0,
          failed: 0,
          other: 0,
          total: 0,
        }]),
      );
      for (const row of runRows) {
        const date = row.createdAt.toISOString().slice(0, 10);
        const bucket = runActivityByDate.get(date);
        if (!bucket) continue;
        bucket.total += 1;
        if (row.status === "succeeded") bucket.succeeded += 1;
        else if (row.status === "failed" || row.status === "timed_out") bucket.failed += 1;
        else bucket.other += 1;
      }

      return {
        companyId,
        agents: {
          active: agentCounts.active,
          running: agentCounts.running,
          paused: agentCounts.paused,
          error: agentCounts.error,
          composition: agentCounts.composition,
        },
        tasks: taskCounts,
        costs: {
          monthSpendCents,
          monthBudgetCents: company.budgetMonthlyCents,
          monthUtilizationPercent: Number(utilization.toFixed(2)),
        },
        pendingApprovals,
        decisionQuestions: {
          open: openDecisionQuestionCount,
          blocking: blockingDecisionQuestionCount,
          recent: openDecisionQuestionRows.map((row) => ({
            id: row.id,
            issueId: row.issueId,
            issueIdentifier: row.issueIdentifier ?? null,
            issueTitle: row.issueTitle,
            title: row.title,
            blocking: row.blocking,
            createdAt: row.createdAt.toISOString(),
          })),
        },
        executionHealth,
        operatorStateReasons: Array.from(operatorStateReasons.entries()).map(([key, count]) => {
          const [state, reason] = key.split("::", 2);
          return { state, reason, count };
        }),
        budgets: {
          activeIncidents: budgetOverview.activeIncidents.length,
          pendingApprovals: budgetOverview.pendingApprovalCount,
          pausedAgents: budgetOverview.pausedAgentCount,
          pausedProjects: budgetOverview.pausedProjectCount,
        },
        runActivity: [...runActivityByDate.values()],
      };
    },
  };
}
