import { and, desc, eq, gte, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, costEvents, heartbeatRuns, issues, projects } from "@paperclipai/db";
import type {
  AgentProductivitySummary,
  LowYieldRunSummary,
  ProductivityHealthStatus,
  ProductivityReviewMetadata,
  ProductivityRatios,
  ProductivitySummary,
  ProductivityTotals,
  ProductivityWindow,
} from "@paperclipai/shared";

const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
const USEFUL_LIVENESS_STATES = new Set(["advanced", "completed", "blocked"]);
const LOW_YIELD_LIVENESS_STATES = new Set(["plan_only", "empty_response", "needs_followup"]);
const MAX_RUNS_PER_SUMMARY = 1_000;
const PRODUCTIVITY_REVIEW_ORIGIN_KIND = "issue_productivity_review";

type ProductivityCostTotals = Pick<
  ProductivityTotals,
  | "inputTokens"
  | "cachedInputTokens"
  | "cacheCreationInputTokens"
  | "outputTokens"
  | "totalTokens"
  | "costCents"
  | "estimatedApiCostCents"
>;

type ProductivityOptions = {
  window?: ProductivityWindow;
};

type RunRow = {
  runId: string;
  agentId: string;
  agentName: string;
  agentStatus: string;
  adapterType: string;
  role: string;
  archetypeKey: string | null;
  status: string;
  livenessState: string | null;
  livenessReason: string | null;
  continuationAttempt: number;
  lastUsefulActionAt: Date | null;
  nextAction: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
};

type IssueByRun = {
  issueId: string;
  identifier: string | null;
  title: string;
  status: string;
  projectId: string | null;
  projectName: string | null;
};

function windowStart(window: ProductivityWindow, now = new Date()): Date | null {
  if (window === "all") return null;
  const days = window === "30d" ? 30 : 7;
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

function emptyCostTotals(): ProductivityCostTotals {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costCents: 0,
    estimatedApiCostCents: 0,
  };
}

function emptyTotals(): ProductivityTotals {
  return {
    runCount: 0,
    terminalRunCount: 0,
    usefulRunCount: 0,
    completedRunCount: 0,
    blockedRunCount: 0,
    lowYieldRunCount: 0,
    planOnlyRunCount: 0,
    emptyResponseRunCount: 0,
    needsFollowupRunCount: 0,
    failedRunCount: 0,
    continuationExhaustionCount: 0,
    completedIssueCount: 0,
    ...emptyCostTotals(),
    durationMs: 0,
    timeToFirstUsefulActionMs: null,
  };
}

function addCostTotals(target: ProductivityCostTotals, source: ProductivityCostTotals) {
  target.inputTokens += source.inputTokens;
  target.cachedInputTokens += source.cachedInputTokens;
  target.cacheCreationInputTokens += source.cacheCreationInputTokens;
  target.outputTokens += source.outputTokens;
  target.totalTokens += source.totalTokens;
  target.costCents += source.costCents;
  target.estimatedApiCostCents += source.estimatedApiCostCents;
}

function rate(part: number, whole: number) {
  if (whole <= 0) return 0;
  return Number((part / whole).toFixed(4));
}

function ratio(total: number, count: number) {
  if (count <= 0) return null;
  return Math.round(total / count);
}

function computeRatios(totals: ProductivityTotals): ProductivityRatios {
  return {
    usefulRunRate: rate(totals.usefulRunCount, totals.terminalRunCount),
    lowYieldRunRate: rate(totals.lowYieldRunCount, totals.terminalRunCount),
    tokensPerUsefulRun: ratio(totals.totalTokens, totals.usefulRunCount),
    tokensPerCompletedIssue: ratio(totals.totalTokens, totals.completedIssueCount),
    avgRunDurationMs: ratio(totals.durationMs, totals.terminalRunCount),
    avgTimeToFirstUsefulActionMs:
      totals.timeToFirstUsefulActionMs == null ? null : ratio(totals.timeToFirstUsefulActionMs, totals.usefulRunCount),
  };
}

