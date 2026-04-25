import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ISSUE_ID = "11111111-1111-4111-8111-111111111111";
const ASSIGNEE_AGENT_ID = "22222222-2222-4222-8222-222222222222";
const TERMINATED_AGENT_ID = "33333333-3333-4333-8333-333333333333";
const LIVE_MENTION_AGENT_ID = "44444444-4444-4444-8444-444444444444";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  getComment: vi.fn(),
  removeComment: vi.fn(),
  resolveMentionedAgents: vi.fn(),
  findMentionedAgents: vi.fn(),
  getAgentStatusById: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(async () => false),
  hasPermission: vi.fn(async () => false),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(async () => null),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

const mockTxInsertValues = vi.hoisted(() => vi.fn(async () => undefined));
const mockTxInsert = vi.hoisted(() => vi.fn(() => ({ values: mockTxInsertValues })));
const mockTx = vi.hoisted(() => ({
  insert: mockTxInsert,
}));
const mockDb = vi.hoisted(() => ({
  transaction: vi.fn(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx)),
}));

vi.mock("@paperclipai/shared/telemetry", () => ({
  trackAgentTaskCompleted: vi.fn(),
  trackErrorHandlerCrash: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  documentService: () => ({
    getIssueDocumentByKey: vi.fn(async () => null),
  }),
  executionWorkspaceService: () => ({}),
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(async () => []),
    saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
  }),
  goalService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => ({
    get: vi.fn(async () => ({
      id: "instance-settings-1",
      general: {
        censorUsernameInLogs: false,
        feedbackDataSharingPreference: "prompt",
      },
    })),
    listCompanyIds: vi.fn(async () => ["company-1"]),
  }),
  issueApprovalService: () => ({}),
  issueContinuityService: () => ({
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
  }),
  issueReferenceService: () => ({
    syncIssue: vi.fn(async () => undefined),
    syncComment: vi.fn(async () => undefined),
    syncDocument: vi.fn(async () => undefined),
    deleteDocumentSource: vi.fn(async () => undefined),
    listIssueReferenceSummary: vi.fn(async () => ({ outbound: [], inbound: [] })),
    diffIssueReferenceSummary: vi.fn(() => ({
      addedReferencedIssues: [],
      removedReferencedIssues: [],
      currentReferencedIssues: [],
    })),
    emptySummary: vi.fn(() => ({ outbound: [], inbound: [] })),
  }),
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  officeCoordinationService: () => ({
    findOfficeOperator: vi.fn(async () => null),
    buildWakeSnapshot: vi.fn(async () => null),
    isOfficeOperatorAgent: vi.fn(async () => false),
  }),
  projectService: () => ({}),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({}),
}));

function createApp() {
  const app = express();
  app.use(express.json());
  return app;
}

async function installActor(app: express.Express) {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/issues.js"),
    import("../middleware/index.js"),
  ]);
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
  app.use("/api", issueRoutes(mockDb as any, {} as any));
  app.use(errorHandler);
  return app;
}

function makeIssue() {
  return {
    id: ISSUE_ID,
    companyId: "company-1",
    status: "todo",
    assigneeAgentId: ASSIGNEE_AGENT_ID,
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "PAP-157",
    title: "Mention filter",
  };
}

function commentRow() {
  return {
    id: "comment-1",
    issueId: ISSUE_ID,
    companyId: "company-1",
    body: "test body",
    createdAt: new Date(),
    updatedAt: new Date(),
    authorAgentId: null,
    authorUserId: "local-board",
  };
}

