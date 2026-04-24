import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
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
const mockBudgetService = vi.hoisted(() => ({}));
const mockEnvironmentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));
const mockHeartbeatService = vi.hoisted(() => ({}));
const mockIssueApprovalService = vi.hoisted(() => ({
  linkManyForApproval: vi.fn(),
}));
const mockWorkspaceOperationService = vi.hoisted(() => ({}));
const mockAgentInstructionsService = vi.hoisted(() => ({
  getBundle: vi.fn(),
  readFile: vi.fn(),
  updateBundle: vi.fn(),
  writeFile: vi.fn(),
  deleteFile: vi.fn(),
  exportFiles: vi.fn(),
  ensureManagedBundle: vi.fn(),
  materializeManagedBundle: vi.fn(),
}));

const mockCompanySkillService = vi.hoisted(() => ({
  listRuntimeSkillEntries: vi.fn(),
  resolveRequestedSkillKeys: vi.fn(),
}));
const mockAgentSkillService = vi.hoisted(() => ({
  listSkills: vi.fn(),
  syncAgentSkills: vi.fn(),
  resolveDesiredSkillAssignment: vi.fn(),
}));
const mockAgentTemplateService = vi.hoisted(() => ({
  list: vi.fn(),
  resolveRevisionForInstantiation: vi.fn(),
  listTemplates: vi.fn(),
  listRevisions: vi.fn(),
  importPack: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  resolveAdapterConfigForRuntime: vi.fn(),
  normalizeAdapterConfigForPersistence: vi.fn(async (_companyId: string, config: Record<string, unknown>) => config),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockTrackAgentCreated = vi.hoisted(() => vi.fn());
const mockGetTelemetryClient = vi.hoisted(() => vi.fn());

const mockAdapter = vi.hoisted(() => ({
  listSkills: vi.fn(),
  syncSkills: vi.fn(),
}));

vi.mock("@paperclipai/shared/telemetry", () => ({
  trackAgentCreated: mockTrackAgentCreated,
  trackErrorHandlerCrash: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: mockGetTelemetryClient,
}));


vi.mock("../adapters/index.js", () => ({
  findServerAdapter: vi.fn(() => mockAdapter),
  findActiveServerAdapter: vi.fn(() => mockAdapter),
  listAdapterModels: vi.fn(),
  detectAdapterModel: vi.fn(),
}));
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

async function createApp(
  db: Record<string, unknown> = createDb(),
  actor: Record<string, unknown> = {
    type: "board",
    userId: "local-board",
    companyIds: ["company-1"],
    source: "local_implicit",
    isInstanceAdmin: false,
  },
) {
  vi.resetModules();
  vi.doUnmock("../routes/agents.js");
  vi.doUnmock("../services/index.js");
  vi.doUnmock("../routes/authz.js");
  vi.doUnmock("../middleware/validate.js");
  const { agentRoutes } = await vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = { ...actor };
    next();
  });
  app.use("/api", agentRoutes(db as any, {
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
      issueService: {} as any,
      logActivity: mockLogActivity as any,
      secretService: mockSecretService as any,
      agentInstructionsService: mockAgentInstructionsService as any,
      workspaceOperationService: mockWorkspaceOperationService as any,
      instanceSettingsService: {
        getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })),
      } as any,
    },
    telemetry: {
      getTelemetryClient: mockGetTelemetryClient as any,
      trackAgentCreated: mockTrackAgentCreated as any,
    },
  }));
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err?.status ?? 500).json({ error: err?.message ?? "Internal server error" });
  });
  return app;
}

function makeAgent(adapterType: string, overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    name: "Agent",
    role: "engineer",
    title: "Engineer",
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType,
    adapterConfig: {},
    runtimeConfig: {},
    defaultEnvironmentId: null,
    permissions: null,
    updatedAt: new Date(),
    archetypeKey: null,
    operatingClass: null,
    ...overrides,
  };
}

function makeTemplateResolution(
  snapshotOverrides: Record<string, unknown> = {},
) {
  return {
    template: {
      id: "22222222-2222-4222-8222-222222222222",
      companyId: "company-1",
      archivedAt: null,
    },
    revision: {
      id: "33333333-3333-4333-8333-333333333333",
      templateId: "22222222-2222-4222-8222-222222222222",
      revisionNumber: 1,
      snapshot: {
        name: "Template Agent",
        role: "engineer",
        title: "Template Agent",
        icon: "bot",
        reportsTo: null,
        orgLevel: "staff",
        operatingClass: "worker",
        capabilityProfileKey: "worker",
        archetypeKey: "frontend_ui_continuity_owner",
        departmentKey: "engineering",
        departmentName: "Engineering",
        capabilities: null,
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {},
        budgetMonthlyCents: 0,
        metadata: null,
        instructionsBody: "Template instructions",
        ...snapshotOverrides,
      },
    },
  };
}

