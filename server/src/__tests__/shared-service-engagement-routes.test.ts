import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { sharedServiceEngagementRoutes } from "../routes/shared-service-engagements.js";

function createAsyncRecorder<TArgs extends unknown[], TResult>(
  impl: (...args: TArgs) => Promise<TResult> | TResult,
) {
  const calls: TArgs[] = [];
  return {
    calls,
    fn: async (...args: TArgs): Promise<TResult> => {
      calls.push(args);
      return await impl(...args);
    },
  };
}

function createApp(
  actor: Record<string, unknown> = {
    type: "board",
    userId: "board-user",
    companyIds: ["company-1"],
    source: "local_implicit",
    isInstanceAdmin: false,
  },
) {
  const listForCompany = createAsyncRecorder(async () => [makeEngagement()]);
  const create = createAsyncRecorder(async () => makeEngagement());
  const getById = createAsyncRecorder(async () => makeEngagement());
  const update = createAsyncRecorder(async () => makeEngagement({ title: "Updated audit" }));
  const approve = createAsyncRecorder(async () =>
    makeEngagement({
      status: "approved",
      approvedByUserId: "board-user",
      approvedAt: new Date(),
    })
  );
  const close = createAsyncRecorder(async () =>
    makeEngagement({
      status: "closed",
      outcomeSummary: "Audit delivered",
      closedByUserId: "board-user",
      closedAt: new Date(),
    })
  );
  const logActivity = createAsyncRecorder(async () => undefined);
  const engagements = {
    listForCompany: listForCompany.fn,
    create: create.fn,
    getById: getById.fn,
    update: update.fn,
    approve: approve.fn,
    close: close.fn,
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use(
    "/api",
    sharedServiceEngagementRoutes({} as any, {
      engagements: engagements as any,
      logActivity: logActivity.fn,
    }),
  );
  app.use(errorHandler);
  return { app, services: { listForCompany, create, getById, update, approve, close, logActivity } };
}

function makeEngagement(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    targetProjectId: "22222222-2222-4222-8222-222222222222",
    serviceAreaKey: "research",
    serviceAreaLabel: "Research",
    title: "Audit product launch",
    summary: "Run a pre-launch audit on the current release candidate",
    status: "requested",
    requestedByAgentId: null,
    requestedByUserId: "board-user",
    approvedByAgentId: null,
    approvedByUserId: null,
    approvedAt: null,
    closedByAgentId: null,
    closedByUserId: null,
    closedAt: null,
    outcomeSummary: null,
    metadata: null,
    assignments: [
      {
        id: "33333333-3333-4333-8333-333333333333",
        companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        engagementId: "11111111-1111-4111-8111-111111111111",
        agentId: "44444444-4444-4444-8444-444444444444",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("shared-service engagement routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("lists engagements for an authorized company actor", async () => {
    const { app, services } = createApp();
    const res = await request(app).get("/api/companies/company-1/shared-service-engagements");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(services.listForCompany.calls).toEqual([["company-1"]]);
  });

  it("creates an engagement with actor metadata", async () => {
    const { app, services } = createApp();
    const res = await request(app)
      .post("/api/companies/company-1/shared-service-engagements")
      .send({
        targetProjectId: "22222222-2222-4222-8222-222222222222",
        serviceAreaKey: "research",
        serviceAreaLabel: "Research",
        title: "Audit product launch",
        summary: "Run a pre-launch audit on the current release candidate",
        assignedAgentIds: ["44444444-4444-4444-8444-444444444444"],
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(services.create.calls).toEqual([[
      "company-1",
      {
        targetProjectId: "22222222-2222-4222-8222-222222222222",
        serviceAreaKey: "research",
        serviceAreaLabel: "Research",
        title: "Audit product launch",
        summary: "Run a pre-launch audit on the current release candidate",
        assignedAgentIds: ["44444444-4444-4444-8444-444444444444"],
      },
      {
        actorType: "user",
        actorId: "board-user",
        agentId: null,
      },
    ]]);
  });

  it("approves an engagement for board actors", async () => {
    const { app, services } = createApp();
    const res = await request(app)
      .post("/api/shared-service-engagements/11111111-1111-4111-8111-111111111111/approve");

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(services.approve.calls).toEqual([[
      "11111111-1111-4111-8111-111111111111",
      {
        actorType: "user",
        actorId: "board-user",
        agentId: null,
      },
    ]]);
  });

  it("rejects approval for non-board actors", async () => {
    const { app, services } = createApp({
      type: "agent",
      companyId: "company-1",
      companyIds: ["company-1"],
      agentId: "agent-1",
    });
    const res = await request(app).post("/api/shared-service-engagements/11111111-1111-4111-8111-111111111111/approve");

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(services.approve.calls).toHaveLength(0);
  });

  it("closes an engagement for board actors", async () => {
    const { app, services } = createApp();
    const res = await request(app)
      .post("/api/shared-service-engagements/11111111-1111-4111-8111-111111111111/close")
      .send({ outcomeSummary: "Audit delivered" });

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    expect(services.close.calls).toEqual([[
      "11111111-1111-4111-8111-111111111111",
      {
        actorType: "user",
        actorId: "board-user",
        agentId: null,
      },
      "Audit delivered",
    ]]);
  });
});
