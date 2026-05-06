import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  getRunIssueSummary: vi.fn(),
  getActiveRunIssueSummaryForAgent: vi.fn(),
  getRunLogAccess: vi.fn(),
  readLog: vi.fn(),
  wakeup: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
  list: vi.fn(),
  listDependencyReadiness: vi.fn(),
  listBlockerWaitingOnInfo: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentProjectPlacementService: () => ({}),
  agentInstructionsService: () => ({}),
  agentSkillService: () => ({}),
  agentTemplateService: () => ({}),
  accessService: () => ({}),
  approvalService: () => ({}),
  companySkillService: () => ({ listRuntimeSkillEntries: vi.fn() }),
  budgetService: () => ({}),
  environmentService: () => ({ getById: vi.fn() }),
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  logActivity: vi.fn(),
  secretService: () => ({}),
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
  workspaceOperationService: () => ({}),
}));

vi.mock("../adapters/index.js", () => ({
  findServerAdapter: vi.fn(),
  listAdapterModels: vi.fn(),
  detectAdapterModel: vi.fn(),
  findActiveServerAdapter: vi.fn(),
  requireServerAdapter: vi.fn(),
}));

function createApp(
  actor: Record<string, unknown> = {
    type: "board",
    userId: "local-board",
    companyIds: ["company-1"],
    source: "local_implicit",
    isInstanceAdmin: false,
  },
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", agentRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("agent live run routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getByIdentifier.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      executionRunId: "run-1",
      assigneeAgentId: "agent-1",
      status: "in_progress",
    });
    mockIssueService.getById.mockResolvedValue(null);
    mockIssueService.list.mockResolvedValue([]);
    mockIssueService.listDependencyReadiness.mockResolvedValue(new Map());
    mockIssueService.listBlockerWaitingOnInfo.mockResolvedValue(new Map());
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
      contextCommentId: "comment-1",
      contextWakeCommentId: "comment-1",
      startedAt: new Date("2026-04-10T09:30:00.000Z"),
      finishedAt: null,
      createdAt: new Date("2026-04-10T09:29:59.000Z"),
      agentId: "agent-1",
      issueId: "issue-1",
    });
    mockHeartbeatService.getActiveRunIssueSummaryForAgent.mockResolvedValue(null);
    mockHeartbeatService.getRunLogAccess.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      logStore: "local_file",
      logRef: "logs/run-1.ndjson",
    });
    mockHeartbeatService.readLog.mockResolvedValue({
      runId: "run-1",
      store: "local_file",
      logRef: "logs/run-1.ndjson",
      content: "chunk",
      nextOffset: 5,
    });
    mockHeartbeatService.wakeup.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      agentId: "agent-1",
      status: "queued",
      invocationSource: "on_demand",
      triggerDetail: "manual",
    });
  });

  it("returns a compact active run payload for issue polling", async () => {
    const res = await request(createApp()).get("/api/issues/pc1a2-1295/active-run");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockIssueService.getByIdentifier).toHaveBeenCalledWith("PC1A2-1295");
    expect(mockHeartbeatService.getRunIssueSummary).toHaveBeenCalledWith("run-1");
    expect(res.body).toEqual({
      id: "run-1",
      status: "running",
      invocationSource: "on_demand",
      triggerDetail: "manual",
      contextCommentId: "comment-1",
      contextWakeCommentId: "comment-1",
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
  }, 10_000);

  it("ignores a stale execution run from another issue and falls back to the assignee's matching run", async () => {
    mockHeartbeatService.getRunIssueSummary.mockResolvedValue({
      id: "run-foreign",
      status: "running",
      invocationSource: "assignment",
      triggerDetail: "callback",
      startedAt: new Date("2026-04-10T10:00:00.000Z"),
      finishedAt: null,
      createdAt: new Date("2026-04-10T09:59:00.000Z"),
      agentId: "agent-1",
      issueId: "issue-2",
    });
    mockHeartbeatService.getActiveRunIssueSummaryForAgent.mockResolvedValue({
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

    const res = await request(createApp()).get("/api/issues/PC1A2-1295/active-run");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockHeartbeatService.getRunIssueSummary).toHaveBeenCalledWith("run-1");
    expect(mockHeartbeatService.getActiveRunIssueSummaryForAgent).toHaveBeenCalledWith("agent-1");
    expect(res.body).toMatchObject({
      id: "run-1",
      issueId: "issue-1",
      agentId: "agent-1",
      agentName: "Builder",
      adapterType: "codex_local",
    });
  });

  it("includes routine-execution issues in agent inbox lite", async () => {
    mockIssueService.list.mockResolvedValue([
      {
        id: "issue-1",
        identifier: "PAP-1295",
        title: "Keep routine execution visible",
        status: "in_progress",
        priority: "medium",
        projectId: "project-1",
        goalId: null,
        parentId: null,
        updatedAt: new Date("2026-04-10T09:30:00.000Z"),
        activeRun: null,
      },
    ]);

    const res = await request(
      createApp({
        type: "agent",
        agentId: "agent-1",
        companyId: "company-1",
        source: "agent_api_key",
      }),
    ).get("/api/agents/me/inbox-lite");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockIssueService.list).toHaveBeenCalledWith("company-1", {
      assigneeAgentId: "agent-1",
      includeRoutineExecutions: true,
      status: "todo,in_progress,blocked",
    });
    expect(res.body).toEqual([
      {
        id: "issue-1",
        identifier: "PAP-1295",
        title: "Keep routine execution visible",
        status: "in_progress",
        priority: "medium",
        projectId: "project-1",
        goalId: null,
        parentId: null,
        updatedAt: "2026-04-10T09:30:00.000Z",
        activeRun: null,
        dependencyReady: true,
        unresolvedBlockerCount: 0,
        unresolvedBlockerIssueIds: [],
        operatorState: "idle_active",
        operatorReason: "Issue is active but no agent run is queued or running.",
        computedAgentState: "idle",
        waitingOn: null,
      },
    ]);
  });

  it("surfaces waitingOn details for dependency-blocked inbox rows", async () => {
    mockIssueService.list.mockResolvedValue([
      {
        id: "issue-parent",
        identifier: "AIW-5",
        title: "Parent stuck on blocker",
        status: "blocked",
        priority: "high",
        projectId: "project-1",
        goalId: null,
        parentId: null,
        updatedAt: new Date("2026-04-22T09:30:00.000Z"),
        activeRun: null,
      },
    ]);
    mockIssueService.listDependencyReadiness.mockResolvedValue(
      new Map([[
        "issue-parent",
        {
          isDependencyReady: false,
          unresolvedBlockerCount: 1,
          unresolvedBlockerIssueIds: ["issue-blocker"],
        },
      ]]),
    );
    mockIssueService.listBlockerWaitingOnInfo.mockResolvedValue(
      new Map([["issue-blocker", { identifier: "AIW-9", openChildCount: 2 }]]),
    );

    const res = await request(
      createApp({
        type: "agent",
        agentId: "agent-1",
        companyId: "company-1",
        source: "agent_api_key",
      }),
    ).get("/api/agents/me/inbox-lite");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockIssueService.listBlockerWaitingOnInfo).toHaveBeenCalledWith("company-1", ["issue-blocker"]);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      identifier: "AIW-5",
      computedAgentState: "dependency_blocked",
      operatorState: "dependency_blocked",
      waitingOn: {
        issueId: "issue-blocker",
        identifier: "AIW-9",
        openChildCount: 2,
        nextWakeReason: "issue_blockers_resolved",
      },
    });
  });

  it("passes scoped wake fields through the legacy heartbeat invoke route", async () => {
    const res = await request(createApp())
      .post("/api/agents/agent-1/heartbeat/invoke?companyId=company-1")
      .send({
        reason: "issue_assigned",
        payload: {
          issueId: "issue-1",
          taskId: "issue-1",
          taskKey: "issue-1",
        },
        forceFreshSession: true,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(202);
    // The legacy /heartbeat/invoke endpoint forwards only the wake fields the
    // caller actually supplied so empty-body callers (e.g. e2e suites) match
    // the original fixed-arg `heartbeat.invoke()` shape exactly. When the
    // caller supplies reason / payload / forceFreshSession those are
    // forwarded; idempotencyKey is omitted unless explicitly set.
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith("agent-1", {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "issue_assigned",
      payload: {
        issueId: "issue-1",
        taskId: "issue-1",
        taskKey: "issue-1",
      },
      requestedByActorType: "user",
      requestedByActorId: "local-board",
      contextSnapshot: {
        triggeredBy: "board",
        actorId: "local-board",
        forceFreshSession: true,
      },
    });
  });

  it("calls heartbeat.wakeup with the legacy minimal shape when the body is empty", async () => {
    const res = await request(createApp())
      .post("/api/agents/agent-1/heartbeat/invoke?companyId=company-1")
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith("agent-1", {
      source: "on_demand",
      triggerDetail: "manual",
      requestedByActorType: "user",
      requestedByActorId: "local-board",
      contextSnapshot: {
        triggeredBy: "board",
        actorId: "local-board",
      },
    });
  });
});
