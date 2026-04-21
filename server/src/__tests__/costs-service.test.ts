import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { costRoutes } from "../routes/costs.js";

function makeDb(overrides: Record<string, unknown> = {}) {
  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    groupBy: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    then: vi.fn().mockResolvedValue([]),
  };

  const thenableChain = Object.assign(Promise.resolve([]), selectChain);

  return {
    select: vi.fn().mockReturnValue(thenableChain),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
    }),
    ...overrides,
  };
}

const mockCompanyService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
}));
const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
}));
const mockHeartbeatService = vi.hoisted(() => ({
  cancelBudgetScopeWork: vi.fn().mockResolvedValue(undefined),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockFetchAllQuotaWindows = vi.hoisted(() => vi.fn());
const mockCostService = vi.hoisted(() => ({
  createEvent: vi.fn(),
  summary: vi.fn().mockResolvedValue({ spendCents: 0 }),
  byAgent: vi.fn().mockResolvedValue([]),
  byAgentModel: vi.fn().mockResolvedValue([]),
  byProvider: vi.fn().mockResolvedValue([]),
  byBiller: vi.fn().mockResolvedValue([]),
  windowSpend: vi.fn().mockResolvedValue([]),
  byProject: vi.fn().mockResolvedValue([]),
}));
const mockFinanceService = vi.hoisted(() => ({
  createEvent: vi.fn(),
  summary: vi.fn().mockResolvedValue({ debitCents: 0, creditCents: 0, netCents: 0, estimatedDebitCents: 0, eventCount: 0 }),
  byBiller: vi.fn().mockResolvedValue([]),
  byKind: vi.fn().mockResolvedValue([]),
  list: vi.fn().mockResolvedValue([]),
}));
const mockBudgetService = vi.hoisted(() => ({
  overview: vi.fn().mockResolvedValue({
    companyId: "company-1",
    policies: [],
    activeIncidents: [],
    pausedAgentCount: 0,
    pausedProjectCount: 0,
    pendingApprovalCount: 0,
  }),
  upsertPolicy: vi.fn(),
  resolveIncident: vi.fn(),
}));

async function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = { type: "board", userId: "board-user", source: "local_implicit" };
    next();
  });
  app.use("/api", costRoutes(makeDb() as any, {
    services: {
      budgetService: mockBudgetService as any,
      costService: mockCostService as any,
      financeService: mockFinanceService as any,
      companyService: mockCompanyService as any,
      agentService: mockAgentService as any,
      heartbeatService: mockHeartbeatService as any,
      logActivity: mockLogActivity as any,
    },
    fetchAllQuotaWindows: mockFetchAllQuotaWindows as any,
  }));
  app.use(errorHandler);
  return app;
}

async function createAppWithActor(actor: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", costRoutes(makeDb() as any, {
    services: {
      budgetService: mockBudgetService as any,
      costService: mockCostService as any,
      financeService: mockFinanceService as any,
      companyService: mockCompanyService as any,
      agentService: mockAgentService as any,
      heartbeatService: mockHeartbeatService as any,
      logActivity: mockLogActivity as any,
    },
    fetchAllQuotaWindows: mockFetchAllQuotaWindows as any,
  }));
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  vi.resetAllMocks();
  mockCostService.createEvent.mockResolvedValue(undefined);
  mockCostService.summary.mockResolvedValue({ spendCents: 0 });
  mockCostService.byAgent.mockResolvedValue([]);
  mockCostService.byAgentModel.mockResolvedValue([]);
  mockCostService.byProvider.mockResolvedValue([]);
  mockCostService.byBiller.mockResolvedValue([]);
  mockCostService.windowSpend.mockResolvedValue([]);
  mockCostService.byProject.mockResolvedValue([]);
  mockFinanceService.createEvent.mockResolvedValue(undefined);
  mockFinanceService.summary.mockResolvedValue({
    debitCents: 0,
    creditCents: 0,
    netCents: 0,
    estimatedDebitCents: 0,
    eventCount: 0,
  });
  mockFinanceService.byBiller.mockResolvedValue([]);
  mockFinanceService.byKind.mockResolvedValue([]);
  mockFinanceService.list.mockResolvedValue([]);
  mockHeartbeatService.cancelBudgetScopeWork.mockResolvedValue(undefined);
  mockLogActivity.mockResolvedValue(undefined);
  mockFetchAllQuotaWindows.mockResolvedValue([]);
  mockCompanyService.update.mockResolvedValue({
    id: "company-1",
    name: "Paperclip",
    budgetMonthlyCents: 100,
    spentMonthlyCents: 0,
  });
  mockAgentService.update.mockResolvedValue({
    id: "agent-1",
    companyId: "company-1",
    name: "Budget Agent",
    budgetMonthlyCents: 100,
    spentMonthlyCents: 0,
  });
  mockBudgetService.upsertPolicy.mockResolvedValue(undefined);
});

