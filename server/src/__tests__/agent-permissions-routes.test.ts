import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";

const agentId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";

const baseAgent = {
  id: agentId,
  companyId,
  name: "Builder",
  urlKey: "builder",
  role: "engineer",
  title: "Builder",
  icon: null,
  status: "idle",
  reportsTo: null,
  capabilities: null,
  adapterType: "process",
  adapterConfig: {},
  runtimeConfig: {},
  budgetMonthlyCents: 0,
  spentMonthlyCents: 0,
  pauseReason: null,
  pausedAt: null,
  permissions: { canCreateAgents: false },
  lastHeartbeatAt: null,
  metadata: null,
  createdAt: new Date("2026-03-19T00:00:00.000Z"),
  updatedAt: new Date("2026-03-19T00:00:00.000Z"),
};

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  create: vi.fn(),
  updatePermissions: vi.fn(),
  getChainOfCommand: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  getMembership: vi.fn(),
  ensureMembership: vi.fn(),
  listPrincipalGrants: vi.fn(),
  setPrincipalPermission: vi.fn(),
}));

const mockApprovalService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
}));

const mockBudgetService = vi.hoisted(() => ({
  upsertPolicy: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  listTaskSessions: vi.fn(),
  resetRuntimeSession: vi.fn(),
  getRun: vi.fn(),
  cancelRun: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  linkManyForApproval: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeAdapterConfigForPersistence: vi.fn(),
  resolveAdapterConfigForRuntime: vi.fn(),
}));

const mockAgentInstructionsService = vi.hoisted(() => ({
  materializeManagedBundle: vi.fn(),
}));
const mockAgentSkillService = vi.hoisted(() => ({
  listSkills: vi.fn(),
  syncAgentSkills: vi.fn(),
  resolveDesiredSkillAssignment: vi.fn(),
}));
const mockAgentTemplateService = vi.hoisted(() => ({
  resolveRevisionForInstantiation: vi.fn(),
}));
const mockWorkspaceOperationService = vi.hoisted(() => ({}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockTrackAgentCreated = vi.hoisted(() => vi.fn());
const mockGetTelemetryClient = vi.hoisted(() => vi.fn());

function createDbStub() {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          then: vi.fn().mockResolvedValue([{
            id: companyId,
            name: "Paperclip",
            requireBoardApprovalForNewAgents: false,
          }]),
        }),
      }),
    }),
  };
}

async function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use(
    "/api",
    agentRoutes(createDbStub() as any, {
      services: {
        agentService: mockAgentService as any,
        accessService: mockAccessService as any,
        agentProjectPlacementService: {
          previewForInput: vi.fn(),
          applyPrimaryPlacement: vi.fn(),
        } as any,
        agentTemplateService: mockAgentTemplateService as any,
        approvalService: mockApprovalService as any,
        agentSkillService: mockAgentSkillService as any,
        budgetService: mockBudgetService as any,
        heartbeatService: mockHeartbeatService as any,
        issueApprovalService: mockIssueApprovalService as any,
        issueService: mockIssueService as any,
        logActivity: mockLogActivity as any,
        secretService: mockSecretService as any,
        agentInstructionsService: mockAgentInstructionsService as any,
        workspaceOperationService: mockWorkspaceOperationService as any,
        instanceSettingsService: {} as any,
      },
      telemetry: {
        getTelemetryClient: mockGetTelemetryClient as any,
        trackAgentCreated: mockTrackAgentCreated as any,
      },
    }),
  );
  app.use(errorHandler);
  return app;
}

