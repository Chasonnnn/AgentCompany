import { and, desc, eq, gte, isNotNull, isNull, lt, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import { activityLog, agents, companies, costEvents, issues, projects } from "@paperclipai/db";
import { notFound, unprocessable } from "../errors.js";
import { budgetService, type BudgetServiceHooks } from "./budgets.js";
import { estimateApiEquivalentCostCents } from "./api-equivalent-pricing.js";
import { financeService } from "./finance.js";

export interface CostDateRange {
  from?: Date;
  to?: Date;
}

const METERED_BILLING_TYPE = "metered_api";
const SUBSCRIPTION_BILLING_TYPES = ["subscription_included", "subscription_overage"] as const;
const SUBSCRIPTION_BILLING_SQL = sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `);
const estimatedApiCostBackfills = new WeakMap<object, Promise<void>>();

function currentUtcMonthWindow(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return {
    start: new Date(Date.UTC(year, month, 1, 0, 0, 0, 0)),
    end: new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0)),
  };
}

async function getMonthlySpendTotal(
  db: Db,
  scope: { companyId: string; agentId?: string | null },
) {
  const { start, end } = currentUtcMonthWindow();
  const conditions = [
    eq(costEvents.companyId, scope.companyId),
    gte(costEvents.occurredAt, start),
    lt(costEvents.occurredAt, end),
  ];
  if (scope.agentId) {
    conditions.push(eq(costEvents.agentId, scope.agentId));
  }
  const [row] = await db
    .select({
      total: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
    })
    .from(costEvents)
    .where(and(...conditions));
  return Number(row?.total ?? 0);
}

async function backfillEstimatedApiCosts(db: Db) {
  const rows = await db
    .select({
      id: costEvents.id,
      model: costEvents.model,
      inputTokens: costEvents.inputTokens,
      cachedInputTokens: costEvents.cachedInputTokens,
      cacheCreationInputTokens: costEvents.cacheCreationInputTokens,
      outputTokens: costEvents.outputTokens,
    })
    .from(costEvents)
    .where(isNull(costEvents.estimatedApiCostCents));

  for (const row of rows) {
    const estimatedApiCostCents = estimateApiEquivalentCostCents({
      model: row.model,
      inputTokens: row.inputTokens,
      cachedInputTokens: row.cachedInputTokens,
      cacheCreationInputTokens: row.cacheCreationInputTokens,
      outputTokens: row.outputTokens,
    });

    await db
      .update(costEvents)
      .set({ estimatedApiCostCents })
      .where(eq(costEvents.id, row.id));
  }
}

async function ensureEstimatedApiCostBackfill(db: Db) {
  const key = db as object;
  let pending = estimatedApiCostBackfills.get(key);
  if (!pending) {
    pending = backfillEstimatedApiCosts(db).finally(() => {
      estimatedApiCostBackfills.delete(key);
    });
    estimatedApiCostBackfills.set(key, pending);
  }
  await pending;
}

export function costService(db: Db, budgetHooks: BudgetServiceHooks = {}) {
  return {
    createEvent: async (companyId: string, data: Omit<typeof costEvents.$inferInsert, "companyId">) => {
      const estimatedApiCostCents = estimateApiEquivalentCostCents({
        model: data.model,
        inputTokens: data.inputTokens ?? 0,
        cachedInputTokens: data.cachedInputTokens ?? 0,
        cacheCreationInputTokens: data.cacheCreationInputTokens ?? 0,
        outputTokens: data.outputTokens ?? 0,
      });
      return db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const budgets = budgetService(txDb, budgetHooks);
        const finance = financeService(txDb);
        const agent = await tx
          .select()
          .from(agents)
          .where(eq(agents.id, data.agentId))
          .then((rows) => rows[0] ?? null);

        if (!agent) throw notFound("Agent not found");
        if (agent.companyId !== companyId) {
          throw unprocessable("Agent does not belong to company");
        }

        const event = await tx
          .insert(costEvents)
          .values({
            ...data,
            companyId,
            biller: data.biller ?? data.provider,
            billingType: data.billingType ?? "unknown",
            cachedInputTokens: data.cachedInputTokens ?? 0,
            cacheCreationInputTokens: data.cacheCreationInputTokens ?? 0,
            estimatedApiCostCents,
            retryDisposition: data.retryDisposition ?? "charge_full",
          })
          .returning()
          .then((rows) => rows[0]);

        await finance.createEvent(companyId, {
          agentId: event.agentId,
          issueId: event.issueId,
          projectId: event.projectId,
          heartbeatRunId: event.heartbeatRunId,
          costEventId: event.id,
          eventKind: "inference_charge",
          biller: event.biller,
          amountCents: event.costCents,
          currency: "USD",
          direction: "debit",
          estimated: false,
          unit: "cents",
          quantity: 1,
          occurredAt: event.occurredAt,
          billingCode: event.billingCode ?? null,
          metadataJson: {
            provider: event.provider,
            billingType: event.billingType,
            model: event.model,
            retryDisposition: event.retryDisposition ?? "charge_full",
          },
          retryDisposition: event.retryDisposition ?? "charge_full",
        });

        const [agentMonthSpend, companyMonthSpend] = await Promise.all([
          getMonthlySpendTotal(txDb, { companyId, agentId: event.agentId }),
          getMonthlySpendTotal(txDb, { companyId }),
        ]);

        await tx
          .update(agents)
          .set({
            spentMonthlyCents: agentMonthSpend,
            updatedAt: new Date(),
          })
          .where(eq(agents.id, event.agentId));

        await tx
          .update(companies)
          .set({
            spentMonthlyCents: companyMonthSpend,
            updatedAt: new Date(),
          })
          .where(eq(companies.id, companyId));

        await budgets.evaluateCostEvent(event);

        return event;
      });
    },

    summary: async (companyId: string, range?: CostDateRange) => {
      await ensureEstimatedApiCostBackfill(db);

      const company = await db
        .select()
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);

      if (!company) throw notFound("Company not found");

      const conditions: ReturnType<typeof eq>[] = [eq(costEvents.companyId, companyId)];
      if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));

      const [{ total, estimatedTotal }] = await db
        .select({
          total: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
          estimatedTotal: sql<number>`coalesce(sum(${costEvents.estimatedApiCostCents}), 0)::int`,
        })
        .from(costEvents)
        .where(and(...conditions));

      const spendCents = Number(total);
      const estimatedApiCostCents = Number(estimatedTotal);
      const utilization =
        company.budgetMonthlyCents > 0
          ? (spendCents / company.budgetMonthlyCents) * 100
          : 0;

      return {
        companyId,
        spendCents,
        estimatedApiCostCents,
        budgetCents: company.budgetMonthlyCents,
        utilizationPercent: Number(utilization.toFixed(2)),
      };
    },

    issueTreeSummary: async (companyId: string, issueId: string) => {
      // Callers must resolve and authorize a visible root issue before invoking this.
      // The route does that so zero counts are not mistaken for a missing root.
      const childIssues = alias(issues, "child");
      const issueTreeCondition = sql<boolean>`
        ${issues.id} IN (
          WITH RECURSIVE issue_tree(id) AS (
            SELECT ${issues.id}
            FROM ${issues}
            WHERE ${issues.companyId} = ${companyId}
              AND ${issues.id} = ${issueId}
              AND ${issues.hiddenAt} IS NULL
            UNION ALL
            SELECT ${childIssues.id}
            FROM ${issues} ${childIssues}
            JOIN issue_tree ON ${childIssues.parentId} = issue_tree.id
            WHERE ${childIssues.companyId} = ${companyId}
              AND ${childIssues.hiddenAt} IS NULL
          )
          SELECT id FROM issue_tree
        )
      `;

      const [row] = await db
        .select({
          issueCount: sql<number>`count(distinct ${issues.id})::int`,
          costCents: sumAsNumber(costEvents.costCents),
          inputTokens: sumAsNumber(costEvents.inputTokens),
          cachedInputTokens: sumAsNumber(costEvents.cachedInputTokens),
          outputTokens: sumAsNumber(costEvents.outputTokens),
        })
        .from(issues)
        .leftJoin(
          costEvents,
          and(
            eq(costEvents.companyId, companyId),
            eq(costEvents.issueId, issues.id),
          ),
        )
        .where(
          and(
            eq(issues.companyId, companyId),
            isNull(issues.hiddenAt),
            issueTreeCondition,
          ),
        );

      return {
        issueId,
        issueCount: Number(row?.issueCount ?? 0),
        includeDescendants: true,
        costCents: Number(row?.costCents ?? 0),
        inputTokens: Number(row?.inputTokens ?? 0),
        cachedInputTokens: Number(row?.cachedInputTokens ?? 0),
        outputTokens: Number(row?.outputTokens ?? 0),
      };
    },

    byAgent: async (companyId: string, range?: CostDateRange) => {
      await ensureEstimatedApiCostBackfill(db);

      const conditions: ReturnType<typeof eq>[] = [eq(costEvents.companyId, companyId)];
      if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));

      const costCentsExpr = sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`;
      const estimatedApiCostCentsExpr = sql<number>`coalesce(sum(${costEvents.estimatedApiCostCents}), 0)::int`;

      return db
        .select({
          agentId: costEvents.agentId,
          agentName: agents.name,
          agentStatus: agents.status,
          costCents: costCentsExpr,
          inputTokens: sql<number>`coalesce(sum(${costEvents.inputTokens}), 0)::int`,
          cachedInputTokens: sql<number>`coalesce(sum(${costEvents.cachedInputTokens}), 0)::int`,
          cacheCreationInputTokens: sql<number>`coalesce(sum(${costEvents.cacheCreationInputTokens}), 0)::int`,
          outputTokens: sql<number>`coalesce(sum(${costEvents.outputTokens}), 0)::int`,
          estimatedApiCostCents: estimatedApiCostCentsExpr,
          apiRunCount:
            sql<number>`count(distinct case when ${costEvents.billingType} = ${METERED_BILLING_TYPE} then ${costEvents.heartbeatRunId} end)::int`,
          subscriptionRunCount:
            sql<number>`count(distinct case when ${costEvents.billingType} in (${SUBSCRIPTION_BILLING_SQL}) then ${costEvents.heartbeatRunId} end)::int`,
          subscriptionCachedInputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${SUBSCRIPTION_BILLING_SQL}) then ${costEvents.cachedInputTokens} else 0 end), 0)::int`,
          subscriptionCacheCreationInputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${SUBSCRIPTION_BILLING_SQL}) then ${costEvents.cacheCreationInputTokens} else 0 end), 0)::int`,
          subscriptionInputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${SUBSCRIPTION_BILLING_SQL}) then ${costEvents.inputTokens} else 0 end), 0)::int`,
          subscriptionOutputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${SUBSCRIPTION_BILLING_SQL}) then ${costEvents.outputTokens} else 0 end), 0)::int`,
        })
        .from(costEvents)
        .leftJoin(agents, eq(costEvents.agentId, agents.id))
        .where(and(...conditions))
        .groupBy(costEvents.agentId, agents.name, agents.status)
        .orderBy(desc(costCentsExpr), desc(estimatedApiCostCentsExpr));
    },

    byProvider: async (companyId: string, range?: CostDateRange) => {
      await ensureEstimatedApiCostBackfill(db);

      const conditions: ReturnType<typeof eq>[] = [eq(costEvents.companyId, companyId)];
      if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));

      const costCentsExpr = sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`;
      const estimatedApiCostCentsExpr = sql<number>`coalesce(sum(${costEvents.estimatedApiCostCents}), 0)::int`;

      return db
        .select({
          provider: costEvents.provider,
          biller: costEvents.biller,
          billingType: costEvents.billingType,
          model: costEvents.model,
          costCents: costCentsExpr,
          inputTokens: sql<number>`coalesce(sum(${costEvents.inputTokens}), 0)::int`,
          cachedInputTokens: sql<number>`coalesce(sum(${costEvents.cachedInputTokens}), 0)::int`,
          cacheCreationInputTokens: sql<number>`coalesce(sum(${costEvents.cacheCreationInputTokens}), 0)::int`,
          outputTokens: sql<number>`coalesce(sum(${costEvents.outputTokens}), 0)::int`,
          estimatedApiCostCents: estimatedApiCostCentsExpr,
          apiRunCount:
            sql<number>`count(distinct case when ${costEvents.billingType} = ${METERED_BILLING_TYPE} then ${costEvents.heartbeatRunId} end)::int`,
          subscriptionRunCount:
            sql<number>`count(distinct case when ${costEvents.billingType} in (${SUBSCRIPTION_BILLING_SQL}) then ${costEvents.heartbeatRunId} end)::int`,
          subscriptionCachedInputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${SUBSCRIPTION_BILLING_SQL}) then ${costEvents.cachedInputTokens} else 0 end), 0)::int`,
          subscriptionCacheCreationInputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${SUBSCRIPTION_BILLING_SQL}) then ${costEvents.cacheCreationInputTokens} else 0 end), 0)::int`,
          subscriptionInputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${SUBSCRIPTION_BILLING_SQL}) then ${costEvents.inputTokens} else 0 end), 0)::int`,
          subscriptionOutputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${SUBSCRIPTION_BILLING_SQL}) then ${costEvents.outputTokens} else 0 end), 0)::int`,
        })
        .from(costEvents)
        .where(and(...conditions))
        .groupBy(costEvents.provider, costEvents.biller, costEvents.billingType, costEvents.model)
        .orderBy(desc(costCentsExpr), desc(estimatedApiCostCentsExpr));
    },

    byBiller: async (companyId: string, range?: CostDateRange) => {
      await ensureEstimatedApiCostBackfill(db);

      const conditions: ReturnType<typeof eq>[] = [eq(costEvents.companyId, companyId)];
      if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));

      const costCentsExpr = sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`;
      const estimatedApiCostCentsExpr = sql<number>`coalesce(sum(${costEvents.estimatedApiCostCents}), 0)::int`;

      return db
        .select({
          biller: costEvents.biller,
          costCents: costCentsExpr,
          inputTokens: sql<number>`coalesce(sum(${costEvents.inputTokens}), 0)::int`,
          cachedInputTokens: sql<number>`coalesce(sum(${costEvents.cachedInputTokens}), 0)::int`,
          cacheCreationInputTokens: sql<number>`coalesce(sum(${costEvents.cacheCreationInputTokens}), 0)::int`,
          outputTokens: sql<number>`coalesce(sum(${costEvents.outputTokens}), 0)::int`,
          estimatedApiCostCents: estimatedApiCostCentsExpr,
          apiRunCount:
            sql<number>`count(distinct case when ${costEvents.billingType} = ${METERED_BILLING_TYPE} then ${costEvents.heartbeatRunId} end)::int`,
          subscriptionRunCount:
            sql<number>`count(distinct case when ${costEvents.billingType} in (${SUBSCRIPTION_BILLING_SQL}) then ${costEvents.heartbeatRunId} end)::int`,
          subscriptionCachedInputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${SUBSCRIPTION_BILLING_SQL}) then ${costEvents.cachedInputTokens} else 0 end), 0)::int`,
          subscriptionCacheCreationInputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${SUBSCRIPTION_BILLING_SQL}) then ${costEvents.cacheCreationInputTokens} else 0 end), 0)::int`,
          subscriptionInputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${SUBSCRIPTION_BILLING_SQL}) then ${costEvents.inputTokens} else 0 end), 0)::int`,
          subscriptionOutputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${SUBSCRIPTION_BILLING_SQL}) then ${costEvents.outputTokens} else 0 end), 0)::int`,
          providerCount: sql<number>`count(distinct ${costEvents.provider})::int`,
          modelCount: sql<number>`count(distinct ${costEvents.model})::int`,
        })
        .from(costEvents)
        .where(and(...conditions))
        .groupBy(costEvents.biller)
        .orderBy(desc(costCentsExpr), desc(estimatedApiCostCentsExpr));
    },

    /**
     * aggregates cost_events by provider for each of three rolling windows:
     * last 5 hours, last 24 hours, last 7 days.
     * purely internal consumption data, no external rate-limit sources.
     */
    windowSpend: async (companyId: string) => {
      await ensureEstimatedApiCostBackfill(db);

      const windows = [
        { label: "5h", hours: 5 },
        { label: "24h", hours: 24 },
        { label: "7d", hours: 168 },
      ] as const;

      const results = await Promise.all(
        windows.map(async ({ label, hours }) => {
          const since = new Date(Date.now() - hours * 60 * 60 * 1000);
          const rows = await db
            .select({
              provider: costEvents.provider,
              biller: sql<string>`case when count(distinct ${costEvents.biller}) = 1 then min(${costEvents.biller}) else 'mixed' end`,
              costCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
              inputTokens: sql<number>`coalesce(sum(${costEvents.inputTokens}), 0)::int`,
              cachedInputTokens: sql<number>`coalesce(sum(${costEvents.cachedInputTokens}), 0)::int`,
              cacheCreationInputTokens: sql<number>`coalesce(sum(${costEvents.cacheCreationInputTokens}), 0)::int`,
              outputTokens: sql<number>`coalesce(sum(${costEvents.outputTokens}), 0)::int`,
              estimatedApiCostCents: sql<number>`coalesce(sum(${costEvents.estimatedApiCostCents}), 0)::int`,
            })
            .from(costEvents)
            .where(
              and(
                eq(costEvents.companyId, companyId),
                gte(costEvents.occurredAt, since),
              ),
            )
            .groupBy(costEvents.provider)
            .orderBy(desc(sql`coalesce(sum(${costEvents.costCents}), 0)::int`));

          return rows.map((row) => ({
            provider: row.provider,
            biller: row.biller,
            window: label as string,
            windowHours: hours,
            costCents: row.costCents,
            inputTokens: row.inputTokens,
            cachedInputTokens: row.cachedInputTokens,
            cacheCreationInputTokens: row.cacheCreationInputTokens,
            outputTokens: row.outputTokens,
            estimatedApiCostCents: row.estimatedApiCostCents,
          }));
        }),
      );

      return results.flat();
    },

    byAgentModel: async (companyId: string, range?: CostDateRange) => {
      await ensureEstimatedApiCostBackfill(db);

      const conditions: ReturnType<typeof eq>[] = [eq(costEvents.companyId, companyId)];
      if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));

      // single query: group by agent + provider + model.
      // the (companyId, agentId, occurredAt) composite index covers this well.
      // order by provider + model for stable db-level ordering; cost-desc sort
      // within each agent's sub-rows is done client-side in the ui memo.
      return db
        .select({
          agentId: costEvents.agentId,
          agentName: agents.name,
          provider: costEvents.provider,
          biller: costEvents.biller,
          billingType: costEvents.billingType,
          model: costEvents.model,
          costCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
          inputTokens: sql<number>`coalesce(sum(${costEvents.inputTokens}), 0)::int`,
          cachedInputTokens: sql<number>`coalesce(sum(${costEvents.cachedInputTokens}), 0)::int`,
          cacheCreationInputTokens: sql<number>`coalesce(sum(${costEvents.cacheCreationInputTokens}), 0)::int`,
          outputTokens: sql<number>`coalesce(sum(${costEvents.outputTokens}), 0)::int`,
          estimatedApiCostCents: sql<number>`coalesce(sum(${costEvents.estimatedApiCostCents}), 0)::int`,
        })
        .from(costEvents)
        .leftJoin(agents, eq(costEvents.agentId, agents.id))
        .where(and(...conditions))
        .groupBy(
          costEvents.agentId,
          agents.name,
          costEvents.provider,
          costEvents.biller,
          costEvents.billingType,
          costEvents.model,
        )
        .orderBy(costEvents.provider, costEvents.biller, costEvents.billingType, costEvents.model);
    },

    byProject: async (companyId: string, range?: CostDateRange) => {
      await ensureEstimatedApiCostBackfill(db);

      const issueIdAsText = sql<string>`${issues.id}::text`;
      const runProjectLinks = db
        .selectDistinctOn([activityLog.runId, issues.projectId], {
          runId: activityLog.runId,
          projectId: issues.projectId,
        })
        .from(activityLog)
        .innerJoin(
          issues,
          and(
            eq(activityLog.entityType, "issue"),
            eq(activityLog.entityId, issueIdAsText),
          ),
        )
        .where(
          and(
            eq(activityLog.companyId, companyId),
            eq(issues.companyId, companyId),
            isNotNull(activityLog.runId),
            isNotNull(issues.projectId),
          ),
        )
        .orderBy(activityLog.runId, issues.projectId, desc(activityLog.createdAt))
        .as("run_project_links");

      const effectiveProjectId = sql<string | null>`coalesce(${costEvents.projectId}, ${runProjectLinks.projectId})`;
      const conditions: ReturnType<typeof eq>[] = [eq(costEvents.companyId, companyId)];
      if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));

      const costCentsExpr = sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`;
      const estimatedApiCostCentsExpr = sql<number>`coalesce(sum(${costEvents.estimatedApiCostCents}), 0)::int`;

      return db
        .select({
          projectId: effectiveProjectId,
          projectName: projects.name,
          costCents: costCentsExpr,
          inputTokens: sql<number>`coalesce(sum(${costEvents.inputTokens}), 0)::int`,
          cachedInputTokens: sql<number>`coalesce(sum(${costEvents.cachedInputTokens}), 0)::int`,
          cacheCreationInputTokens: sql<number>`coalesce(sum(${costEvents.cacheCreationInputTokens}), 0)::int`,
          outputTokens: sql<number>`coalesce(sum(${costEvents.outputTokens}), 0)::int`,
          estimatedApiCostCents: estimatedApiCostCentsExpr,
        })
        .from(costEvents)
        .leftJoin(runProjectLinks, eq(costEvents.heartbeatRunId, runProjectLinks.runId))
        .innerJoin(projects, sql`${projects.id} = ${effectiveProjectId}`)
        .where(and(...conditions, sql`${effectiveProjectId} is not null`))
        .groupBy(effectiveProjectId, projects.name)
        .orderBy(desc(costCentsExpr), desc(estimatedApiCostCentsExpr));
    },
  };
}