function runDurationMs(run: RunRow) {
  if (!run.startedAt || !run.finishedAt) return null;
  return Math.max(0, run.finishedAt.getTime() - run.startedAt.getTime());
}

function timeToFirstUsefulActionMs(run: RunRow) {
  if (!run.startedAt || !run.lastUsefulActionAt) return null;
  return Math.max(0, run.lastUsefulActionAt.getTime() - run.startedAt.getTime());
}

function isContinuationExhausted(run: RunRow) {
  if (!LOW_YIELD_LIVENESS_STATES.has(run.livenessState ?? "")) return false;
  if (run.continuationAttempt >= 2) return true;
  return /\bexhaust(ed|ion)\b/i.test(run.livenessReason ?? "");
}

function healthFor(totals: ProductivityTotals, ratios: ProductivityRatios): ProductivityHealthStatus {
  if (totals.continuationExhaustionCount > 0) return "low_yield";
  if (totals.terminalRunCount < 3) return "ok";
  if (ratios.usefulRunRate < 0.4 || ratios.lowYieldRunRate >= 0.5) {
    return "low_yield";
  }
  if (ratios.usefulRunRate < 0.65 || ratios.lowYieldRunRate >= 0.25) return "watch";
  return "ok";
}

function summarizeLowYieldRun(
  run: RunRow,
  issue: IssueByRun | undefined,
  costs: ProductivityCostTotals,
): LowYieldRunSummary {
  return {
    runId: run.runId,
    agentId: run.agentId,
    agentName: run.agentName,
    issueId: issue?.issueId ?? null,
    issueIdentifier: issue?.identifier ?? null,
    issueTitle: issue?.title ?? null,
    projectId: issue?.projectId ?? null,
    projectName: issue?.projectName ?? null,
    status: run.status,
    livenessState: run.livenessState,
    livenessReason: run.livenessReason,
    continuationAttempt: run.continuationAttempt,
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    durationMs: runDurationMs(run),
    totalTokens: costs.totalTokens,
    estimatedApiCostCents: costs.estimatedApiCostCents,
    nextAction: run.nextAction,
  };
}

function applyRunToTotals(
  totals: ProductivityTotals,
  run: RunRow,
  issue: IssueByRun | undefined,
  costs: ProductivityCostTotals,
  completedIssueIds: Set<string>,
) {
  totals.runCount += 1;
  if (TERMINAL_RUN_STATUSES.has(run.status)) totals.terminalRunCount += 1;
  if (USEFUL_LIVENESS_STATES.has(run.livenessState ?? "")) totals.usefulRunCount += 1;
  if (run.livenessState === "completed") totals.completedRunCount += 1;
  if (run.livenessState === "blocked") totals.blockedRunCount += 1;
  if (LOW_YIELD_LIVENESS_STATES.has(run.livenessState ?? "")) totals.lowYieldRunCount += 1;
  if (run.livenessState === "plan_only") totals.planOnlyRunCount += 1;
  if (run.livenessState === "empty_response") totals.emptyResponseRunCount += 1;
  if (run.livenessState === "needs_followup") totals.needsFollowupRunCount += 1;
  if (run.status === "failed") totals.failedRunCount += 1;
  if (isContinuationExhausted(run)) totals.continuationExhaustionCount += 1;

  const duration = runDurationMs(run);
  if (duration != null && TERMINAL_RUN_STATUSES.has(run.status)) totals.durationMs += duration;

  const firstUseful = timeToFirstUsefulActionMs(run);
  if (firstUseful != null && USEFUL_LIVENESS_STATES.has(run.livenessState ?? "")) {
    totals.timeToFirstUsefulActionMs = (totals.timeToFirstUsefulActionMs ?? 0) + firstUseful;
  }

  if (issue?.status === "done" && !completedIssueIds.has(issue.issueId)) {
    completedIssueIds.add(issue.issueId);
    totals.completedIssueCount += 1;
  }

  addCostTotals(totals, costs);
}