describe("agent permission routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTelemetryClient.mockReturnValue({ track: vi.fn() });
    mockAgentTemplateService.resolveRevisionForInstantiation.mockResolvedValue(null);
    mockAgentService.getById.mockResolvedValue(baseAgent);
    mockAgentService.getChainOfCommand.mockResolvedValue([]);
    mockAgentService.resolveByReference.mockResolvedValue({ ambiguous: false, agent: baseAgent });
    mockAgentService.create.mockResolvedValue(baseAgent);
    mockAgentService.updatePermissions.mockResolvedValue(baseAgent);
    mockAccessService.getMembership.mockResolvedValue({
      id: "membership-1",
      companyId,
      principalType: "agent",
      principalId: agentId,
      status: "active",
      membershipRole: "member",
      createdAt: new Date("2026-03-19T00:00:00.000Z"),
      updatedAt: new Date("2026-03-19T00:00:00.000Z"),
    });
    mockAccessService.listPrincipalGrants.mockResolvedValue([]);
    mockAccessService.ensureMembership.mockResolvedValue(undefined);
    mockAccessService.setPrincipalPermission.mockResolvedValue(undefined);
    mockAgentSkillService.resolveDesiredSkillAssignment.mockImplementation(
      async (
        _companyId: string,
        _adapterType: string,
        adapterConfig: Record<string, unknown>,
        requestedDesiredSkills: string[] | undefined,
      ) => ({
        adapterConfig,
        desiredSkills: requestedDesiredSkills ?? null,
        runtimeSkillEntries: null,
      }),
    );
    mockBudgetService.upsertPolicy.mockResolvedValue(undefined);
    mockAgentInstructionsService.materializeManagedBundle.mockImplementation(
      async (agent: Record<string, unknown>, files: Record<string, string>) => ({
        bundle: null,
        adapterConfig: {
          ...((agent.adapterConfig as Record<string, unknown> | undefined) ?? {}),
          instructionsBundleMode: "managed",
          instructionsRootPath: `/tmp/${String(agent.id)}/instructions`,
          instructionsEntryFile: "AGENTS.md",
          instructionsFilePath: `/tmp/${String(agent.id)}/instructions/AGENTS.md`,
          promptTemplate: files["AGENTS.md"] ?? "",
        },
      }),
    );
    mockSecretService.normalizeAdapterConfigForPersistence.mockImplementation(async (_companyId, config) => config);
    mockSecretService.resolveAdapterConfigForRuntime.mockImplementation(async (_companyId, config) => ({ config }));
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("grants tasks:assign by default when board creates a new agent", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({
        name: "Builder",
        role: "engineer",
        adapterType: "process",
        adapterConfig: {},
      });

    expect([200, 201]).toContain(res.status);
    expect(mockAccessService.ensureMembership).toHaveBeenCalledWith(
      companyId,
      "agent",
      agentId,
      "member",
      "active",
    );
    expect(mockAccessService.setPrincipalPermission).toHaveBeenCalledWith(
      companyId,
      "agent",
      agentId,
      "tasks:assign",
      true,
      "board-user",
    );
  });

  it("normalizes direct agent creation to disable timer heartbeats by default", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({
        name: "Builder",
        role: "engineer",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {
          heartbeat: {
            intervalSec: 3600,
          },
        },
      });

    expect([200, 201]).toContain(res.status);
    expect(mockAgentService.create).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({
        runtimeConfig: {
          heartbeat: {
            enabled: false,
            intervalSec: 3600,
            maxConcurrentRuns: 1,
          },
        },
      }),
    );
  });

  it("normalizes hire requests to disable timer heartbeats by default", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/agent-hires`)
      .send({
        name: "Builder",
        role: "engineer",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {
          heartbeat: {
            intervalSec: 3600,
          },
        },
      });

    expect([200, 201]).toContain(res.status);
    expect(mockAgentService.create).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({
        runtimeConfig: expect.objectContaining({
          heartbeat: expect.objectContaining({
            enabled: false,
            intervalSec: 3600,
            maxConcurrentRuns: 1,
          }),
        }),
      }),
    );
  });

  it("exposes explicit task assignment access on agent detail", async () => {
    mockAccessService.listPrincipalGrants.mockResolvedValue([
      {
        id: "grant-1",
        companyId,
        principalType: "agent",
        principalId: agentId,
        permissionKey: "tasks:assign",
        scope: null,
        grantedByUserId: "board-user",
        createdAt: new Date("2026-03-19T00:00:00.000Z"),
        updatedAt: new Date("2026-03-19T00:00:00.000Z"),
      },
    ]);

    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });

    const res = await request(app).get(`/api/agents/${agentId}`);

    expect(res.status).toBe(200);
    expect(res.body.access.canAssignTasks).toBe(true);
    expect(res.body.access.taskAssignSource).toBe("explicit_grant");
  });

  it("keeps task assignment enabled when capability-based create authority is enabled", async () => {
    mockAgentService.updatePermissions.mockResolvedValue({
      ...baseAgent,
      permissions: { canCreateAgents: true },
    });

    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });

    const res = await request(app)
      .patch(`/api/agents/${agentId}/permissions`)
      .send({ canCreateAgents: true, canAssignTasks: false });

    expect(res.status).toBe(200);
    expect(mockAccessService.setPrincipalPermission).toHaveBeenCalledWith(
      companyId,
      "agent",
      agentId,
      "tasks:assign",
      true,
      "board-user",
    );
    expect(res.body.access.canAssignTasks).toBe(true);
    expect(res.body.access.taskAssignSource).toBe("capability_profile");
  });

  it("exposes a dedicated agent route for the inbox mine view", async () => {
    mockIssueService.list.mockResolvedValue([
      {
        id: "issue-1",
        identifier: "PAP-910",
        title: "Inbox follow-up",
        status: "todo",
      },
    ]);

    const app = await createApp({
      type: "agent",
      agentId,
      companyId,
      runId: "run-1",
      source: "agent_key",
    });

    const res = await request(app)
      .get("/api/agents/me/inbox/mine")
      .query({ userId: "board-user" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        id: "issue-1",
        identifier: "PAP-910",
        title: "Inbox follow-up",
        status: "todo",
      },
    ]);
  });

  it("rejects heartbeat cancellation outside the caller company scope", async () => {
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-1",
      companyId: "33333333-3333-4333-8333-333333333333",
      agentId,
      status: "running",
    });

    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app).post("/api/heartbeat-runs/run-1/cancel").send({});

    expect(res.status).toBe(403);
    expect(mockHeartbeatService.cancelRun).not.toHaveBeenCalled();
  });
});
