import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  getRunIssueSummary: vi.fn(),
  getActiveRunIssueSummaryForAgent: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
}));

const mockAgentTemplateService = vi.hoisted(() => ({
  resolveRevisionForInstantiation: vi.fn(),
}));

function registerRouteMocks() {
  vi.doMock("../services/index.js", () => ({
    agentService: () => mockAgentService,
    agentTemplateService: () => mockAgentTemplateService,
    agentSkillService: () => ({}),
    agentInstructionsService: () => ({}),
    accessService: () => ({}),
    approvalService: () => ({}),
    budgetService: () => ({}),
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => ({}),
    issueService: () => mockIssueService,
    logActivity: vi.fn(),
    secretService: () => ({}),
    syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
    workspaceOperationService: () => ({}),
  }));

  vi.doMock("../adapters/index.js", () => ({
    findServerAdapter: vi.fn(),
    listAdapterModels: vi.fn(),
    detectAdapterModel: vi.fn(),
    findActiveServerAdapter: vi.fn(),
    requireServerAdapter: vi.fn(),
  }));
}

async function createApp() {
  const [{ agentRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/agents.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", agentRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("agent live run routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unmock("../services/index.js");
    vi.unmock("../adapters/index.js");
    registerRouteMocks();
    vi.clearAllMocks();
    mockAgentTemplateService.resolveRevisionForInstantiation.mockResolvedValue(null);
    mockIssueService.getByIdentifier.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      executionRunId: "run-1",
      assigneeAgentId: "agent-1",
      status: "in_progress",
    });
    mockIssueService.getById.mockResolvedValue(null);
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      name: "Builder",
      adapterType: "codex_local",
    });
    mockHeartbeatService.getRunIssueSummary.mockResolvedValue({
      id: "run-1",
      status: "running",
      invocationSource: "on_demand",
      triggerDetail: "manual",
      startedAt: new Date("2026-04-10T09:30:00.000Z"),
      finishedAt: null,
      createdAt: new Date("2026-04-10T09:29:59.000Z"),
      agentId: "agent-1",
      issueId: "issue-1",
    });
    mockHeartbeatService.getActiveRunIssueSummaryForAgent.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.unmock("../services/index.js");
    vi.unmock("../adapters/index.js");
  });

  it("returns a compact active run payload for issue polling", async () => {
    const res = await request(await createApp()).get("/api/issues/PAP-1295/active-run");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockIssueService.getByIdentifier).toHaveBeenCalledWith("PAP-1295");
    expect(mockHeartbeatService.getRunIssueSummary).toHaveBeenCalledWith("run-1");
    expect(res.body).toEqual({
      id: "run-1",
      status: "running",
      invocationSource: "on_demand",
      triggerDetail: "manual",
      startedAt: "2026-04-10T09:30:00.000Z",
      finishedAt: null,
      createdAt: "2026-04-10T09:29:59.000Z",
      agentId: "agent-1",
      issueId: "issue-1",
      agentName: "Builder",
      adapterType: "codex_local",
    });
    expect(res.body).not.toHaveProperty("resultJson");
    expect(res.body).not.toHaveProperty("contextSnapshot");
    expect(res.body).not.toHaveProperty("logRef");
  });
});
