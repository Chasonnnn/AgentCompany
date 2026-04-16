import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvals, companies, costEvents, issues } from "@paperclipai/db";
import type { DashboardSummary } from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { agentService } from "./agents.js";
import { budgetService } from "./budgets.js";
import { buildIssueContinuitySummary } from "./issue-continuity-summary.js";

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

      const [pendingApprovals, continuityRows, simplificationReport] = await Promise.all([
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
        executionHealth,
        budgets: {
          activeIncidents: budgetOverview.activeIncidents.length,
          pendingApprovals: budgetOverview.pendingApprovalCount,
          pausedAgents: budgetOverview.pausedAgentCount,
          pausedProjects: budgetOverview.pausedProjectCount,
        },
      };
    },
  };
}
