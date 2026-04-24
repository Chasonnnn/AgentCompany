import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Route behavior (mocked services). DB-backed helper coverage lives in
// `in-review-routing-service.test.ts`.
// ---------------------------------------------------------------------------

const ISSUE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COMPANY_ID = "company-1";
const EXECUTOR_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const QA_REVIEWER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const QA_REVIEWER_B_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  resolveMentionedAgents: vi.fn(),
  findMentionedAgents: vi.fn(),
  getRelationSummaries: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
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

const mockContinuityService = vi.hoisted(() => ({
  recomputeIssueContinuityState: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

const mockInReviewRouting = vi.hoisted(() => ({
  selectLeastLoadedQaReviewer: vi.fn(),
  // Kept in sync with the real implementation in
  // `services/in-review-routing.ts`. AIW-151 added the reviewer close-out
  // guidance line; the integration test below asserts it survives the route.
  buildAutoRouteComment: vi.fn(
    (input: { executor: { id: string; name: string } | null; reviewer: { id: string; name: string }; routedBy: "auto" | "explicit" }) => {
      const reviewer = `[@${input.reviewer.name}](agent://${input.reviewer.id})`;
      const guidance =
        "Reviewer: PATCH status=done with an APPROVE comment to close; PATCH status=in_progress (reassigning to the executor) with a comment to request changes. Do NOT /checkout (rejects in_review) or /release (demotes to todo).";
      if (input.routedBy === "explicit") return `Routed for QA review — reviewer: ${reviewer}.\n\n${guidance}`;
      const executor = input.executor
        ? `[@${input.executor.name}](agent://${input.executor.id})`
        : "unknown executor";
      return `Auto-routed for QA review — executor: ${executor}, reviewer: ${reviewer} (least-loaded among qa_evals_continuity_owner).\n\n${guidance}`;
    },
  ),
  inReviewRoutingMissingReviewerError: vi.fn(() => ({
    error: "in_review requires explicit reviewer routing",
    details: { missing: ["reviewerAgentId", "executionPolicy"] },
  })),
}));

vi.mock("../services/in-review-routing.js", () => mockInReviewRouting);

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    canUser: vi.fn(async () => true),
    hasPermission: vi.fn(async () => true),
  }),
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
      general: { censorUsernameInLogs: false, feedbackDataSharingPreference: "prompt" },
    })),
    listCompanyIds: vi.fn(async () => [COMPANY_ID]),
  }),
  issueApprovalService: () => ({}),
  issueReferenceService: () => ({
    syncIssue: vi.fn(async () => undefined),
    syncComment: vi.fn(async () => undefined),
    syncDocument: vi.fn(async () => undefined),
    deleteCommentSource: vi.fn(async () => undefined),
    deleteDocumentSource: vi.fn(async () => undefined),
    listIssueReferenceSummary: vi.fn(async () => ({ outbound: [], inbound: [] })),
    diffIssueReferenceSummary: vi.fn(() => ({
      addedReferencedIssues: [],
      removedReferencedIssues: [],
      currentReferencedIssues: [],
    })),
    emptySummary: vi.fn(() => ({ outbound: [], inbound: [] })),
  }),
  issueContinuityService: () => mockContinuityService,
  issueService: () => mockIssueService,
  officeCoordinationService: () => ({
    findOfficeOperator: vi.fn(async () => null),
    buildWakeSnapshot: vi.fn(async () => null),
    isOfficeOperatorAgent: vi.fn(async () => false),
  }),
  logActivity: mockLogActivity,
  projectService: () => ({}),
  routineService: () => ({ syncRunStatusForIssue: vi.fn(async () => undefined) }),
  workProductService: () => ({}),
  conferenceContextService: () => ({}),
  executionPolicyService: () => ({}),
  ISSUE_LIST_DEFAULT_LIMIT: 50,
  ISSUE_LIST_MAX_LIMIT: 200,
  clampIssueListLimit: (n: number) => n,
}));

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: ISSUE_ID,
    companyId: COMPANY_ID,
    status: "in_progress",
    priority: "medium",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: EXECUTOR_ID,
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "AIW-999",
    title: "Auto-route test",
    executionPolicy: null,
    executionState: null,
    hiddenAt: null,
    startedAt: new Date("2026-04-01T00:00:00Z"),
    updatedAt: new Date("2026-04-01T00:00:00Z"),
    ...overrides,
  };
}