function makeAgentSummary(
  agent: Pick<RunRow, "agentId" | "agentName" | "agentStatus" | "adapterType" | "role" | "archetypeKey">,
  totals: ProductivityTotals,
  lowYieldRuns: LowYieldRunSummary[],
): AgentProductivitySummary {
  const ratios = computeRatios(totals);
  return {
    agentId: agent.agentId,
    agentName: agent.agentName,
    agentStatus: agent.agentStatus,
    adapterType: agent.adapterType,
    role: agent.role,
    archetypeKey: agent.archetypeKey,
    health: healthFor(totals, ratios),
    totals,
    ratios,
    lowYieldRuns,
  };
}

function recommendationsFor(summary: {
  totals: ProductivityTotals;
  ratios: ProductivityRatios;
  agents?: AgentProductivitySummary[];
  lowYieldRuns?: LowYieldRunSummary[];
}) {
  const recommendations: string[] = [];
  const lowYieldRuns = summary.lowYieldRuns ?? [];
  const hasUnlinkedNeedsFollowup = lowYieldRuns.some((run) =>
    !run.issueId && run.livenessState === "needs_followup"
  );
  const hasHighTokenPlanOnly = lowYieldRuns.some((run) =>
    run.livenessState === "plan_only" && run.totalTokens >= 100_000
  );
  const hasHighTokenNeedsFollowup = lowYieldRuns.some((run) =>
    run.livenessState === "needs_followup" && run.totalTokens >= 100_000
  );

  if (summary.totals.terminalRunCount >= 3 && summary.ratios.usefulRunRate < 0.5) {
    recommendations.push("Tighten default wake context and ask agents to do one concrete issue action before broad planning.");
  }
  if (summary.totals.planOnlyRunCount > 0) {
    recommendations.push("Review plan-only runs for issues that could skip formal planning, avoid unnecessary QA ceremony, or need QA-first acceptance before implementation.");
  }
  if (summary.totals.planOnlyRunCount > 0 || summary.totals.needsFollowupRunCount > 0) {
    recommendations.push("For plan-only or follow-up-only runs, require either a concrete action posted or a named blocker with owner and exact unblock step.");
  }
  if (hasUnlinkedNeedsFollowup) {
    recommendations.push("For unlinked follow-up wakes, require a missing-link blocker with likely owner and exact unblock step before any broad exploration.");
  }
  if (hasHighTokenPlanOnly || hasHighTokenNeedsFollowup) {
    recommendations.push("For high-token plan-only or needs-followup runs, require the first output to be a concrete issue action or blocker-owner-unblock packet.");
  }
  if (summary.totals.usefulRunCount > 0 && summary.totals.completedIssueCount === 0) {
    recommendations.push("Useful runs are not becoming completed issues; inspect closeout, definition-of-done, review handoff, and handoff-to-completion flow before optimizing token cost.");
  }
  if (summary.totals.continuationExhaustionCount > 0) {
    recommendations.push("Inspect continuation-exhausted runs; they usually need smaller task scope, clearer acceptance criteria, or a tighter risk-based QA mode.");
  }
  const lowYieldAgents = summary.agents?.filter((agent) => agent.health === "low_yield").slice(0, 3) ?? [];
  if (lowYieldAgents.length > 0) {
    recommendations.push(`Check low-yield agents first: ${lowYieldAgents.map((agent) => agent.agentName).join(", ")}.`);
  }
  return recommendations;
}

function parseWindow(input: ProductivityOptions | undefined): ProductivityWindow {
  const window = input?.window;
  if (window === "30d" || window === "all") return window;
  return "7d";
}

