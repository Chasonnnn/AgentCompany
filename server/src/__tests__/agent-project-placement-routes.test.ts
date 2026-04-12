import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  getMembership: vi.fn(),
  listPrincipalGrants: vi.fn(),
  ensureMembership: vi.fn(),
  setPrincipalPermission: vi.fn(),
}));

const mockApprovalService = vi.hoisted(() => ({
  create: vi.fn(),
}));
const mockBudgetService = vi.hoisted(() => ({
  upsertPolicy: vi.fn(),
}));
const mockHeartbeatService = vi.hoisted(() => ({}));
const mockIssueApprovalService = vi.hoisted(() => ({
  linkManyForApproval: vi.fn(),
}));
const mockWorkspaceOperationService = vi.hoisted(() => ({}));
const mockAgentInstructionsService = vi.hoisted(() => ({
  materializeManagedBundle: vi.fn(),
}));
const mockAgentSkillService = vi.hoisted(() => ({
  resolveDesiredSkillAssignment: vi.fn(),
}));
const mockAgentTemplateService = vi.hoisted(() => ({
  resolveRevisionForInstantiation: vi.fn(),
}));
const mockAgentProjectPlacementService = vi.hoisted(() => ({
  previewForInput: vi.fn(),
  applyPrimaryPlacement: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeAdapterConfigForPersistence: vi.fn(async (_companyId: string, config: Record<string, unknown>) => config),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockTrackAgentCreated = vi.hoisted(() => vi.fn());
const mockGetTelemetryClient = vi.hoisted(() => vi.fn());

function registerRouteMocks() {
  vi.doMock("@paperclipai/shared/telemetry", () => ({
    trackAgentCreated: mockTrackAgentCreated,
    trackErrorHandlerCrash: vi.fn(),
  }));

  vi.doMock("../telemetry.js", () => ({
    getTelemetryClient: mockGetTelemetryClient,
  }));

  vi.doMock("../services/index.js", () => ({
    agentService: () => mockAgentService,
    accessService: () => mockAccessService,
    approvalService: () => mockApprovalService,
    agentInstructionsService: () => mockAgentInstructionsService,
    agentProjectPlacementService: () => mockAgentProjectPlacementService,
    agentSkillService: () => mockAgentSkillService,
    agentTemplateService: () => mockAgentTemplateService,
    budgetService: () => mockBudgetService,
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => mockIssueApprovalService,
    issueService: () => ({}),
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
    syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
    workspaceOperationService: () => mockWorkspaceOperationService,
  }));

  vi.doMock("../adapters/index.js", () => ({
    findServerAdapter: vi.fn(() => ({ type: "codex_local" })),
    findActiveServerAdapter: vi.fn(() => ({ type: "codex_local" })),
    listAdapterModels: vi.fn(),
    detectAdapterModel: vi.fn(),
    requireServerAdapter: vi.fn(() => ({ type: "codex_local" })),
  }));
}

function createDb(requireBoardApprovalForNewAgents = false) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => [
          {
            id: "company-1",
            requireBoardApprovalForNewAgents,
          },
        ]),
      })),
    })),
  };
}

async function createApp(db: Record<string, unknown> = createDb()) {
  const { agentRoutes } = await import("../routes/agents.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "board-user",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", agentRoutes(db as any));
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err?.status ?? 500).json({ error: err?.message ?? "Internal server error" });
  });
  return app;
}

function makeAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    name: "Frontend Engineer",
    role: "engineer",
    title: "Frontend Engineer",
    status: "idle",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    permissions: {},
    operatingClass: "worker",
    archetypeKey: "frontend_engineer",
    ...overrides,
  };
}

