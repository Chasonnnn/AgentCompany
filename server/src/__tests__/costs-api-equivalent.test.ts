import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  budgetPolicies,
  companies,
  costEvents,
  createDb,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { estimateApiEquivalentCostCents } from "../services/api-equivalent-pricing.ts";
import { budgetService } from "../services/budgets.ts";
import { costService } from "../services/costs.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres cost estimate tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function insertBaseRecords(db: ReturnType<typeof createDb>) {
  const companyId = randomUUID();
  const agentId = randomUUID();
  const projectId = randomUUID();

  await db.insert(companies).values({
    id: companyId,
    name: "Paperclip",
    issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    requireBoardApprovalForNewAgents: false,
  });

  await db.insert(agents).values({
    id: agentId,
    companyId,
    name: "Budget Agent",
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
    name: "Control Plane",
    status: "in_progress",
  });

  return { companyId, agentId, projectId };
}

describeEmbeddedPostgres("costService api-equivalent estimates", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cost-estimates-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(costEvents);
    await db.delete(budgetPolicies);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("stores subscription-backed codex usage as billed zero with a non-zero api-equivalent estimate", async () => {
    const { companyId, agentId, projectId } = await insertBaseRecords(db);
    const costs = costService(db);
    const expectedEstimate = estimateApiEquivalentCostCents({
      model: "gpt-5.4",
      inputTokens: 1_000_000,
      cachedInputTokens: 200_000,
      outputTokens: 100_000,
    });

    const event = await costs.createEvent(companyId, {
      agentId,
      projectId,
      provider: "openai",
      biller: "chatgpt",
      billingType: "subscription_included",
      model: "gpt-5.4",
      inputTokens: 1_000_000,
      cachedInputTokens: 200_000,
      outputTokens: 100_000,
      costCents: 0,
      occurredAt: new Date(),
    });

    expect(event.costCents).toBe(0);
    expect(event.estimatedApiCostCents).toBe(expectedEstimate);

    const summary = await costs.summary(companyId);
    expect(summary).toMatchObject({
      spendCents: 0,
      estimatedApiCostCents: expectedEstimate,
    });

    const [byAgent] = await costs.byAgent(companyId);
    expect(byAgent).toMatchObject({
      agentId,
      costCents: 0,
      estimatedApiCostCents: expectedEstimate,
      cacheCreationInputTokens: 0,
    });

    const [byProvider] = await costs.byProvider(companyId);
    expect(byProvider).toMatchObject({
      provider: "openai",
      biller: "chatgpt",
      costCents: 0,
      estimatedApiCostCents: expectedEstimate,
    });

    const [byBiller] = await costs.byBiller(companyId);
    expect(byBiller).toMatchObject({
      biller: "chatgpt",
      costCents: 0,
      estimatedApiCostCents: expectedEstimate,
    });

    const [byAgentModel] = await costs.byAgentModel(companyId);
    expect(byAgentModel).toMatchObject({
      model: "gpt-5.4",
      costCents: 0,
      estimatedApiCostCents: expectedEstimate,
      cacheCreationInputTokens: 0,
    });

    const [byProject] = await costs.byProject(companyId);
    expect(byProject).toMatchObject({
      projectId,
      costCents: 0,
      estimatedApiCostCents: expectedEstimate,
    });

    expect(await costs.windowSpend(companyId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "openai",
          window: "24h",
          costCents: 0,
          estimatedApiCostCents: expectedEstimate,
        }),
      ]),
    );
  });

  it("preserves billed cost for metered claude usage and includes cache creation tokens in the estimate", async () => {
    const { companyId, agentId, projectId } = await insertBaseRecords(db);
    const costs = costService(db);
    const expectedEstimate = estimateApiEquivalentCostCents({
      model: "claude-sonnet-4-6",
      inputTokens: 250_000,
      cachedInputTokens: 50_000,
      cacheCreationInputTokens: 25_000,
      outputTokens: 10_000,
    });

    const event = await costs.createEvent(companyId, {
      agentId,
      projectId,
      provider: "anthropic",
      biller: "anthropic",
      billingType: "metered_api",
      model: "claude-sonnet-4-6",
      inputTokens: 250_000,
      cachedInputTokens: 50_000,
      cacheCreationInputTokens: 25_000,
      outputTokens: 10_000,
      costCents: 4_321,
      occurredAt: new Date(),
    });

    expect(event.costCents).toBe(4_321);
    expect(event.estimatedApiCostCents).toBe(expectedEstimate);

    const [byAgentModel] = await costs.byAgentModel(companyId);
    expect(byAgentModel).toMatchObject({
      model: "claude-sonnet-4-6",
      costCents: 4_321,
      estimatedApiCostCents: expectedEstimate,
      cacheCreationInputTokens: 25_000,
    });
  });

  it("backfills legacy rows with null api-equivalent cents and assumes missing claude cache creation tokens are zero", async () => {
    const { companyId, agentId, projectId } = await insertBaseRecords(db);
    const expectedEstimate = estimateApiEquivalentCostCents({
      model: "claude-opus-4-6",
      inputTokens: 400_000,
      cachedInputTokens: 80_000,
      cacheCreationInputTokens: 0,
      outputTokens: 20_000,
    });

    const [legacyEvent] = await db
      .insert(costEvents)
      .values({
        companyId,
        agentId,
        projectId,
        provider: "anthropic",
        biller: "anthropic",
        billingType: "subscription_included",
        model: "claude-opus-4-6",
        inputTokens: 400_000,
        cachedInputTokens: 80_000,
        outputTokens: 20_000,
        costCents: 0,
        estimatedApiCostCents: null,
        occurredAt: new Date(),
      })
      .returning();

    const costs = costService(db);
    const summary = await costs.summary(companyId);
    expect(summary.estimatedApiCostCents).toBe(expectedEstimate);

    const refreshed = await db
      .select()
      .from(costEvents)
      .where(eq(costEvents.id, legacyEvent.id))
      .then((rows) => rows[0] ?? null);

    expect(refreshed?.cacheCreationInputTokens).toBe(0);
    expect(refreshed?.estimatedApiCostCents).toBe(expectedEstimate);
  });

  it("keeps budget enforcement tied to billed cost only", async () => {
    const { companyId, agentId } = await insertBaseRecords(db);

    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "agent",
      scopeId: agentId,
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 1,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: true,
    });

    await db.insert(costEvents).values({
      companyId,
      agentId,
      provider: "openai",
      biller: "chatgpt",
      billingType: "subscription_included",
      model: "gpt-5.4",
      inputTokens: 2_000_000,
      cachedInputTokens: 500_000,
      outputTokens: 100_000,
      costCents: 0,
      estimatedApiCostCents: 9_999,
      occurredAt: new Date(),
    });

    const block = await budgetService(db).getInvocationBlock(companyId, agentId);
    expect(block).toBeNull();
  });
});