export function productivityService(db: Db) {
  async function loadReviewMetadata(companyId: string): Promise<ProductivityReviewMetadata> {
    const [countRow, latest] = await Promise.all([
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            eq(issues.originKind, PRODUCTIVITY_REVIEW_ORIGIN_KIND),
            isNull(issues.hiddenAt),
            notInArray(issues.status, ["done", "cancelled"]),
          ),
        )
        .then((rows) => rows[0] ?? { count: 0 }),
      db
        .select({ updatedAt: issues.updatedAt, createdAt: issues.createdAt })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), eq(issues.originKind, PRODUCTIVITY_REVIEW_ORIGIN_KIND)))
        .orderBy(desc(issues.updatedAt), desc(issues.createdAt))
        .limit(1)
        .then((rows) => rows[0] ?? null),
    ]);
    const openReviewCount = Number(countRow.count) || 0;
    return {
      openReviewCount,
      mostRecentReviewAt: latest?.updatedAt?.toISOString() ?? latest?.createdAt?.toISOString() ?? null,
      healthBadge: openReviewCount >= 3 ? "review" : openReviewCount > 0 ? "watch" : "ok",
    };
  }

  async function loadRuns(companyId: string, agentId: string | null, window: ProductivityWindow): Promise<RunRow[]> {
    const from = windowStart(window);
    const conditions = [eq(heartbeatRuns.companyId, companyId)];
    if (agentId) conditions.push(eq(heartbeatRuns.agentId, agentId));
    if (from) conditions.push(gte(heartbeatRuns.createdAt, from));

    return db
      .select({
        runId: heartbeatRuns.id,
        agentId: heartbeatRuns.agentId,
        agentName: agents.name,
        agentStatus: agents.status,
        adapterType: agents.adapterType,
        role: agents.role,
        archetypeKey: agents.archetypeKey,
        status: heartbeatRuns.status,
        livenessState: heartbeatRuns.livenessState,
        livenessReason: heartbeatRuns.livenessReason,
        continuationAttempt: heartbeatRuns.continuationAttempt,
        lastUsefulActionAt: heartbeatRuns.lastUsefulActionAt,
        nextAction: heartbeatRuns.nextAction,
        startedAt: heartbeatRuns.startedAt,
        finishedAt: heartbeatRuns.finishedAt,
        createdAt: heartbeatRuns.createdAt,
      })
      .from(heartbeatRuns)
      .innerJoin(agents, eq(agents.id, heartbeatRuns.agentId))
      .where(and(...conditions))
      .orderBy(desc(heartbeatRuns.createdAt))
      .limit(MAX_RUNS_PER_SUMMARY);
  }

  async function loadIssueMap(companyId: string, runIds: string[]) {
    const map = new Map<string, IssueByRun>();
    if (runIds.length === 0) return map;
    const rows = await db
      .select({
        issueId: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        projectId: issues.projectId,
        projectName: projects.name,
        executionRunId: issues.executionRunId,
        checkoutRunId: issues.checkoutRunId,
      })
      .from(issues)
      .leftJoin(projects, eq(projects.id, issues.projectId))
      .where(
        and(
          eq(issues.companyId, companyId),
          or(inArray(issues.executionRunId, runIds), inArray(issues.checkoutRunId, runIds)),
        ),
      );

    for (const row of rows) {
      const summary = {
        issueId: row.issueId,
        identifier: row.identifier,
        title: row.title,
        status: row.status,
        projectId: row.projectId,
        projectName: row.projectName,
      };
      if (row.executionRunId) map.set(row.executionRunId, summary);
      if (row.checkoutRunId && !map.has(row.checkoutRunId)) map.set(row.checkoutRunId, summary);
    }
    return map;
  }

  async function loadCostMap(companyId: string, runIds: string[]) {
    const map = new Map<string, ProductivityCostTotals>();
    if (runIds.length === 0) return map;
    const rows = await db
      .select({
        heartbeatRunId: costEvents.heartbeatRunId,
        inputTokens: costEvents.inputTokens,
        cachedInputTokens: costEvents.cachedInputTokens,
        cacheCreationInputTokens: costEvents.cacheCreationInputTokens,
        outputTokens: costEvents.outputTokens,
        costCents: costEvents.costCents,
        estimatedApiCostCents: costEvents.estimatedApiCostCents,
      })
      .from(costEvents)
      .where(and(eq(costEvents.companyId, companyId), inArray(costEvents.heartbeatRunId, runIds)));

    for (const row of rows) {
      if (!row.heartbeatRunId) continue;
      const entry = map.get(row.heartbeatRunId) ?? emptyCostTotals();
      entry.inputTokens += row.inputTokens;
      entry.cachedInputTokens += row.cachedInputTokens;
      entry.cacheCreationInputTokens += row.cacheCreationInputTokens;
      entry.outputTokens += row.outputTokens;
      entry.totalTokens += row.inputTokens + row.cachedInputTokens + row.cacheCreationInputTokens + row.outputTokens;
      entry.costCents += row.costCents;
      entry.estimatedApiCostCents += row.estimatedApiCostCents ?? row.costCents;
      map.set(row.heartbeatRunId, entry);
    }
    return map;
  }

  async function buildSummary(companyId: string, agentId: string | null, options?: ProductivityOptions) {
    const window = parseWindow(options);
    const runs = await loadRuns(companyId, agentId, window);
    const runIds = runs.map((run) => run.runId);
    const [issueMap, costMap, review] = await Promise.all([
      loadIssueMap(companyId, runIds),
      loadCostMap(companyId, runIds),
      loadReviewMetadata(companyId),
    ]);

    const totals = emptyTotals();
    const completedIssueIds = new Set<string>();
    const agentBuckets = new Map<string, {
      agent: Pick<RunRow, "agentId" | "agentName" | "agentStatus" | "adapterType" | "role" | "archetypeKey">;
      totals: ProductivityTotals;
      completedIssueIds: Set<string>;
      lowYieldRuns: LowYieldRunSummary[];
    }>();
    const lowYieldRuns: LowYieldRunSummary[] = [];

    for (const run of runs) {
      const issue = issueMap.get(run.runId);
      const costs = costMap.get(run.runId) ?? emptyCostTotals();
      applyRunToTotals(totals, run, issue, costs, completedIssueIds);

      const bucket = agentBuckets.get(run.agentId) ?? {
        agent: run,
        totals: emptyTotals(),
        completedIssueIds: new Set<string>(),
        lowYieldRuns: [],
      };
      applyRunToTotals(bucket.totals, run, issue, costs, bucket.completedIssueIds);

      if (LOW_YIELD_LIVENESS_STATES.has(run.livenessState ?? "")) {
        const lowYield = summarizeLowYieldRun(run, issue, costs);
        lowYieldRuns.push(lowYield);
        if (bucket.lowYieldRuns.length < 5) bucket.lowYieldRuns.push(lowYield);
      }
      agentBuckets.set(run.agentId, bucket);
    }

    const agentsSummary = Array.from(agentBuckets.values())
      .map((bucket) => makeAgentSummary(bucket.agent, bucket.totals, bucket.lowYieldRuns))
      .sort((left, right) => right.totals.lowYieldRunCount - left.totals.lowYieldRunCount);
    const ratios = computeRatios(totals);

    const summary: ProductivitySummary = {
      companyId,
      window,
      generatedAt: new Date().toISOString(),
      from: windowStart(window)?.toISOString() ?? null,
      totals,
      ratios,
      agents: agentsSummary,
      lowYieldRuns: lowYieldRuns.slice(0, 10),
      recommendations: recommendationsFor({ totals, ratios, agents: agentsSummary, lowYieldRuns }),
      review,
    };
    return summary;
  }

  return {
    companySummary: (companyId: string, options?: ProductivityOptions) => buildSummary(companyId, null, options),
    agentSummary: async (agentId: string, options?: ProductivityOptions): Promise<AgentProductivitySummary | null> => {
      const agent = await db
        .select({
          agentId: agents.id,
          agentName: agents.name,
          agentStatus: agents.status,
          adapterType: agents.adapterType,
          role: agents.role,
          archetypeKey: agents.archetypeKey,
          companyId: agents.companyId,
        })
        .from(agents)
        .where(eq(agents.id, agentId))
        .then((rows) => rows[0] ?? null);
      if (!agent) return null;
      const summary = await buildSummary(agent.companyId, agentId, options);
      return summary.agents[0] ?? makeAgentSummary(agent, emptyTotals(), []);
    },
  };
}