describe("cost routes", () => {
  it("accepts valid ISO date strings and passes them to cost summary routes", async () => {
    const app = await createApp();
    const res = await request(app)
      .get("/api/companies/company-1/costs/summary")
      .query({ from: "2026-01-01T00:00:00.000Z", to: "2026-01-31T23:59:59.999Z" });
    expect(res.status).toBe(200);
  });

  it("returns 400 for an invalid 'from' date string", async () => {
    const app = await createApp();
    const res = await request(app)
      .get("/api/companies/company-1/costs/summary")
      .query({ from: "not-a-date" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid 'from' date/i);
  });

  it("returns 400 for an invalid 'to' date string", async () => {
    const app = await createApp();
    const res = await request(app)
      .get("/api/companies/company-1/costs/summary")
      .query({ to: "banana" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid 'to' date/i);
  });

  it("returns finance summary rows for valid requests", async () => {
    const app = await createApp();
    const res = await request(app)
      .get("/api/companies/company-1/costs/finance-summary")
      .query({ from: "2026-02-01T00:00:00.000Z", to: "2026-02-28T23:59:59.999Z" });
    expect(res.status).toBe(200);
    expect(mockFinanceService.summary).toHaveBeenCalled();
  });

  it("returns 400 for invalid finance event list limits", async () => {
    const app = await createApp();
    const res = await request(app)
      .get("/api/companies/company-1/costs/finance-events")
      .query({ limit: "0" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid 'limit'/i);
  });

  it("accepts valid finance event list limits", async () => {
    const app = await createApp();
    const res = await request(app)
      .get("/api/companies/company-1/costs/finance-events")
      .query({ limit: "25" });
    expect(res.status).toBe(200);
    expect(mockFinanceService.list).toHaveBeenCalledWith("company-1", undefined, 25);
  });

  it("accepts cacheCreationInputTokens on cost events and strips client-supplied estimates", async () => {
    mockCostService.createEvent.mockResolvedValue({
      id: "cost-event-1",
      companyId: "company-1",
      agentId: "11111111-1111-4111-8111-111111111111",
      issueId: null,
      projectId: null,
      goalId: null,
      heartbeatRunId: null,
      billingCode: null,
      provider: "anthropic",
      biller: "anthropic",
      billingType: "subscription_included",
      model: "claude-sonnet-4-6",
      inputTokens: 100,
      cachedInputTokens: 10,
      cacheCreationInputTokens: 25,
      outputTokens: 5,
      costCents: 0,
      estimatedApiCostCents: 123,
      occurredAt: new Date("2026-04-10T12:00:00.000Z"),
      createdAt: new Date("2026-04-10T12:00:00.000Z"),
    });

    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/cost-events")
      .send({
        agentId: "11111111-1111-4111-8111-111111111111",
        provider: "anthropic",
        biller: "anthropic",
        billingType: "subscription_included",
        model: "claude-sonnet-4-6",
        inputTokens: 100,
        cachedInputTokens: 10,
        cacheCreationInputTokens: 25,
        outputTokens: 5,
        costCents: 0,
        estimatedApiCostCents: 9_999,
        occurredAt: "2026-04-10T12:00:00.000Z",
      });

    expect(res.status).toBe(201);
    expect(mockCostService.createEvent).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        cacheCreationInputTokens: 25,
      }),
    );
    expect(mockCostService.createEvent.mock.calls[0]?.[1]).not.toHaveProperty("estimatedApiCostCents");
  });

  it("rejects company budget updates for board users outside the company", async () => {
    const app = await createAppWithActor({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-2"],
    });

    const res = await request(app)
      .patch("/api/companies/company-1/budgets")
      .send({ budgetMonthlyCents: 2500 });

    expect(res.status).toBe(403);
    expect(mockCompanyService.update).not.toHaveBeenCalled();
  });

  it("rejects agent budget updates for board users outside the agent company", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      name: "Budget Agent",
      budgetMonthlyCents: 100,
      spentMonthlyCents: 0,
    });
    const app = await createAppWithActor({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-2"],
    });

    const res = await request(app)
      .patch("/api/agents/agent-1/budgets")
      .send({ budgetMonthlyCents: 2500 });

    expect(res.status).toBe(403);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });
});