describe("agent project placement routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    registerRouteMocks();
    mockGetTelemetryClient.mockReturnValue({ track: vi.fn() });
    mockAccessService.ensureMembership.mockResolvedValue(undefined);
    mockAccessService.setPrincipalPermission.mockResolvedValue(undefined);
    mockAgentTemplateService.resolveRevisionForInstantiation.mockResolvedValue(null);
    mockAgentSkillService.resolveDesiredSkillAssignment.mockResolvedValue({
      desiredSkills: [],
      adapterConfig: {},
    });
    mockAgentInstructionsService.materializeManagedBundle.mockImplementation(
      async (agent: Record<string, unknown>) => ({
        ...agent,
        adapterConfig: agent.adapterConfig ?? {},
      }),
    );
    mockAgentProjectPlacementService.previewForInput.mockResolvedValue({
      projectId: "22222222-2222-4222-8222-222222222222",
      scopeMode: "execution",
      projectRole: "worker",
      teamFunctionKey: "frontend",
      teamFunctionLabel: "Frontend",
      workstreamKey: null,
      workstreamLabel: null,
      requestedReason: "Onboarding team staffing",
    });
    mockAgentProjectPlacementService.applyPrimaryPlacement.mockResolvedValue({
      scope: {
        id: "scope-1",
        projectId: "22222222-2222-4222-8222-222222222222",
        scopeMode: "execution",
        projectRole: "worker",
      },
      resolved: {
        projectId: "22222222-2222-4222-8222-222222222222",
        scopeMode: "execution",
        projectRole: "worker",
        teamFunctionKey: "frontend",
        teamFunctionLabel: "Frontend",
        workstreamKey: null,
        workstreamLabel: null,
        requestedReason: "Onboarding team staffing",
      },
    });
    mockApprovalService.create.mockResolvedValue({
      id: "approval-1",
      companyId: "company-1",
      type: "hire_agent",
      status: "pending",
    });
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("applies direct create placement through the shared placement service", async () => {
    mockAgentService.create.mockResolvedValue(
      makeAgent({
        requestedForProjectId: "22222222-2222-4222-8222-222222222222",
        requestedReason: "Onboarding team staffing",
      }),
    );

    const res = await request(await createApp())
      .post("/api/companies/company-1/agents")
      .send({
        name: "Frontend Engineer",
        role: "engineer",
        adapterType: "codex_local",
        operatingClass: "worker",
        archetypeKey: "frontend_engineer",
        projectPlacement: {
          projectId: "22222222-2222-4222-8222-222222222222",
          teamFunctionKey: "frontend",
          teamFunctionLabel: "Frontend",
          requestedReason: "Onboarding team staffing",
        },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockAgentProjectPlacementService.previewForInput).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        companyId: "company-1",
        operatingClass: "worker",
        archetypeKey: "frontend_engineer",
      }),
      expect.objectContaining({
        projectId: "22222222-2222-4222-8222-222222222222",
        teamFunctionKey: "frontend",
      }),
    );
    expect(mockAgentProjectPlacementService.applyPrimaryPlacement).toHaveBeenCalledWith({
      companyId: "company-1",
      agentId: "11111111-1111-4111-8111-111111111111",
      placement: {
        projectId: "22222222-2222-4222-8222-222222222222",
        teamFunctionKey: "frontend",
        teamFunctionLabel: "Frontend",
        requestedReason: "Onboarding team staffing",
      },
      actor: {
        principalType: "human_operator",
        principalId: "board-user",
      },
    });
    expect(mockAgentService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        requestedForProjectId: "22222222-2222-4222-8222-222222222222",
        requestedReason: "Onboarding team staffing",
      }),
    );
  });

  it("stores hire placement in the approval payload and defers scope creation until approval", async () => {
    mockAgentService.create.mockResolvedValue(
      makeAgent({
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        status: "pending_approval",
        requestedForProjectId: "22222222-2222-4222-8222-222222222222",
        requestedReason: "Onboarding team staffing",
      }),
    );

    const res = await request(await createApp(createDb(true)))
      .post("/api/companies/company-1/agent-hires")
      .send({
        name: "Frontend Engineer",
        role: "engineer",
        adapterType: "codex_local",
        operatingClass: "worker",
        archetypeKey: "frontend_engineer",
        projectPlacement: {
          projectId: "22222222-2222-4222-8222-222222222222",
          teamFunctionKey: "frontend",
          requestedReason: "Onboarding team staffing",
        },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockAgentProjectPlacementService.previewForInput).toHaveBeenCalledTimes(1);
    expect(mockAgentProjectPlacementService.applyPrimaryPlacement).not.toHaveBeenCalled();
    expect(mockApprovalService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        type: "hire_agent",
        payload: expect.objectContaining({
          agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          projectPlacement: {
            projectId: "22222222-2222-4222-8222-222222222222",
            teamFunctionKey: "frontend",
            requestedReason: "Onboarding team staffing",
          },
        }),
      }),
    );
    expect(mockAgentService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        requestedForProjectId: "22222222-2222-4222-8222-222222222222",
        requestedReason: "Onboarding team staffing",
        status: "pending_approval",
      }),
    );
  });
});