async function createApp() {
  vi.doUnmock("../middleware/index.js");
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    import("../routes/issues.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: [COMPANY_ID],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("PATCH /issues/:id — in_review auto-route gate", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockInReviewRouting.buildAutoRouteComment.mockImplementation(
      (input: { executor: { id: string; name: string } | null; reviewer: { id: string; name: string }; routedBy: "auto" | "explicit" }) => {
        const reviewer = `[@${input.reviewer.name}](agent://${input.reviewer.id})`;
        const guidance =
          "Reviewer: PATCH status=done with an APPROVE comment to close; PATCH status=in_progress (reassigning to the executor) with a comment to request changes. Do NOT /checkout (rejects in_review) or /release (demotes to todo).";
        if (input.routedBy === "explicit") return `Routed for QA review — reviewer: ${reviewer}.\n\n${guidance}`;
        const executor = input.executor
          ? `[@${input.executor.name}](agent://${input.executor.id})`
          : "unknown executor";
        return `Auto-routed for QA review — executor: ${executor}, reviewer: ${reviewer} (least-loaded among qa_evals_continuity_owner).\n\n${guidance}`;
      },
    );
    mockInReviewRouting.inReviewRoutingMissingReviewerError.mockReturnValue({
      error: "in_review requires explicit reviewer routing",
      details: { missing: ["reviewerAgentId", "executionPolicy"] },
    });
    mockContinuityService.recomputeIssueContinuityState.mockResolvedValue({
      tier: "normal",
      status: "active",
      health: "healthy",
      healthReason: null,
      healthDetails: [],
      requiredDocumentKeys: [],
      missingDocumentKeys: [],
      specState: "frozen",
      branchRole: "none",
      branchStatus: "none",
      unresolvedBranchIssueIds: [],
      returnedBranchIssueIds: [],
      openReviewFindingsRevisionId: null,
      lastProgressAt: null,
      lastHandoffAt: null,
      lastReviewFindingsAt: null,
      lastReviewReturnAt: null,
      lastBranchReturnAt: null,
      lastPreparedAt: null,
      lastBundleHash: null,
    });
    mockIssueService.resolveMentionedAgents.mockResolvedValue({ agentIds: [], ambiguousTokens: [] });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.addComment.mockImplementation(async (issueId: string, body: string) => ({
      id: `comment-${randomUUID()}`,
      issueId,
      companyId: COMPANY_ID,
      body,
      authorAgentId: null,
      authorUserId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === EXECUTOR_ID) return { id, companyId: COMPANY_ID, name: "Executor", role: "engineer", archetypeKey: "general" };
      if (id === QA_REVIEWER_ID) return { id, companyId: COMPANY_ID, name: "QA-A", role: "qa", archetypeKey: "qa_evals_continuity_owner" };
      if (id === QA_REVIEWER_B_ID) return { id, companyId: COMPANY_ID, name: "QA-B", role: "qa", archetypeKey: "qa_evals_continuity_owner" };
      return null;
    });
  });

  it("auto-routes a QA reviewer when no execution policy is attached", async () => {
    const existing = makeIssue();
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...existing,
      ...patch,
      status: (patch.status as string) ?? existing.status,
      assigneeAgentId: (patch.assigneeAgentId as string | null) ?? existing.assigneeAgentId,
    }));
    mockInReviewRouting.selectLeastLoadedQaReviewer.mockResolvedValue({
      reviewer: { id: QA_REVIEWER_ID, name: "QA-A", openIssueCount: 3, createdAt: new Date() },
      candidateCount: 2,
    });

    const res = await request(await createApp())
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({
        status: "in_review",
        pullRequestUrl: "https://github.com/example/repo/pull/1",
      });

    expect(res.status).toBe(200);
    expect(mockInReviewRouting.selectLeastLoadedQaReviewer).toHaveBeenCalledWith(
      expect.anything(),
      { companyId: COMPANY_ID, excludeAgentId: EXECUTOR_ID },
    );
    expect(mockIssueService.update).toHaveBeenCalledWith(
      ISSUE_ID,
      expect.objectContaining({
        status: "in_review",
        assigneeAgentId: QA_REVIEWER_ID,
        assigneeUserId: null,
      }),
    );

    const commentCall = mockIssueService.addComment.mock.calls.find(
      ([, body]: [string, string]) => typeof body === "string" && body.startsWith("Auto-routed"),
    );
    expect(commentCall).toBeTruthy();
    expect(commentCall![1]).toContain("[@Executor](agent://");
    expect(commentCall![1]).toContain("[@QA-A](agent://");
    // AIW-151: the close-out guidance line MUST be posted so QA heartbeats
    // know to PATCH instead of falling back to the comment-only rule.
    expect(commentCall![1]).toContain("PATCH status=done");
    expect(commentCall![1]).toContain("PATCH status=in_progress");
    expect(commentCall![1]).toContain("Do NOT /checkout");

    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.in_review_auto_routed",
        details: expect.objectContaining({
          routedBy: "auto",
          reviewerAgentId: QA_REVIEWER_ID,
          executorAgentId: EXECUTOR_ID,
          openIssueCount: 3,
          candidateCount: 2,
        }),
      }),
    );

    // Allow queued wake microtasks to flush before asserting on them.
    await new Promise((resolve) => setImmediate(resolve));
    const reviewerWakeCalls = mockHeartbeatService.wakeup.mock.calls.filter(
      ([agentId]: [string]) => agentId === QA_REVIEWER_ID,
    );
    expect(reviewerWakeCalls).toHaveLength(1);
    const wakeCall = reviewerWakeCalls[0];
    expect(wakeCall[1]).toMatchObject({
      reason: "execution_review_requested",
      payload: expect.objectContaining({
        issueId: ISSUE_ID,
        executionStage: expect.objectContaining({
          wakeRole: "reviewer",
          routedBy: "auto",
          executorAgentId: EXECUTOR_ID,
        }),
      }),
    });
  });

  it("honors an explicit reviewer in the body and skips the helper", async () => {
    const existing = makeIssue();
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...existing,
      ...patch,
      assigneeAgentId: (patch.assigneeAgentId as string | null) ?? existing.assigneeAgentId,
      status: (patch.status as string) ?? existing.status,
    }));

    const res = await request(await createApp())
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({
        status: "in_review",
        assigneeAgentId: QA_REVIEWER_B_ID,
        pullRequestUrl: "https://github.com/example/repo/pull/2",
      });

    expect(res.status).toBe(200);
    expect(mockInReviewRouting.selectLeastLoadedQaReviewer).not.toHaveBeenCalled();
    expect(mockIssueService.update).toHaveBeenCalledWith(
      ISSUE_ID,
      expect.objectContaining({
        status: "in_review",
        assigneeAgentId: QA_REVIEWER_B_ID,
      }),
    );

    const commentCall = mockIssueService.addComment.mock.calls.find(
      ([, body]: [string, string]) => typeof body === "string" && body.startsWith("Routed for QA review"),
    );
    expect(commentCall).toBeTruthy();
    expect(commentCall![1]).toContain(`agent://${QA_REVIEWER_B_ID}`);
    // AIW-151: same close-out guidance on the explicit-reviewer path.
    expect(commentCall![1]).toContain("PATCH status=done");

    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.in_review_auto_routed",
        details: expect.objectContaining({
          routedBy: "explicit",
          reviewerAgentId: QA_REVIEWER_B_ID,
          openIssueCount: null,
          candidateCount: null,
        }),
      }),
    );

    await new Promise((resolve) => setImmediate(resolve));
    const wakeCall = mockHeartbeatService.wakeup.mock.calls.find(
      ([agentId]: [string]) => agentId === QA_REVIEWER_B_ID,
    );
    expect(wakeCall).toBeTruthy();
    expect(wakeCall![1]).toMatchObject({
      reason: "execution_review_requested",
      payload: expect.objectContaining({
        executionStage: expect.objectContaining({
          routedBy: "explicit",
        }),
      }),
    });
  });

  it("returns 422 when the caller opts out of auto-routing", async () => {
    const existing = makeIssue();
    mockIssueService.getById.mockResolvedValue(existing);

    const res = await request(await createApp())
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({
        status: "in_review",
        autoRouteReviewer: false,
        pullRequestUrl: "https://github.com/example/repo/pull/3",
      });

    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      error: "in_review requires explicit reviewer routing",
      details: { missing: ["reviewerAgentId", "executionPolicy"] },
    });
    expect(mockInReviewRouting.selectLeastLoadedQaReviewer).not.toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("returns 422 when no QA agent is eligible", async () => {
    const existing = makeIssue();
    mockIssueService.getById.mockResolvedValue(existing);
    mockInReviewRouting.selectLeastLoadedQaReviewer.mockResolvedValue({
      reviewer: null,
      candidateCount: 0,
    });

    const res = await request(await createApp())
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({
        status: "in_review",
        pullRequestUrl: "https://github.com/example/repo/pull/4",
      });

    expect(res.status).toBe(422);
    expect(res.body.details.missing).toEqual(["reviewerAgentId", "executionPolicy"]);
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("does not auto-route when the existing policy-driven path advanced a review stage", async () => {
    // Simulate a policy-driven path by seeding an existing pending execution
    // state whose transition keeps it pending. The auto-route gate must stay
    // inert so we do not double-route.
    const existing = makeIssue({
      executionPolicy: null,
      executionState: null,
    });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...existing,
      ...patch,
      executionState: { status: "pending", currentStageType: "review" },
      status: "in_review",
    }));

    // When `updateFields.executionState` is set to pending by the transition,
    // our gate should not fire. Simulate this by sending a policy that the
    // transition logic can advance. Easiest path: set executionPolicy in the
    // body, which flows through the transition and sets executionState.
    await request(await createApp())
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({
        status: "in_review",
        pullRequestUrl: "https://github.com/example/repo/pull/5",
        executionPolicy: {
          stages: [
            {
              id: "review-stage-1",
              type: "review",
              participants: [{ type: "agent", agentId: QA_REVIEWER_ID }],
            },
          ],
        },
      });

    expect(mockInReviewRouting.selectLeastLoadedQaReviewer).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "issue.in_review_auto_routed" }),
    );
  });

  it("does not gate when status is not transitioning to in_review", async () => {
    const existing = makeIssue();
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...existing,
      ...patch,
    }));

    await request(await createApp())
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "blocked" });

    expect(mockInReviewRouting.selectLeastLoadedQaReviewer).not.toHaveBeenCalled();
  });

  it("422s at the in_review entry gate before the routing helper is consulted when neither pullRequestUrl nor selfAttest is supplied", async () => {
    const existing = makeIssue();
    mockIssueService.getById.mockResolvedValue(existing);

    const res = await request(await createApp())
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "in_review" });

    expect(res.status).toBe(422);
    expect(res.body.details.missing).toEqual(
      expect.arrayContaining([
        "pullRequestUrl",
        "selfAttest.testsRun",
        "selfAttest.docsUpdated",
        "selfAttest.worktreeClean",
      ]),
    );
    expect(mockInReviewRouting.selectLeastLoadedQaReviewer).not.toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "issue.in_review_auto_routed" }),
    );
  });

  // AIW-137 review finding F-PM1: the route schema accepts `autoRouteReviewer`
  // as a control flag, but it must never flow into `issueService.update`'s
  // patch — the `issues` table has no such column.
  // AIW-148: `pullRequestUrl` now DOES persist; assert write-through here too.
  it("does not forward the autoRouteReviewer control flag into issueService.update", async () => {
    const existing = makeIssue();
    const prUrl = "https://github.com/example/repo/pull/7";
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...existing,
      ...patch,
      assigneeAgentId: (patch.assigneeAgentId as string | null) ?? existing.assigneeAgentId,
      status: (patch.status as string) ?? existing.status,
    }));
    mockInReviewRouting.selectLeastLoadedQaReviewer.mockResolvedValue({
      reviewer: { id: QA_REVIEWER_ID, name: "QA-A", openIssueCount: 3, createdAt: new Date() },
      candidateCount: 2,
    });

    const res = await request(await createApp())
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({
        status: "in_review",
        autoRouteReviewer: true,
        pullRequestUrl: prUrl,
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalled();
    const patches = mockIssueService.update.mock.calls.map(
      ([, patch]) => patch as Record<string, unknown>,
    );
    for (const patch of patches) {
      expect(patch).not.toHaveProperty("autoRouteReviewer");
    }
    expect(patches.some((patch) => patch.pullRequestUrl === prUrl)).toBe(true);
  });

  it("does not gate when status is already in_review (re-patching)", async () => {
    const existing = makeIssue({ status: "in_review" });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...existing,
      ...patch,
    }));

    await request(await createApp())
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "in_review", pullRequestUrl: "https://github.com/example/repo/pull/6" });

    expect(mockInReviewRouting.selectLeastLoadedQaReviewer).not.toHaveBeenCalled();
  });
});
