import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

async function createApp(
  actor: Record<string, unknown> = {
    type: "board",
    userId: "board-user",
    companyIds: ["company-1"],
    source: "local_implicit",
    isInstanceAdmin: false,
  },
) {
  const listForCompany = createAsyncRecorder(async () => [makeEngagement()]);
  const listAdvisorTemplates = createAsyncRecorder(async () => [makeAdvisorTemplate()]);
  const recommendSurface = createAsyncRecorder(async () => ({
    recommendedSurface: "decision_question",
    reason: "Blocking board asks should use decision questions.",
    matchedSignals: ["blocks_execution", "requests_board_answer"],
  }));
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
  const wakeup = createAsyncRecorder(async () => undefined);
  const findOfficeOperator = createAsyncRecorder(async () => ({
    id: "office-1",
    companyId: "company-1",
    role: "coo",
    archetypeKey: "chief_of_staff",
    status: "idle",
  }));
  const buildWakeSnapshot = createAsyncRecorder(async () => ({
    companyId: "company-1",
    officeAgentId: "office-1",
    trigger: { reason: "shared_service_engagement_requested" },
    queueCounts: {
      untriagedIntake: 0,
      unassignedIssues: 0,
      blockedIssues: 0,
      staleIssues: 0,
      staffingGaps: 0,
      engagementsNeedingAttention: 1,
      sharedSkillItems: 0,
    },
    untriagedIntake: [],
    unassignedIssues: [],
    blockedIssues: [],
    staleIssues: [],
    staffingGaps: [],
    engagementsNeedingAttention: [],
    sharedSkillItems: [],
    recentActions: [],
  }));
  const logActivity = createAsyncRecorder(async () => undefined);
  const engagements = {
    listForCompany: listForCompany.fn,
    listAdvisorTemplates: listAdvisorTemplates.fn,
    recommendSurface: recommendSurface.fn,
    create: create.fn,
    getById: getById.fn,
    update: update.fn,
    approve: approve.fn,
    close: close.fn,
  };
  vi.doUnmock("../routes/shared-service-engagements.js");
  vi.doUnmock("../middleware/index.js");
  vi.doUnmock("../middleware/validate.js");
  vi.doUnmock("../routes/authz.js");
  vi.doUnmock("../services/index.js");
  vi.doUnmock("../services/office-coordination-wakeup.js");
  const [{ sharedServiceEngagementRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/shared-service-engagements.js")>(
      "../routes/shared-service-engagements.js",
    ),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = { ...actor };
    next();
  });
  app.use(
    "/api",
    sharedServiceEngagementRoutes({} as any, {
      engagements: engagements as any,
      heartbeatService: { wakeup: wakeup.fn } as any,
      logActivity: logActivity.fn,
      officeCoordinationService: {
        findOfficeOperator: findOfficeOperator.fn,
        buildWakeSnapshot: buildWakeSnapshot.fn,
      } as any,
    }),
  );
  app.use(errorHandler);
  return {
    app,
    services: {
      listForCompany,
      listAdvisorTemplates,
      recommendSurface,
      create,
      getById,
      update,
      approve,
      close,
      logActivity,
      wakeup,
      findOfficeOperator,
      buildWakeSnapshot,
    },
  };
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
    advisorKind: null,
    advisorEnabled: false,
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

function makeAdvisorTemplate(overrides: Record<string, unknown> = {}) {
  return {
    advisorKind: "security_audit",
    serviceAreaKey: "security",
    serviceAreaLabel: "Security",
    title: "Security Audit",
    summary: "Run a focused security review on the target project.",
    disabledByDefault: true,
    ...overrides,
  };
}

describe("shared-service engagement routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
  });

  it("lists engagements for an authorized company actor", async () => {
    const { app, services } = await createApp();
    const res = await request(app).get("/api/companies/company-1/shared-service-engagements");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(services.listForCompany.calls).toEqual([["company-1"]]);
  });

  it("creates an engagement with actor metadata", async () => {
    const { app, services } = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/shared-service-engagements")
      .send({
        targetProjectId: "22222222-2222-4222-8222-222222222222",
        serviceAreaKey: "research",
        serviceAreaLabel: "Research",
        title: "Audit product launch",
        summary: "Run a pre-launch audit on the current release candidate",
        advisorKind: "security_audit",
        advisorEnabled: true,
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
        advisorKind: "security_audit",
        advisorEnabled: true,
        assignedAgentIds: ["44444444-4444-4444-8444-444444444444"],
      },
      {
        actorType: "user",
        actorId: "board-user",
        agentId: null,
      },
    ]]);
    expect(services.wakeup.calls).toHaveLength(1);
  });

  it("lists built-in advisor engagement templates for company actors", async () => {
    const { app, services } = await createApp();
    const res = await request(app).get("/api/companies/company-1/shared-service-engagements/advisor-templates");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(services.listAdvisorTemplates.calls).toEqual([[]]);
    expect(res.body).toEqual([makeAdvisorTemplate()]);
  });

  it("recommends an advisory surface from a draft payload", async () => {
    const { app, services } = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/shared-service-engagements/recommend-surface")
      .send({
        title: "Need a board answer before we proceed",
        summary: "This is blocked until we know which option to pursue.",
        requestsBoardAnswer: true,
        blocksExecution: true,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(services.recommendSurface.calls).toEqual([[
      {
        title: "Need a board answer before we proceed",
        summary: "This is blocked until we know which option to pursue.",
        requestsBoardAnswer: true,
        blocksExecution: true,
        requiresGovernance: false,
        needsCrossFunctionalCoordination: false,
        participantAgentIds: [],
      },
    ]]);
    expect(res.body).toEqual({
      recommendedSurface: "decision_question",
      reason: "Blocking board asks should use decision questions.",
      matchedSignals: ["blocks_execution", "requests_board_answer"],
    });
  });

  it("approves an engagement for board actors", async () => {
    const { app, services } = await createApp();
    const res = await request(app)
      .post("/api/shared-service-engagements/11111111-1111-4111-8111-111111111111/approve");

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
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
    const { app, services } = await createApp({
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
    const { app, services } = await createApp();
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
    expect(services.wakeup.calls).toHaveLength(1);
  });
});
