import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

// AIW-137: stub the auto-route helper so the in_review entry gate tests
// (which only care about pullRequestUrl / selfAttest) keep passing once the
// auto-route gate is wired in. Dedicated auto-route coverage lives in
// issue-in-review-auto-route.test.ts.
vi.mock("../services/in-review-routing.js", () => ({
  selectLeastLoadedQaReviewer: vi.fn(async () => ({
    reviewer: {
      id: "99999999-9999-4999-8999-999999999999",
      name: "Stub QA",
      openIssueCount: 0,
      createdAt: new Date(),
    },
    candidateCount: 1,
  })),
  buildAutoRouteComment: vi.fn(() => "auto-route"),
  inReviewRoutingMissingReviewerError: vi.fn(() => ({
    error: "in_review requires explicit reviewer routing",
    details: { missing: ["reviewerAgentId", "executionPolicy"] },
  })),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockContinuityService = vi.hoisted(() => ({
  recomputeIssueContinuityState: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    canUser: vi.fn(async () => true),
    hasPermission: vi.fn(async () => true),
  }),
  agentService: () => ({
    getById: vi.fn(async () => null),
  }),
  documentService: () => ({}),
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
  logActivity: vi.fn(async () => undefined),
  projectService: () => ({}),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({}),
}));

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
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    companyId: "company-1",
    status: "in_progress",
    priority: "medium",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: null,
    assigneeUserId: "local-board",
    createdByUserId: "local-board",
    identifier: "PAP-888",
    title: "Review gate test",
    executionPolicy: null,
    executionState: null,
    hiddenAt: null,
    ...overrides,
  };
}

describe("in_review entry gate on PATCH /issues/:id", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
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
      id: "auto-route-comment",
      issueId,
      companyId: "company-1",
      body,
      authorAgentId: null,
      authorUserId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
  });

  it("returns 422 when status=in_review without pullRequestUrl or selfAttest", async () => {
    const existing = makeIssue();
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(existing);

    const app = await createApp();
    const res = await request(app)
      .patch(`/api/issues/${existing.id}`)
      .send({ status: "in_review" });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/pullRequestUrl/);
    expect(res.body.details.missing).toEqual([
      "pullRequestUrl",
      "selfAttest.testsRun",
      "selfAttest.docsUpdated",
      "selfAttest.worktreeClean",
    ]);
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("accepts status=in_review with a valid pullRequestUrl and persists it (AIW-148)", async () => {
    const existing = makeIssue();
    const prUrl = "https://github.com/example/repo/pull/7";
    const updated = makeIssue({ status: "in_review", pullRequestUrl: prUrl });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(updated);

    const app = await createApp();
    const res = await request(app)
      .patch(`/api/issues/${existing.id}`)
      .send({
        status: "in_review",
        pullRequestUrl: prUrl,
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledTimes(1);
    const [, payload] = mockIssueService.update.mock.calls[0];
    expect(payload).not.toHaveProperty("selfAttest");
    expect(payload.status).toBe("in_review");
    expect(payload.pullRequestUrl).toBe(prUrl);
    expect(res.body.pullRequestUrl).toBe(prUrl);
  });

  it("updates pullRequestUrl on a subsequent in_review -> in_review PATCH (AIW-148)", async () => {
    const existing = makeIssue({
      status: "in_review",
      pullRequestUrl: "https://github.com/example/repo/pull/7",
    });
    const nextUrl = "https://github.com/example/repo/pull/9";
    const updated = makeIssue({ status: "in_review", pullRequestUrl: nextUrl });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(updated);

    const app = await createApp();
    const res = await request(app)
      .patch(`/api/issues/${existing.id}`)
      .send({
        status: "in_review",
        pullRequestUrl: nextUrl,
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledTimes(1);
    const [, payload] = mockIssueService.update.mock.calls[0];
    expect(payload.pullRequestUrl).toBe(nextUrl);
  });

  it("accepts status=in_review with a complete selfAttest checklist and does not write pullRequestUrl (AIW-148)", async () => {
    const existing = makeIssue();
    const updated = makeIssue({ status: "in_review" });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(updated);

    const app = await createApp();
    const res = await request(app)
      .patch(`/api/issues/${existing.id}`)
      .send({
        status: "in_review",
        selfAttest: { testsRun: true, docsUpdated: true, worktreeClean: true },
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledTimes(1);
    const [, payload] = mockIssueService.update.mock.calls[0];
    expect(payload).not.toHaveProperty("selfAttest");
    expect(payload).not.toHaveProperty("pullRequestUrl");
    expect(payload.status).toBe("in_review");
  });

  it("rejects a malformed pullRequestUrl at the schema layer", async () => {
    const existing = makeIssue();
    mockIssueService.getById.mockResolvedValue(existing);

    const app = await createApp();
    const res = await request(app)
      .patch(`/api/issues/${existing.id}`)
      .send({ status: "in_review", pullRequestUrl: "not-a-url" });

    expect(res.status).toBe(400);
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects a partial selfAttest (missing field) at the schema layer", async () => {
    const existing = makeIssue();
    mockIssueService.getById.mockResolvedValue(existing);

    const app = await createApp();
    const res = await request(app)
      .patch(`/api/issues/${existing.id}`)
      .send({
        status: "in_review",
        selfAttest: { testsRun: true, docsUpdated: true },
      });

    expect(res.status).toBe(400);
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("does not gate status transitions to other states", async () => {
    const existing = makeIssue();
    const updated = makeIssue({ status: "blocked" });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(updated);

    const app = await createApp();
    const res = await request(app)
      .patch(`/api/issues/${existing.id}`)
      .send({ status: "blocked" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledTimes(1);
  });

  it("does not gate comment-only or non-status updates", async () => {
    const existing = makeIssue();
    const updated = makeIssue();
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(updated);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-x",
      issueId: existing.id,
      companyId: existing.companyId,
      body: "hi",
    });

    const app = await createApp();
    const res = await request(app)
      .patch(`/api/issues/${existing.id}`)
      .send({ comment: "hi" });

    expect(res.status).toBe(200);
  });
});