describe("issue comment mention — terminated agents", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockHeartbeatService.wakeup.mockResolvedValue(undefined);
    mockHeartbeatService.reportRunActivity.mockResolvedValue(undefined);
    mockHeartbeatService.getRun.mockResolvedValue(null);
    mockHeartbeatService.getActiveRunForAgent.mockResolvedValue(null);
    mockHeartbeatService.cancelRun.mockResolvedValue(null);
    mockLogActivity.mockResolvedValue(undefined);
    mockIssueService.addComment.mockResolvedValue(commentRow());
    mockIssueService.removeComment.mockResolvedValue(commentRow());
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getAgentStatusById.mockResolvedValue("idle");
    mockAccessService.canUser.mockResolvedValue(false);
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockAgentService.getById.mockResolvedValue(null);
  });

  it("returns droppedMentions.terminated in the 201 body and emits issue.mention_dropped_terminated activity", async () => {
    mockIssueService.resolveMentionedAgents.mockResolvedValue({
      agentIds: [],
      ambiguousTokens: [],
      droppedMentions: {
        terminated: [
          { token: "dead-beta", agentId: TERMINATED_AGENT_ID, name: "dead-beta" },
        ],
      },
    });

    const res = await request(await installActor(createApp()))
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: "ping @dead-beta" });

    expect(res.status).toBe(201);
    expect(res.body.droppedMentions).toEqual({
      terminated: [{ token: "dead-beta", agentId: TERMINATED_AGENT_ID, name: "dead-beta" }],
    });

    // Activity log: one for issue.comment_added + one for issue.mention_dropped_terminated
    const actions = mockLogActivity.mock.calls.map((call) => call[1]?.action);
    expect(actions).toContain("issue.comment_added");
    expect(actions).toContain("issue.mention_dropped_terminated");
    const droppedCall = mockLogActivity.mock.calls.find(
      (call) => call[1]?.action === "issue.mention_dropped_terminated",
    );
    expect(droppedCall?.[1]?.details).toMatchObject({
      commentId: "comment-1",
      droppedMentions: {
        terminated: [{ token: "dead-beta", agentId: TERMINATED_AGENT_ID, name: "dead-beta" }],
      },
    });

    // No wake should fire against the terminated mention; assignee gets one wake.
    await new Promise((resolve) => setImmediate(resolve));
    const wakeCalls = mockHeartbeatService.wakeup.mock.calls.map((call) => call[0]);
    expect(wakeCalls).not.toContain(TERMINATED_AGENT_ID);
  });

  it("does not wake a terminated assignee on a new comment, and emits no wake-failure warn", async () => {
    mockIssueService.resolveMentionedAgents.mockResolvedValue({
      agentIds: [],
      ambiguousTokens: [],
      droppedMentions: { terminated: [] },
    });
    mockIssueService.getAgentStatusById.mockResolvedValue("terminated");

    const res = await request(await installActor(createApp()))
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: "any body, no mentions" });

    expect(res.status).toBe(201);
    expect(res.body.droppedMentions).toEqual({ terminated: [] });

    await new Promise((resolve) => setImmediate(resolve));
    // The terminated assignee must NOT get a wake.
    const wakeAgentIds = mockHeartbeatService.wakeup.mock.calls.map((call) => call[0]);
    expect(wakeAgentIds).not.toContain(ASSIGNEE_AGENT_ID);
    // Status was checked at wake time.
    expect(mockIssueService.getAgentStatusById).toHaveBeenCalledWith(ASSIGNEE_AGENT_ID);
  });

  it("still wakes a live assignee and live mention while signalling the terminated drop", async () => {
    mockIssueService.resolveMentionedAgents.mockResolvedValue({
      agentIds: [LIVE_MENTION_AGENT_ID],
      ambiguousTokens: [],
      droppedMentions: {
        terminated: [{ token: "dead-delta", agentId: TERMINATED_AGENT_ID, name: "dead-delta" }],
      },
    });

    const res = await request(await installActor(createApp()))
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: "@live-charlie and @dead-delta" });

    expect(res.status).toBe(201);
    expect(res.body.droppedMentions).toEqual({
      terminated: [{ token: "dead-delta", agentId: TERMINATED_AGENT_ID, name: "dead-delta" }],
    });

    await new Promise((resolve) => setImmediate(resolve));
    const wakeAgentIds = mockHeartbeatService.wakeup.mock.calls.map((call) => call[0]);
    expect(wakeAgentIds).toContain(LIVE_MENTION_AGENT_ID);
    expect(wakeAgentIds).toContain(ASSIGNEE_AGENT_ID);
    expect(wakeAgentIds).not.toContain(TERMINATED_AGENT_ID);
  });

  it("returns empty droppedMentions when no mentions are dropped (regression baseline)", async () => {
    mockIssueService.resolveMentionedAgents.mockResolvedValue({
      agentIds: [],
      ambiguousTokens: [],
      droppedMentions: { terminated: [] },
    });

    const res = await request(await installActor(createApp()))
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: "no mentions" });

    expect(res.status).toBe(201);
    expect(res.body.droppedMentions).toEqual({ terminated: [] });
    const actions = mockLogActivity.mock.calls.map((call) => call[1]?.action);
    expect(actions).not.toContain("issue.mention_dropped_terminated");
  });

  it("PATCH /issues/:id comment branch: drops terminated mention + assignee wakes, emits activity, no phantom wake", async () => {
    const existing = { ...makeIssue(), status: "in_progress" };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(existing);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-patch-1",
      issueId: existing.id,
      companyId: existing.companyId,
      body: "please review @dead-epsilon",
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: null,
      authorUserId: "local-board",
    });
    mockIssueService.resolveMentionedAgents.mockResolvedValue({
      agentIds: [],
      ambiguousTokens: [],
      droppedMentions: {
        terminated: [{ token: "dead-epsilon", agentId: TERMINATED_AGENT_ID, name: "dead-epsilon" }],
      },
    });
    mockIssueService.getAgentStatusById.mockResolvedValue("terminated");

    const res = await request(await installActor(createApp()))
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ comment: "please review @dead-epsilon" });

    expect(res.status).toBe(200);

    // (a) Fresh status read consulted for the assignee wake gate.
    expect(mockIssueService.getAgentStatusById).toHaveBeenCalledWith(ASSIGNEE_AGENT_ID);

    // (c) Activity log emitted from the PATCH comment branch.
    const actions = mockLogActivity.mock.calls.map((call) => call[1]?.action);
    expect(actions).toContain("issue.mention_dropped_terminated");
    const droppedCall = mockLogActivity.mock.calls.find(
      (call) => call[1]?.action === "issue.mention_dropped_terminated",
    );
    expect(droppedCall?.[1]?.details).toMatchObject({
      commentId: "comment-patch-1",
      droppedMentions: {
        terminated: [{ token: "dead-epsilon", agentId: TERMINATED_AGENT_ID, name: "dead-epsilon" }],
      },
    });

    // (b) No wake for terminated assignee or terminated mention target.
    await new Promise((resolve) => setImmediate(resolve));
    const wakeAgentIds = mockHeartbeatService.wakeup.mock.calls.map((call) => call[0]);
    expect(wakeAgentIds).not.toContain(ASSIGNEE_AGENT_ID);
    expect(wakeAgentIds).not.toContain(TERMINATED_AGENT_ID);
  });

  it("POST background task fails open when getAgentStatusById throws — assignee + mention wakes still fire", async () => {
    const unhandledRejections: unknown[] = [];
    const onRejection = (reason: unknown) => unhandledRejections.push(reason);
    process.on("unhandledRejection", onRejection);

    try {
      mockIssueService.resolveMentionedAgents.mockResolvedValue({
        agentIds: [LIVE_MENTION_AGENT_ID],
        ambiguousTokens: [],
        droppedMentions: { terminated: [] },
      });
      mockIssueService.getAgentStatusById.mockRejectedValue(
        new Error("simulated transient DB read failure"),
      );

      const res = await request(await installActor(createApp()))
        .post(`/api/issues/${ISSUE_ID}/comments`)
        .send({ body: "ping @live-charlie" });

      expect(res.status).toBe(201);

      // Drain the fire-and-forget IIFE.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      // Fail-open: assignee wake still fires (treated as non-terminated).
      const wakeAgentIds = mockHeartbeatService.wakeup.mock.calls.map((call) => call[0]);
      expect(wakeAgentIds).toContain(ASSIGNEE_AGENT_ID);
      // Live mention wake is not skipped by the upstream throw.
      expect(wakeAgentIds).toContain(LIVE_MENTION_AGENT_ID);
      // No process-level unhandled rejection from the background task.
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });
});
