import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSharedServiceEngagementService = vi.hoisted(() => ({
  listForCompany: vi.fn(),
  create: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
  approve: vi.fn(),
  close: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  logActivity: mockLogActivity,
  sharedServiceEngagementService: () => mockSharedServiceEngagementService,
}));

async function createApp(
  actor: Record<string, unknown> = {
    type: "board",
    userId: "board-user",
    companyIds: ["company-1"],
    source: "local_implicit",
    isInstanceAdmin: false,
  },
) {
  const [{ sharedServiceEngagementRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/shared-service-engagements.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", sharedServiceEngagementRoutes({} as any));
  app.use(errorHandler);
  return app;
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
    mockSharedServiceEngagementService.listForCompany.mockResolvedValue([makeEngagement()]);
    mockSharedServiceEngagementService.create.mockResolvedValue(makeEngagement());
    mockSharedServiceEngagementService.getById.mockResolvedValue(makeEngagement());
    mockSharedServiceEngagementService.update.mockResolvedValue(makeEngagement({ title: "Updated audit" }));
    mockSharedServiceEngagementService.approve.mockResolvedValue(
      makeEngagement({
        status: "approved",
        approvedByUserId: "board-user",
        approvedAt: new Date(),
      }),
    );
    mockSharedServiceEngagementService.close.mockResolvedValue(
      makeEngagement({
        status: "closed",
        outcomeSummary: "Audit delivered",
        closedByUserId: "board-user",
        closedAt: new Date(),
      }),
    );
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("lists engagements for an authorized company actor", async () => {
    const res = await request(await createApp()).get("/api/companies/company-1/shared-service-engagements");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockSharedServiceEngagementService.listForCompany).toHaveBeenCalledWith("company-1");
  });

  it("creates an engagement with actor metadata", async () => {
    const res = await request(await createApp())
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
    expect(mockSharedServiceEngagementService.create).toHaveBeenCalledWith(
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
    );
  });

  it("approves an engagement for board actors", async () => {
    const res = await request(await createApp())
      .post("/api/shared-service-engagements/11111111-1111-4111-8111-111111111111/approve");

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockSharedServiceEngagementService.approve).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      {
        actorType: "user",
        actorId: "board-user",
        agentId: null,
      },
    );
  });

  it("rejects approval for non-board actors", async () => {
    const res = await request(await createApp({
      type: "agent",
      companyId: "company-1",
      companyIds: ["company-1"],
      agentId: "agent-1",
    })).post("/api/shared-service-engagements/11111111-1111-4111-8111-111111111111/approve");

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mockSharedServiceEngagementService.approve).not.toHaveBeenCalled();
  });

  it("closes an engagement for board actors", async () => {
    const res = await request(await createApp())
      .post("/api/shared-service-engagements/11111111-1111-4111-8111-111111111111/close")
      .send({ outcomeSummary: "Audit delivered" });

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    expect(mockSharedServiceEngagementService.close).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      {
        actorType: "user",
        actorId: "board-user",
        agentId: null,
      },
      "Audit delivered",
    );
  });
});