describe("agent skill routes", () => {
  const ceoId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const projectLeadId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    mockGetTelemetryClient.mockReturnValue({ track: vi.fn() });
    mockAgentTemplateService.resolveRevisionForInstantiation.mockResolvedValue(null);
    mockAgentTemplateService.list.mockResolvedValue([
      { id: "template-chief-of-staff", archetypeKey: "chief_of_staff" },
    ]);
    mockAgentService.resolveByReference.mockResolvedValue({
      ambiguous: false,
      agent: makeAgent("claude_local"),
    });
    mockAgentService.list.mockResolvedValue([
      makeAgent("claude_local", {
        id: ceoId,
        name: "CEO",
        role: "ceo",
        archetypeKey: "ceo",
        operatingClass: "executive",
        reportsTo: null,
        status: "active",
      }),
      makeAgent("claude_local", {
        id: projectLeadId,
        name: "Project Lead",
        role: "engineer",
        archetypeKey: "project_lead",
        operatingClass: "project_leadership",
        reportsTo: ceoId,
        status: "active",
      }),
    ]);
    mockSecretService.resolveAdapterConfigForRuntime.mockResolvedValue({ config: { env: {} } });
    mockCompanySkillService.listRuntimeSkillEntries.mockResolvedValue([
      {
        key: "paperclipai/paperclip/paperclip",
        runtimeName: "paperclip",
        source: "/tmp/paperclip",
        required: true,
        requiredReason: "required",
      },
    ]);
    mockCompanySkillService.resolveRequestedSkillKeys.mockImplementation(
      async (_companyId: string, requested: string[]) =>
        requested.map((value) =>
          value === "paperclip"
            ? "paperclipai/paperclip/paperclip"
            : value,
        ),
    );
    mockAdapter.listSkills.mockResolvedValue({
      adapterType: "claude_local",
      supported: true,
      mode: "ephemeral",
      desiredSkills: ["paperclipai/paperclip/paperclip"],
      entries: [],
      warnings: [],
    });
    mockAdapter.syncSkills.mockResolvedValue({
      adapterType: "claude_local",
      supported: true,
      mode: "ephemeral",
      desiredSkills: ["paperclipai/paperclip/paperclip"],
      entries: [],
      warnings: [],
    });
    mockAgentService.update.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({
      ...makeAgent("claude_local", { id }),
      ...patch,
      adapterConfig: patch.adapterConfig ?? {},
      runtimeConfig: patch.runtimeConfig ?? {},
    }));
    mockAgentSkillService.listSkills.mockImplementation(
      async (agent: Record<string, unknown>, options?: { canManage?: boolean }) => {
        const adapterType = String(agent.adapterType ?? "claude_local");
        const materializeMissing = !["claude_local", "codex_local"].includes(adapterType);
        const runtimeSkillEntries = await mockCompanySkillService.listRuntimeSkillEntries(
          "company-1",
          { materializeMissing },
        );
        const { config } = await mockSecretService.resolveAdapterConfigForRuntime(
          "company-1",
          (agent.adapterConfig as Record<string, unknown> | undefined) ?? {},
        );
        const snapshot = await mockAdapter.listSkills({
          agentId: String(agent.id),
          companyId: "company-1",
          adapterType,
          config: {
            ...config,
            paperclipRuntimeSkills: runtimeSkillEntries,
          },
        });
        return { ...snapshot, canManage: options?.canManage ?? false };
      },
    );
    mockAgentSkillService.syncAgentSkills.mockImplementation(
      async (agent: Record<string, unknown>, requestedDesiredSkills: string[]) => {
        const adapterType = String(agent.adapterType ?? "claude_local");
        const resolvedRequestedSkills = await mockCompanySkillService.resolveRequestedSkillKeys(
          "company-1",
          requestedDesiredSkills,
        );
        const materializeMissing = !["claude_local", "codex_local"].includes(adapterType);
        const runtimeSkillEntries = await mockCompanySkillService.listRuntimeSkillEntries(
          "company-1",
          { materializeMissing },
        );
        const requiredSkills = runtimeSkillEntries
          .filter((entry: { required: boolean }) => entry.required)
          .map((entry: { key: string }) => entry.key);
        const desiredSkills = Array.from(new Set([...requiredSkills, ...resolvedRequestedSkills]));
        const updated = await mockAgentService.update(String(agent.id), {
          adapterConfig: {
            ...((agent.adapterConfig as Record<string, unknown> | undefined) ?? {}),
            paperclipSkillSync: { desiredSkills },
          },
        });
        const { config } = await mockSecretService.resolveAdapterConfigForRuntime(
          "company-1",
          (updated.adapterConfig as Record<string, unknown> | undefined) ?? {},
        );
        const snapshot = await mockAdapter.syncSkills({
          agentId: String(agent.id),
          companyId: "company-1",
          adapterType,
          config: {
            ...config,
            paperclipRuntimeSkills: runtimeSkillEntries,
          },
        }, desiredSkills);
        return { ...snapshot, canManage: true };
      },
    );
    mockAgentSkillService.resolveDesiredSkillAssignment.mockImplementation(
      async (
        companyId: string,
        _adapterType: string,
        adapterConfig: Record<string, unknown>,
        requestedDesiredSkills: string[] | undefined,
      ) => {
        if (!requestedDesiredSkills) {
          return {
            adapterConfig,
            desiredSkills: null,
            runtimeSkillEntries: null,
          };
        }
        const resolvedRequestedSkills = await mockCompanySkillService.resolveRequestedSkillKeys(
          companyId,
          requestedDesiredSkills,
        );
        return {
          adapterConfig: {
            ...adapterConfig,
            paperclipSkillSync: {
              desiredSkills: resolvedRequestedSkills,
            },
          },
          desiredSkills: resolvedRequestedSkills,
          runtimeSkillEntries: null,
        };
      },
    );
    mockAgentService.create.mockImplementation(async (_companyId: string, input: Record<string, unknown>) => ({
      ...makeAgent(String(input.adapterType ?? "claude_local")),
      ...input,
      adapterConfig: input.adapterConfig ?? {},
      runtimeConfig: input.runtimeConfig ?? {},
      budgetMonthlyCents: Number(input.budgetMonthlyCents ?? 0),
      permissions: null,
    }));
    mockApprovalService.create.mockImplementation(async (_companyId: string, input: Record<string, unknown>) => ({
      id: "approval-1",
      companyId: "company-1",
      type: "hire_agent",
      status: "pending",
      payload: input.payload ?? {},
    }));
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
    mockLogActivity.mockResolvedValue(undefined);
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockAccessService.getMembership.mockResolvedValue(null);
    mockAccessService.listPrincipalGrants.mockResolvedValue([]);
    mockAccessService.ensureMembership.mockResolvedValue(undefined);
    mockAccessService.setPrincipalPermission.mockResolvedValue(undefined);
  });

  it("skips runtime materialization when listing Claude skills", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent("claude_local"));

    const res = await request(await createApp())
      .get("/api/agents/11111111-1111-4111-8111-111111111111/skills?companyId=company-1");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockCompanySkillService.listRuntimeSkillEntries).toHaveBeenCalledWith("company-1", {
      materializeMissing: false,
    });
    expect(mockAdapter.listSkills).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterType: "claude_local",
        config: expect.objectContaining({
          paperclipRuntimeSkills: expect.any(Array),
        }),
      }),
    );
    expect(res.body.canManage).toBe(true);
  }, 10_000);

  it("skips runtime materialization when listing Codex skills", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent("codex_local"));
    mockAdapter.listSkills.mockResolvedValue({
      adapterType: "codex_local",
      supported: true,
      mode: "ephemeral",
      desiredSkills: ["paperclipai/paperclip/paperclip"],
      entries: [],
      warnings: [],
    });

    const res = await request(await createApp())
      .get("/api/agents/11111111-1111-4111-8111-111111111111/skills?companyId=company-1");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockCompanySkillService.listRuntimeSkillEntries).toHaveBeenCalledWith("company-1", {
      materializeMissing: false,
    });
  });

  it("keeps runtime materialization for persistent skill adapters", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent("cursor"));
    mockAdapter.listSkills.mockResolvedValue({
      adapterType: "cursor",
      supported: true,
      mode: "persistent",
      desiredSkills: ["paperclipai/paperclip/paperclip"],
      entries: [],
      warnings: [],
    });

    const res = await request(await createApp())
      .get("/api/agents/11111111-1111-4111-8111-111111111111/skills?companyId=company-1");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockCompanySkillService.listRuntimeSkillEntries).toHaveBeenCalledWith("company-1", {
      materializeMissing: true,
    });
    expect(res.body.canManage).toBe(true);
  });

  it("skips runtime materialization when syncing Claude skills", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent("claude_local"));

    const res = await request(await createApp())
      .post("/api/agents/11111111-1111-4111-8111-111111111111/skills/sync?companyId=company-1")
      .send({ desiredSkills: ["paperclipai/paperclip/paperclip"] });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockCompanySkillService.listRuntimeSkillEntries).toHaveBeenCalledWith("company-1", {
      materializeMissing: false,
    });
    expect(mockAdapter.syncSkills).toHaveBeenCalled();
    expect(res.body.canManage).toBe(true);
  });

  it("canonicalizes desired skill references before syncing", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent("claude_local"));

    const res = await request(await createApp())
      .post("/api/agents/11111111-1111-4111-8111-111111111111/skills/sync?companyId=company-1")
      .send({ desiredSkills: ["paperclip"] });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockCompanySkillService.resolveRequestedSkillKeys).toHaveBeenCalledWith("company-1", ["paperclip"]);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        adapterConfig: expect.objectContaining({
          paperclipSkillSync: expect.objectContaining({
            desiredSkills: ["paperclipai/paperclip/paperclip"],
          }),
        }),
      }),
    );
  });

  it("returns a read-only snapshot for agent actors", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent("claude_local"));

    const res = await request(
      await createApp(createDb(), {
        type: "agent",
        agentId: "11111111-1111-4111-8111-111111111111",
        companyId: "company-1",
        runId: null,
      }),
    ).get("/api/agents/11111111-1111-4111-8111-111111111111/skills?companyId=company-1");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(Boolean(res.body.canManage)).toBe(false);
  });

  it("rejects skill sync from agent actors even when they target themselves", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent("claude_local"));

    const res = await request(
      await createApp(createDb(), {
        type: "agent",
        agentId: "11111111-1111-4111-8111-111111111111",
        companyId: "company-1",
        runId: null,
      }),
    )
      .post("/api/agents/11111111-1111-4111-8111-111111111111/skills/sync?companyId=company-1")
      .send({ desiredSkills: ["paperclipai/paperclip/paperclip"] });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain("Board access required");
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("persists canonical desired skills when creating an agent directly", async () => {
    const res = await request(await createApp())
      .post("/api/companies/company-1/agents")
      .send({
        name: "QA Agent",
        role: "engineer",
        adapterType: "claude_local",
        desiredSkills: ["paperclip"],
        adapterConfig: {},
      });

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    expect(mockCompanySkillService.resolveRequestedSkillKeys).toHaveBeenCalledWith("company-1", ["paperclip"]);
    expect(mockAgentService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        adapterConfig: expect.objectContaining({
          paperclipSkillSync: expect.objectContaining({
            desiredSkills: ["paperclipai/paperclip/paperclip"],
          }),
        }),
      }),
    );
    expect(mockTrackAgentCreated).toHaveBeenCalledWith(expect.anything(), {
      agentRole: "engineer",
    });
  });

  it("adds default template skill packs when creating a template-backed agent", async () => {
    mockAgentTemplateService.resolveRevisionForInstantiation.mockResolvedValue(
      makeTemplateResolution(),
    );

    const res = await request(await createApp())
      .post("/api/companies/company-1/agents")
      .send({
        name: "Frontend Owner",
        templateId: "22222222-2222-4222-8222-222222222222",
        adapterType: "claude_local",
        desiredSkills: ["company/company-1/custom-skill"],
        adapterConfig: {},
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockAgentSkillService.resolveDesiredSkillAssignment).toHaveBeenCalledWith(
      "company-1",
      "claude_local",
      {},
      expect.arrayContaining([
        "company/company-1/custom-skill",
        "impeccable",
        "shape",
        "playwright-interactive",
      ]),
    );
  });

  it("materializes a managed AGENTS.md for directly created local agents", async () => {
    const res = await request(await createApp())
      .post("/api/companies/company-1/agents")
      .send({
        name: "QA Agent",
        role: "engineer",
        adapterType: "claude_local",
        adapterConfig: {
          promptTemplate: "You are QA.",
        },
      });

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    expect(mockAgentInstructionsService.materializeManagedBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "11111111-1111-4111-8111-111111111111",
        adapterType: "claude_local",
      }),
      expect.objectContaining({
        "AGENTS.md": "You are QA.",
        "MEMORY.md": expect.stringContaining("# MEMORY.md"),
      }),
      expect.objectContaining({
        entryFile: "AGENTS.md",
        replaceExisting: false,
        bundleRole: "default",
        rootPolicy: "managed_only",
        memoryOwnership: "agent_authored",
      }),
    );
    expect(mockAgentService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        adapterConfig: expect.objectContaining({
          instructionsBundleMode: "managed",
          instructionsEntryFile: "AGENTS.md",
          instructionsFilePath: "/tmp/11111111-1111-4111-8111-111111111111/instructions/AGENTS.md",
        }),
      }),
    );
    expect(mockAgentService.update.mock.calls.at(-1)?.[1]).not.toMatchObject({
      adapterConfig: expect.objectContaining({
        promptTemplate: expect.anything(),
      }),
    });
  });

  it("materializes the bundled CEO instruction set for default CEO agents", async () => {
    const res = await request(await createApp())
      .post("/api/companies/company-1/agents")
      .send({
        name: "CEO",
        role: "ceo",
        adapterType: "claude_local",
        adapterConfig: {},
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockAgentInstructionsService.materializeManagedBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "11111111-1111-4111-8111-111111111111",
        role: "ceo",
        adapterType: "claude_local",
      }),
      expect.objectContaining({
        "AGENTS.md": expect.stringContaining("You are the CEO."),
        "MEMORY.md": expect.stringContaining("# MEMORY.md"),
        "HEARTBEAT.md": expect.stringContaining("CEO Delta"),
        "SOUL.md": expect.stringContaining("CEO Persona"),
        "TOOLS.md": expect.stringContaining("# Tools"),
      }),
      expect.objectContaining({
        entryFile: "AGENTS.md",
        replaceExisting: false,
        bundleRole: "ceo",
        rootPolicy: "managed_only",
        memoryOwnership: "agent_authored",
      }),
    );
  });

  it("materializes the bundled default instruction set for non-CEO agents with no prompt template", async () => {
    const res = await request(await createApp())
      .post("/api/companies/company-1/agents")
      .send({
        name: "Engineer",
        role: "engineer",
        adapterType: "claude_local",
        adapterConfig: {},
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockAgentInstructionsService.materializeManagedBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "11111111-1111-4111-8111-111111111111",
        role: "engineer",
        adapterType: "claude_local",
      }),
      expect.objectContaining({
        "AGENTS.md": expect.stringContaining("Keep the work moving until it's done."),
        "MEMORY.md": expect.stringContaining("# MEMORY.md"),
      }),
      expect.objectContaining({
        entryFile: "AGENTS.md",
        replaceExisting: false,
        bundleRole: "default",
        rootPolicy: "managed_only",
        memoryOwnership: "agent_authored",
      }),
    );
  });

  it("includes canonical desired skills in hire approvals", async () => {
    const db = createDb(true);

    const res = await request(await createApp(db))
      .post("/api/companies/company-1/agent-hires")
      .send({
        name: "QA Agent",
        role: "engineer",
        adapterType: "claude_local",
        desiredSkills: ["paperclip"],
        adapterConfig: {},
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockCompanySkillService.resolveRequestedSkillKeys).toHaveBeenCalledWith("company-1", ["paperclip"]);
    expect(mockApprovalService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        payload: expect.objectContaining({
          desiredSkills: ["paperclipai/paperclip/paperclip"],
          requestedConfigurationSnapshot: expect.objectContaining({
            desiredSkills: ["paperclipai/paperclip/paperclip"],
          }),
        }),
      }),
    );
  });

  it("adds default template skill packs when creating a template-backed hire", async () => {
    mockAgentTemplateService.resolveRevisionForInstantiation.mockResolvedValue(
      makeTemplateResolution({
        role: "qa",
        operatingClass: "consultant",
        capabilityProfileKey: "consultant",
        archetypeKey: "audit_reviewer",
        title: "Audit Reviewer",
        departmentKey: "operations",
        departmentName: "Operations",
      }),
    );

    const res = await request(await createApp(createDb(true)))
      .post("/api/companies/company-1/agent-hires")
      .send({
        name: "Audit Reviewer",
        templateId: "22222222-2222-4222-8222-222222222222",
        adapterType: "claude_local",
        adapterConfig: {},
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockAgentSkillService.resolveDesiredSkillAssignment).toHaveBeenCalledWith(
      "company-1",
      "claude_local",
      {},
      expect.arrayContaining([
        "audit",
        "critique",
        "security-best-practices",
        "qa-only",
        "playwright",
      ]),
    );
  });

  it("uses managed AGENTS config in hire approval payloads", async () => {
    const res = await request(await createApp(createDb(true)))
      .post("/api/companies/company-1/agent-hires")
      .send({
        name: "QA Agent",
        role: "engineer",
        adapterType: "claude_local",
        adapterConfig: {
          promptTemplate: "You are QA.",
        },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockApprovalService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        payload: expect.objectContaining({
          adapterConfig: expect.objectContaining({
            instructionsBundleMode: "managed",
            instructionsEntryFile: "AGENTS.md",
            instructionsFilePath: "/tmp/11111111-1111-4111-8111-111111111111/instructions/AGENTS.md",
          }),
        }),
      }),
    );
    const approvalInput = mockApprovalService.create.mock.calls.at(-1)?.[1] as
      | { payload?: { adapterConfig?: Record<string, unknown> } }
      | undefined;
    expect(approvalInput?.payload?.adapterConfig?.promptTemplate).toBeUndefined();
  });

  it("creates and adopts a chief-of-staff office operator, then reparents project leads", async () => {
    const ceoInstructionsRoot = `/tmp/company-1/agents/${ceoId}/instructions`;
    mockAgentService.list.mockResolvedValue([
      makeAgent("claude_local", {
        id: ceoId,
        name: "CEO",
        role: "ceo",
        archetypeKey: "ceo",
        operatingClass: "executive",
        reportsTo: null,
        status: "active",
        adapterConfig: {
          model: "claude-opus-4-7",
          instructionsBundleMode: "managed",
          instructionsBundleRole: "ceo",
          instructionsRootPath: ceoInstructionsRoot,
          instructionsEntryFile: "AGENTS.md",
          instructionsFilePath: `${ceoInstructionsRoot}/AGENTS.md`,
        },
      }),
      makeAgent("claude_local", {
        id: projectLeadId,
        name: "Project Lead",
        role: "engineer",
        archetypeKey: "project_lead",
        operatingClass: "project_leadership",
        reportsTo: ceoId,
        status: "active",
      }),
    ]);
    mockAgentTemplateService.resolveRevisionForInstantiation.mockResolvedValue(
      makeTemplateResolution({
        name: "Chief of Staff",
        role: "coo",
        title: "Chief of Staff",
        orgLevel: "executive",
        operatingClass: "executive",
        capabilityProfileKey: "executive_operator",
        archetypeKey: "chief_of_staff",
        departmentKey: "operations",
        departmentName: "Operations",
        instructionsBody: "You are the Chief of Staff.",
      }),
    );

    const res = await request(await createApp())
      .post("/api/companies/company-1/office-operator-adoption")
      .send({ reparentProjectLeads: true, seedFromAgentId: ceoId });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockAgentService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        role: "coo",
        archetypeKey: "chief_of_staff",
        reportsTo: ceoId,
        adapterConfig: expect.not.objectContaining({
          instructionsRootPath: ceoInstructionsRoot,
          instructionsFilePath: `${ceoInstructionsRoot}/AGENTS.md`,
        }),
      }),
    );
    expect(mockAgentInstructionsService.materializeManagedBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "coo",
        adapterConfig: expect.not.objectContaining({
          instructionsRootPath: ceoInstructionsRoot,
          instructionsFilePath: `${ceoInstructionsRoot}/AGENTS.md`,
        }),
      }),
      expect.objectContaining({
        "AGENTS.md": "You are the Chief of Staff.",
        "MEMORY.md": expect.any(String),
        "HEARTBEAT.md": expect.any(String),
      }),
      expect.objectContaining({
        bundleRole: "manager",
        memoryOwnership: "agent_authored",
      }),
    );
    expect(mockAgentService.update).toHaveBeenCalledWith(projectLeadId, { reportsTo: expect.any(String) });
    expect(res.body.created).toBe(true);
    expect(res.body.reparentedProjectLeadIds).toContain(projectLeadId);
  });
});
