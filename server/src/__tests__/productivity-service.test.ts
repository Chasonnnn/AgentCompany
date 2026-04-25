import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  costEvents,
  createDb,
  heartbeatRuns,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { productivityService } from "../services/productivity.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function seedBase(db: ReturnType<typeof createDb>) {
  const companyId = randomUUID();
  const agentId = randomUUID();
  const projectId = randomUUID();

  await db.insert(companies).values({
    id: companyId,
    name: "Paperclip",
    issuePrefix: `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    requireBoardApprovalForNewAgents: false,
  });
  await db.insert(agents).values({
    id: agentId,
    companyId,
    name: "Operator",
    role: "engineer",
    status: "active",
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
  });
  await db.insert(projects).values({
    id: projectId,
    companyId,
    name: "Runtime",
    status: "in_progress",
  });

  return { companyId, agentId, projectId };
}

describeEmbeddedPostgres("productivityService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-productivity-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(costEvents);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("rolls up useful rate, token ratios, completions, and continuation exhaustion", async () => {
    const { companyId, agentId, projectId } = await seedBase(db);
    const started = new Date("2026-04-24T10:00:00.000Z");
    const usefulRunId = randomUUID();
    const emptyRunId = randomUUID();

    await db.insert(heartbeatRuns).values([
      {
        id: usefulRunId,
        companyId,
        agentId,
        status: "succeeded",
        livenessState: "completed",
        startedAt: started,
        finishedAt: new Date("2026-04-24T10:05:00.000Z"),
        lastUsefulActionAt: new Date("2026-04-24T10:01:00.000Z"),
        createdAt: started,
      },
      {
        id: emptyRunId,
        companyId,
        agentId,
        status: "succeeded",
        livenessState: "empty_response",
        livenessReason: "continuation exhausted after repeated empty responses",
        continuationAttempt: 2,
        startedAt: new Date("2026-04-24T11:00:00.000Z"),
        finishedAt: new Date("2026-04-24T11:01:00.000Z"),
        createdAt: new Date("2026-04-24T11:00:00.000Z"),
      },
    ]);

    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      projectId,
      title: "Ship the fix",
      status: "done",
      executionRunId: usefulRunId,
      issueNumber: 1,
      identifier: "PAP-1",
    });

    await db.insert(costEvents).values([
      {
        companyId,
        agentId,
        projectId,
        heartbeatRunId: usefulRunId,
        issueId: null,
        provider: "openai",
        biller: "chatgpt",
        billingType: "subscription_included",
        model: "gpt-5.5",
        inputTokens: 1_000,
        cachedInputTokens: 100,
        cacheCreationInputTokens: 50,
        outputTokens: 250,
        costCents: 0,
        estimatedApiCostCents: 12,
        occurredAt: started,
      },
      {
        companyId,
        agentId,
        projectId,
        heartbeatRunId: emptyRunId,
        issueId: null,
        provider: "openai",
        biller: "chatgpt",
        billingType: "subscription_included",
        model: "gpt-5.5",
        inputTokens: 500,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
        outputTokens: 20,
        costCents: 0,
        estimatedApiCostCents: 3,
        occurredAt: new Date("2026-04-24T11:00:00.000Z"),
      },
    ]);

    const summary = await productivityService(db).companySummary(companyId, { window: "all" });

    expect(summary.totals.terminalRunCount).toBe(2);
    expect(summary.totals.usefulRunCount).toBe(1);
    expect(summary.totals.emptyResponseRunCount).toBe(1);
    expect(summary.totals.continuationExhaustionCount).toBe(1);
    expect(summary.totals.completedIssueCount).toBe(1);
    expect(summary.totals.totalTokens).toBe(1_920);
    expect(summary.ratios.usefulRunRate).toBe(0.5);
    expect(summary.ratios.tokensPerUsefulRun).toBe(1_920);
    expect(summary.ratios.tokensPerCompletedIssue).toBe(1_920);
    expect(summary.ratios.avgTimeToFirstUsefulActionMs).toBe(60_000);
    expect(summary.lowYieldRuns[0]).toMatchObject({
      runId: emptyRunId,
      agentName: "Operator",
      livenessState: "empty_response",
      totalTokens: 520,
    });
    expect(summary.agents[0]?.health).toBe("low_yield");
  });

  it("recommends unblock packets and closeout inspection when useful work is not completing issues", async () => {
    const { companyId, agentId, projectId } = await seedBase(db);
    const usefulRunId = randomUUID();
    const planRunId = randomUUID();
    const started = new Date("2026-04-24T12:00:00.000Z");

    await db.insert(heartbeatRuns).values([
      {
        id: usefulRunId,
        companyId,
        agentId,
        status: "succeeded",
        livenessState: "advanced",
        startedAt: started,
        finishedAt: new Date("2026-04-24T12:03:00.000Z"),
        lastUsefulActionAt: new Date("2026-04-24T12:01:00.000Z"),
        createdAt: started,
      },
      {
        id: planRunId,
        companyId,
        agentId,
        status: "succeeded",
        livenessState: "plan_only",
        nextAction: "Next action: inspect revision_requested state again",
        startedAt: new Date("2026-04-24T13:00:00.000Z"),
        finishedAt: new Date("2026-04-24T13:02:00.000Z"),
        createdAt: new Date("2026-04-24T13:00:00.000Z"),
      },
    ]);

    await db.insert(costEvents).values([
      {
        companyId,
        agentId,
        projectId,
        heartbeatRunId: usefulRunId,
        issueId: null,
        provider: "openai",
        biller: "chatgpt",
        billingType: "subscription_included",
        model: "gpt-5.5",
        inputTokens: 10_000,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
        outputTokens: 1_000,
        costCents: 0,
        estimatedApiCostCents: 0,
        occurredAt: started,
      },
      {
        companyId,
        agentId,
        projectId,
        heartbeatRunId: planRunId,
        issueId: null,
        provider: "openai",
        biller: "chatgpt",
        billingType: "subscription_included",
        model: "gpt-5.5",
        inputTokens: 600_000,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
        outputTokens: 20_000,
        costCents: 0,
        estimatedApiCostCents: 0,
        occurredAt: new Date("2026-04-24T13:00:00.000Z"),
      },
    ]);

    const summary = await productivityService(db).companySummary(companyId, { window: "all" });

    expect(summary.totals.completedIssueCount).toBe(0);
    expect(summary.recommendations).toContain(
      "For plan-only or follow-up-only runs, require either a concrete action posted or a named blocker with owner and exact unblock step.",
    );
    expect(summary.recommendations).toContain(
      "Useful runs are not becoming completed issues; inspect definition-of-done, review handoff, and closeout flow before optimizing token cost.",
    );
  });
});
