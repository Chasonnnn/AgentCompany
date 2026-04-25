import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  getComment: vi.fn(),
  removeComment: vi.fn(),
  resolveMentionedAgents: vi.fn(),
  findMentionedAgents: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
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

async function installActor(app: express.Express, actor?: Record<string, unknown>) {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/issues.js"),
    import("../middleware/index.js"),
  ]);
  app.use((req, _res, next) => {
    (req as any).actor = actor ?? {
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

async function normalizePolicy(input: {
  stages: Array<{
    id: string;
    type: "review" | "approval";
    participants: Array<{ type: "agent"; agentId: string } | { type: "user"; userId: string }>;
  }>;
}) {
  const { normalizeIssueExecutionPolicy } = await import("../services/issue-execution-policy.js");
  return normalizeIssueExecutionPolicy(input);
}

function makeIssue(status: "todo" | "done") {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    status,
    assigneeAgentId: "22222222-2222-4222-8222-222222222222",
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "PAP-580",
    title: "Comment reopen default",
  };
}

describe("issue comment reopen routes", () => {
  beforeEach(() => {
    vi.resetModules();
    mockIssueService.getById.mockReset();
    mockIssueService.assertCheckoutOwner.mockReset();
    mockIssueService.update.mockReset();
    mockIssueService.addComment.mockReset();
    mockIssueService.getComment.mockReset();
    mockIssueService.removeComment.mockReset();
    mockIssueService.resolveMentionedAgents.mockReset();
    mockIssueService.findMentionedAgents.mockReset();
    mockIssueService.listWakeableBlockedDependents.mockReset();
    mockIssueService.getWakeableParentAfterChildCompletion.mockReset();
    mockAccessService.canUser.mockReset();
    mockAccessService.hasPermission.mockReset();
    mockHeartbeatService.wakeup.mockReset();
    mockHeartbeatService.reportRunActivity.mockReset();
    mockHeartbeatService.getRun.mockReset();
    mockHeartbeatService.getActiveRunForAgent.mockReset();
    mockHeartbeatService.cancelRun.mockReset();
    mockAgentService.getById.mockReset();
    mockLogActivity.mockReset();
    mockTxInsertValues.mockReset();
    mockTxInsert.mockReset();
    mockDb.transaction.mockReset();
    mockTxInsertValues.mockResolvedValue(undefined);
    mockTxInsert.mockImplementation(() => ({ values: mockTxInsertValues }));
    mockDb.transaction.mockImplementation(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx));
    mockHeartbeatService.wakeup.mockResolvedValue(undefined);
    mockHeartbeatService.reportRunActivity.mockResolvedValue(undefined);
    mockHeartbeatService.getRun.mockResolvedValue(null);
    mockHeartbeatService.getActiveRunForAgent.mockResolvedValue(null);
    mockHeartbeatService.cancelRun.mockResolvedValue(null);
    mockLogActivity.mockResolvedValue(undefined);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-1",
      issueId: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      body: "hello",
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: null,
      authorUserId: "local-board",
    });
    mockIssueService.getComment.mockResolvedValue({
      id: "comment-1",
      issueId: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      body: "hello",
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: null,
      authorUserId: "local-board",
    });
    mockIssueService.removeComment.mockResolvedValue({
      id: "comment-1",
      issueId: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      body: "hello",
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: null,
      authorUserId: "local-board",
    });
    mockIssueService.resolveMentionedAgents.mockResolvedValue({ agentIds: [], ambiguousTokens: [] });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockAccessService.canUser.mockResolvedValue(false);
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockAgentService.getById.mockResolvedValue(null);
  });

  it("treats reopen=true as a no-op when the issue is already open", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("todo"));
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue("todo"),
      ...patch,
    }));

    const res = await request(await installActor(createApp()))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ comment: "hello", reopen: true, assigneeAgentId: "33333333-3333-4333-8333-333333333333" });

    expect(res.status).toBe(200);
    expect(res.body.assigneeAgentId).toBe("33333333-3333-4333-8333-333333333333");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.updated",
        details: expect.not.objectContaining({ reopened: true }),
      }),
    );
  });

  it("rejects ambiguous @-mentions before creating a comment", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("todo"));
    mockIssueService.resolveMentionedAgents.mockResolvedValue({
      agentIds: [],
      ambiguousTokens: ["ceo"],
    });

    const res = await request(await installActor(createApp()))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "@CEO please decide." });

    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      error: "Ambiguous @-mentions must be disambiguated with agent:// links",
      details: { ambiguousTokens: ["ceo"] },
    });
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("reopens closed issues via the PATCH comment path", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("done"));
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue("done"),
      ...patch,
    }));

    const res = await request(await installActor(createApp()))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ comment: "hello", reopen: true, assigneeAgentId: "33333333-3333-4333-8333-333333333333" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        assigneeAgentId: "33333333-3333-4333-8333-333333333333",
        status: "todo",
        actorAgentId: null,
        actorUserId: "local-board",
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.updated",
        details: expect.objectContaining({
          reopened: true,
          reopenedFrom: "done",
          status: "todo",
        }),
      }),
    );
  });

  it("implicitly reopens a closed issue when another agent comments", async () => {
    const closedIssue = {
      ...makeIssue("done"),
      assigneeAgentId: "22222222-2222-4222-8222-222222222222",
      assigneeUserId: null,
    };
    mockIssueService.getById.mockResolvedValue(closedIssue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...closedIssue,
      ...patch,
    }));

    const res = await request(await installActor(createApp(), {
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      source: "agent_api_key",
    }))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "picking this back up" });

    expect(res.status).toBe(201);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      { status: "todo" },
    );
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({
        reason: "issue_reopened_via_comment",
        contextSnapshot: expect.objectContaining({
          source: "issue.comment.reopen",
          wakeReason: "issue_reopened_via_comment",
        }),
      }),
    );
  });

  it("does not enqueue a mention wake when a POST comment mentions only the author agent", async () => {
    const SELF_ID = "77777777-7777-4777-8777-777777777777";
    const openIssue = {
      ...makeIssue("todo"),
      assigneeAgentId: null,
      assigneeUserId: null,
    };
    mockIssueService.getById.mockResolvedValue(openIssue);
    mockIssueService.resolveMentionedAgents.mockResolvedValue({
      agentIds: [SELF_ID],
      ambiguousTokens: [],
    });
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-self-only",
      issueId: openIssue.id,
      companyId: "company-1",
      body: `[@Self](agent://${SELF_ID})`,
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: SELF_ID,
      authorUserId: null,
    });

    const res = await request(
      await installActor(createApp(), {
        type: "agent",
        agentId: SELF_ID,
        companyId: "company-1",
        source: "agent_api_key",
      }),
    )
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: `[@Self](agent://${SELF_ID})` });

    expect(res.status).toBe(201);
    // The wake enqueue is fire-and-forget; give the microtask queue time to drain.
    await new Promise((r) => setTimeout(r, 10));
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("wakes only the other mentioned agent when a POST comment names self + another", async () => {
    const SELF_ID = "77777777-7777-4777-8777-777777777777";
    const OTHER_ID = "88888888-8888-4888-8888-888888888888";
    const openIssue = {
      ...makeIssue("todo"),
      assigneeAgentId: null,
      assigneeUserId: null,
    };
    mockIssueService.getById.mockResolvedValue(openIssue);
    mockIssueService.resolveMentionedAgents.mockResolvedValue({
      agentIds: [SELF_ID, OTHER_ID],
      ambiguousTokens: [],
    });
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-self-plus-other",
      issueId: openIssue.id,
      companyId: "company-1",
      body: `[@Self](agent://${SELF_ID}) cc [@Other](agent://${OTHER_ID})`,
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: SELF_ID,
      authorUserId: null,
    });

    const res = await request(
      await installActor(createApp(), {
        type: "agent",
        agentId: SELF_ID,
        companyId: "company-1",
        source: "agent_api_key",
      }),
    )
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: `[@Self](agent://${SELF_ID}) cc [@Other](agent://${OTHER_ID})` });

    expect(res.status).toBe(201);
    await vi.waitFor(() => {
      expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
        OTHER_ID,
        expect.objectContaining({
          reason: "issue_comment_mentioned",
          contextSnapshot: expect.objectContaining({ source: "comment.mention" }),
        }),
      );
    });
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalledWith(
      SELF_ID,
      expect.anything(),
    );
  });

  it("interrupts an active run before a combined comment update", async () => {
    const issue = {
      ...makeIssue("todo"),
      executionRunId: "run-1",
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
    }));
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      agentId: "22222222-2222-4222-8222-222222222222",
      status: "running",
    });
    mockHeartbeatService.cancelRun.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      agentId: "22222222-2222-4222-8222-222222222222",
      status: "cancelled",
    });

    const res = await request(await installActor(createApp()))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ comment: "hello", interrupt: true, assigneeAgentId: "33333333-3333-4333-8333-333333333333" });

    expect(res.status).toBe(200);
    expect(mockHeartbeatService.getRun).toHaveBeenCalledWith("run-1");
    expect(mockHeartbeatService.cancelRun).toHaveBeenCalledWith("run-1");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "heartbeat.cancelled",
        details: expect.objectContaining({
          source: "issue_comment_interrupt",
          issueId: "11111111-1111-4111-8111-111111111111",
        }),
      }),
    );
  });

  it("treats packetized issue comments as descriptive only", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("todo"));
    mockIssueService.addComment.mockImplementation(async (_id: string, body: string) => ({
      id: "comment-packet",
      issueId: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      body,
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: null,
      authorUserId: "local-board",
    }));

    const body = [
      "---",
      "kind: paperclip/assignment.v1",
      'owner: "cto"',
      'objective: "Ship the operating model rollout"',
      "---",
      "",
      "Delegation context only.",
    ].join("\n");

    const res = await request(await installActor(createApp()))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body });

    expect(res.status).toBe(201);
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      body,
      expect.any(Object),
    );
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(res.body.body).toBe(body);
  });

  it("allows the author to cancel a queued issue comment for the active run", async () => {
    const issue = {
      ...makeIssue("todo"),
      executionRunId: "run-1",
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      agentId: "99999999-9999-4999-8999-999999999999",
      status: "running",
      startedAt: new Date("2026-04-15T12:00:00.000Z"),
      createdAt: new Date("2026-04-15T11:59:59.000Z"),
      contextSnapshot: { issueId: issue.id },
    });
    mockIssueService.getComment.mockResolvedValue({
      id: "comment-queued",
      issueId: issue.id,
      companyId: "company-1",
      body: "queue me",
      createdAt: new Date("2026-04-15T12:00:01.000Z"),
      updatedAt: new Date("2026-04-15T12:00:01.000Z"),
      authorAgentId: null,
      authorUserId: "local-board",
    });
    mockIssueService.removeComment.mockResolvedValue({
      id: "comment-queued",
      issueId: issue.id,
      companyId: "company-1",
      body: "queue me",
      createdAt: new Date("2026-04-15T12:00:01.000Z"),
      updatedAt: new Date("2026-04-15T12:00:01.000Z"),
      authorAgentId: null,
      authorUserId: "local-board",
    });

    const res = await request(await installActor(createApp()))
      .delete("/api/issues/11111111-1111-4111-8111-111111111111/comments/comment-queued");

    expect(res.status).toBe(200);
    expect(mockIssueService.removeComment).toHaveBeenCalledWith("comment-queued");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.comment_cancelled",
        details: expect.objectContaining({
          source: "queue_cancel",
          queueTargetRunId: "run-1",
        }),
      }),
    );
  });

  it("writes decision ids into executionState and inserts the decision inside the transaction", async () => {
    const policy = await normalizePolicy({
      stages: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          type: "approval",
          participants: [{ type: "user", userId: "local-board" }],
        },
      ],
    })!;
    const issue = {
      ...makeIssue("todo"),
      status: "in_review",
      assigneeAgentId: null,
      assigneeUserId: "local-board",
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: policy.stages[0].id,
        currentStageIndex: 0,
        currentStageType: "approval",
        currentParticipant: { type: "user", userId: "local-board" },
        returnAssignee: { type: "agent", agentId: "22222222-2222-4222-8222-222222222222" },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>, tx?: unknown) => ({
      ...issue,
      ...patch,
      executionState: patch.executionState,
      status: "done",
      completedAt: new Date(),
      updatedAt: new Date(),
      _tx: tx,
    }));

    const res = await request(await installActor(createApp()))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done", comment: "Approved for ship" });

    expect(res.status).toBe(200);
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        executionState: expect.objectContaining({
          status: "completed",
          lastDecisionId: expect.any(String),
          lastDecisionOutcome: "approved",
        }),
      }),
      mockTx,
    );
    const updatePatch = mockIssueService.update.mock.calls[0]?.[1] as Record<string, any>;
    const decisionId = updatePatch.executionState.lastDecisionId;
    expect(mockTxInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        id: decisionId,
        issueId: "11111111-1111-4111-8111-111111111111",
        outcome: "approved",
        body: "Approved for ship",
      }),
    );
  });

  it("coerces executor handoff patches into workflow-controlled review wakes", async () => {
    const policy = await normalizePolicy({
      stages: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          type: "review",
          participants: [{ type: "agent", agentId: "33333333-3333-4333-8333-333333333333" }],
        },
      ],
    })!;
    const issue = {
      ...makeIssue("todo"),
      status: "in_progress",
      assigneeAgentId: "22222222-2222-4222-8222-222222222222",
      executionPolicy: policy,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(
      await installActor(createApp(), {
        type: "agent",
        agentId: "22222222-2222-4222-8222-222222222222",
        companyId: "company-1",
        runId: "run-1",
      }),
    )
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({
        status: "in_review",
        assigneeAgentId: null,
        assigneeUserId: "local-board",
        selfAttest: {
          testsRun: true,
          docsUpdated: true,
          worktreeClean: true,
        },
        reviewRequest: {
          instructions: "Please verify the fix against the reproduction steps and note any residual risk.",
        },
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        status: "in_review",
        assigneeAgentId: "22222222-2222-4222-8222-222222222222",
        assigneeUserId: null,
        executionState: expect.objectContaining({
          status: "pending",
          currentStageType: "review",
          currentParticipant: expect.objectContaining({
            type: "agent",
            agentId: "33333333-3333-4333-8333-333333333333",
          }),
          returnAssignee: expect.objectContaining({
            type: "agent",
            agentId: "22222222-2222-4222-8222-222222222222",
          }),
          reviewRequest: {
            instructions: "Please verify the fix against the reproduction steps and note any residual risk.",
          },
        }),
      }),
    );
    expect(res.body.assigneeAgentId).toBe("22222222-2222-4222-8222-222222222222");
    expect(res.body.assigneeUserId).toBeNull();
    expect(res.body.executionState).toMatchObject({
      status: "pending",
      currentStageType: "review",
      currentParticipant: {
        type: "agent",
        agentId: "33333333-3333-4333-8333-333333333333",
      },
      returnAssignee: {
        type: "agent",
        agentId: "22222222-2222-4222-8222-222222222222",
      },
      reviewRequest: {
        instructions: "Please verify the fix against the reproduction steps and note any residual risk.",
      },
    });
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "33333333-3333-4333-8333-333333333333",
      expect.objectContaining({
        reason: "execution_review_requested",
        payload: expect.objectContaining({
          issueId: "11111111-1111-4111-8111-111111111111",
          executionStage: expect.objectContaining({
            wakeRole: "reviewer",
            stageType: "review",
            reviewRequest: {
              instructions: "Please verify the fix against the reproduction steps and note any residual risk.",
            },
            allowedActions: ["approve", "request_changes"],
          }),
        }),
      }),
    );
  });

  it("wakes the return assignee with execution_changes_requested", async () => {
    const policy = await normalizePolicy({
      stages: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          type: "review",
          participants: [{ type: "agent", agentId: "33333333-3333-4333-8333-333333333333" }],
        },
      ],
    })!;
    const issue = {
      ...makeIssue("todo"),
      status: "in_review",
      assigneeAgentId: "22222222-2222-4222-8222-222222222222",
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: policy.stages[0].id,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: "33333333-3333-4333-8333-333333333333" },
        returnAssignee: { type: "agent", agentId: "22222222-2222-4222-8222-222222222222" },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(
      await installActor(createApp(), {
        type: "agent",
        agentId: "33333333-3333-4333-8333-333333333333",
        companyId: "company-1",
        runId: "run-2",
      }),
    )
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({
        status: "in_progress",
        comment: "Needs another pass",
      });

    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
        "22222222-2222-4222-8222-222222222222",
        expect.objectContaining({
          reason: "execution_changes_requested",
          payload: expect.objectContaining({
            issueId: "11111111-1111-4111-8111-111111111111",
            executionStage: expect.objectContaining({
              wakeRole: "executor",
              stageType: "review",
              lastDecisionOutcome: "changes_requested",
              allowedActions: ["address_changes", "resubmit"],
            }),
          }),
        }),
      );
    });
  });
});
