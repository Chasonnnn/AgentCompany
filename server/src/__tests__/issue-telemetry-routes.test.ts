import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  update: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockTrackAgentTaskCompleted = vi.hoisted(() => vi.fn());
const mockGetTelemetryClient = vi.hoisted(() => vi.fn());

function makeIssue(status: "todo" | "done") {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    status,
    assigneeAgentId: "agent-1",
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "PAP-1018",
    title: "Telemetry test",
  };
}

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use(
    "/api",
    issueRoutes({} as any, {} as any, {
      services: {
        accessService: {
          canUser: vi.fn(),
          hasPermission: vi.fn(),
        } as any,
        agentService: mockAgentService as any,
        documentService: {} as any,
        executionWorkspaceService: {} as any,
        feedbackService: {} as any,
        goalService: {} as any,
        heartbeatService: {
          wakeup: vi.fn(async () => undefined),
          reportRunActivity: vi.fn(async () => undefined),
        } as any,
        instanceSettingsService: {} as any,
        issueApprovalService: {} as any,
        issueContinuityService: {
          recomputeIssueContinuityState: vi.fn(async () => ({
            tier: "normal",
            status: "draft",
            health: "healthy",
            requiredDocumentKeys: [],
            missingDocumentKeys: [],
            specState: "editable",
            branchRole: "none",
            branchStatus: "none",
            unresolvedBranchIssueIds: [],
            lastProgressAt: null,
            lastHandoffAt: null,
            lastPreparedAt: null,
            lastBundleHash: null,
          })),
        } as any,
        issueService: mockIssueService as any,
        logActivity: vi.fn(async () => undefined) as any,
        projectService: {} as any,
        routineService: {
          syncRunStatusForIssue: vi.fn(async () => undefined),
        } as any,
        workProductService: {} as any,
      },
      telemetry: {
        getTelemetryClient: mockGetTelemetryClient as any,
        trackAgentTaskCompleted: mockTrackAgentTaskCompleted as any,
      },
    }),
  );
  app.use(errorHandler);
  return app;
}

describe("issue telemetry routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGetTelemetryClient.mockReturnValue({ track: vi.fn() });
    mockIssueService.getById.mockResolvedValue(makeIssue("todo"));
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue("todo"),
      ...patch,
    }));
  });

  it("emits task-completed telemetry with the agent role", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      role: "engineer",
      adapterType: "codex_local",
    });

    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: null,
    });
    const res = await request(app)
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done" });

    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockTrackAgentTaskCompleted).toHaveBeenCalledWith(expect.anything(), {
        agentRole: "engineer",
      });
    });
  }, 10_000);

  it("does not emit agent task-completed telemetry for board-driven completions", async () => {
    const app = createApp({
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    });
    const res = await request(app)
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done" });

    expect(res.status).toBe(200);
    expect(mockTrackAgentTaskCompleted).not.toHaveBeenCalled();
    expect(mockAgentService.getById).not.toHaveBeenCalled();
  });
});
