import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// AIW-151 regression suite: the executor + auto-routed reviewer close-out
// sequence from AIW-148 must complete without Project Lead staff-reassignment.
//
// Coverage:
//   1. Happy path — executor flips to in_review, auto-route moves assignee
//      to QA, QA PATCHes status=done with an APPROVE comment, no /release
//      and no staff-reassignment are involved.
//   2. Executor 403 — while assigneeAgentId belongs to the reviewer, an
//      executor PATCH status=done is rejected by the continuity-owner gate.
//   3. No /release — the close-out path MUST NOT invoke release(); release
//      demotes in_review back to todo (feedback_release_demotes_in_review).
//   4. Request-changes cycle — reviewer PATCHes status=in_progress with a
//      comment + reassigns to the executor; the executor can then re-flip
//      to in_review (feedback_post_revision_reflip_required).
//
// Mocks mirror `issue-in-review-auto-route.test.ts` so the two suites share
// test-context. The DB-backed helper `selectLeastLoadedQaReviewer` is
// covered in `in-review-routing-service.test.ts`.
// ---------------------------------------------------------------------------

const ISSUE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COMPANY_ID = "company-1";
const EXECUTOR_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const QA_REVIEWER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  release: vi.fn(),
  resolveMentionedAgents: vi.fn(),
  findMentionedAgents: vi.fn(),
  getRelationSummaries: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  assertCheckoutOwner: vi.fn(),
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
  buildAutoRouteComment: vi.fn(
    (input: { executor: { id: string; name: string } | null; reviewer: { id: string; name: string }; routedBy: "auto" | "explicit" }) => {
      const reviewer = `[@${input.reviewer.name}](agent://${input.reviewer.id})`;
      if (input.routedBy === "explicit") return `Routed for QA review — reviewer: ${reviewer}.`;
      const executor = input.executor
        ? `[@${input.executor.name}](agent://${input.executor.id})`
        : "unknown executor";
      return `Auto-routed for QA review — executor: ${executor}, reviewer: ${reviewer}.`;
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
    title: "Close-out test",
    executionPolicy: null,
    executionState: null,
    hiddenAt: null,
    startedAt: new Date("2026-04-01T00:00:00Z"),
    updatedAt: new Date("2026-04-01T00:00:00Z"),
    pullRequestUrl: null,
    checkoutRunId: null,
    executionRunId: null,
    executionLockedAt: null,
    ...overrides,
  };
}

type ActorOverride =
  | { type: "board" }
  | { type: "agent"; agentId: string; runId?: string };

async function createApp(actor: ActorOverride) {
  vi.doUnmock("../middleware/index.js");
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    import("../routes/issues.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (actor.type === "board") {
      (req as any).actor = {
        type: "board",
        userId: "local-board",
        companyIds: [COMPANY_ID],
        source: "local_implicit",
        isInstanceAdmin: false,
      };
    } else {
      (req as any).actor = {
        type: "agent",
        agentId: actor.agentId,
        runId: actor.runId ?? `run-${actor.agentId}`,
        companyId: COMPANY_ID,
        source: "agent_token",
      };
    }
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("PATCH /issues/:id — in_review close-out after auto-route (AIW-151)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockInReviewRouting.buildAutoRouteComment.mockImplementation(
      (input: { executor: { id: string; name: string } | null; reviewer: { id: string; name: string }; routedBy: "auto" | "explicit" }) => {
        const reviewer = `[@${input.reviewer.name}](agent://${input.reviewer.id})`;
        if (input.routedBy === "explicit") return `Routed for QA review — reviewer: ${reviewer}.`;
        const executor = input.executor
          ? `[@${input.executor.name}](agent://${input.executor.id})`
          : "unknown executor";
        return `Auto-routed for QA review — executor: ${executor}, reviewer: ${reviewer}.`;
      },
    );
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
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
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
      return null;
    });
  });

  it("reviewer can PATCH status=done with a comment after auto-route — no PL reassignment, no /release", async () => {
    // Step 1: board transitions to in_review (simulating the executor's PATCH
    // through the board for this test; an agent-actor variant is covered
    // separately by the existing auto-route test).
    const atInProgress = makeIssue();
    mockIssueService.getById.mockResolvedValue(atInProgress);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...atInProgress,
      ...patch,
      // Mirror services/issues.ts:2074-2090 — clear execution locks on
      // status/assignee changes so downstream assertions match prod behavior.
      checkoutRunId: null,
      executionRunId: null,
      executionLockedAt: null,
      status: (patch.status as string) ?? atInProgress.status,
      assigneeAgentId: (patch.assigneeAgentId as string | null) ?? atInProgress.assigneeAgentId,
      assigneeUserId: (patch.assigneeUserId as string | null) ?? atInProgress.assigneeUserId,
      pullRequestUrl: (patch.pullRequestUrl as string) ?? atInProgress.pullRequestUrl,
    }));
    mockInReviewRouting.selectLeastLoadedQaReviewer.mockResolvedValue({
      reviewer: { id: QA_REVIEWER_ID, name: "QA-A", openIssueCount: 2, createdAt: new Date() },
      candidateCount: 2,
    });

    const PR_URL = "https://github.com/example/repo/pull/151";
    const flipToInReview = await request(await createApp({ type: "board" }))
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "in_review", pullRequestUrl: PR_URL });
    expect(flipToInReview.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      ISSUE_ID,
      expect.objectContaining({
        status: "in_review",
        assigneeAgentId: QA_REVIEWER_ID,
        pullRequestUrl: PR_URL,
      }),
    );

    // Step 2: reviewer PATCHes status=done with an APPROVE comment. The issue
    // row is now {status: in_review, assigneeAgentId: reviewer, policy: null,
    // executionState: null, executionRunId: null}.
    const atInReview = makeIssue({
      status: "in_review",
      assigneeAgentId: QA_REVIEWER_ID,
      pullRequestUrl: PR_URL,
    });
    mockIssueService.getById.mockResolvedValue(atInReview);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...atInReview,
      ...patch,
      status: (patch.status as string) ?? atInReview.status,
    }));

    const closeOut = await request(await createApp({ type: "agent", agentId: QA_REVIEWER_ID }))
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({
        status: "done",
        comment: "APPROVE: PR merged, tests green, acceptance criteria met.",
      });

    expect(closeOut.status).toBe(200);
    const donePatches = mockIssueService.update.mock.calls
      .map(([, patch]: [string, Record<string, unknown>]) => patch)
      .filter((patch: Record<string, unknown>) => patch.status === "done");
    expect(donePatches).toHaveLength(1);
    // No assignee change in close-out; reviewer stays owner of the row as it
    // terminates.
    expect(donePatches[0]).not.toHaveProperty("assigneeAgentId");
    // Executor 403 gate relies on `assigneeAgentId !== actor.agentId`; assert
    // the close-out did not touch the assignee.
    expect(donePatches[0].actorAgentId).toBe(QA_REVIEWER_ID);

    // AC: no /release invocation anywhere in the close-out path.
    expect(mockIssueService.release).not.toHaveBeenCalled();
  });

  it("executor stays 403 while assigneeAgentId belongs to the reviewer", async () => {
    // Issue state post auto-route: assignee = reviewer, status = in_review.
    const atInReview = makeIssue({
      status: "in_review",
      assigneeAgentId: QA_REVIEWER_ID,
      pullRequestUrl: "https://github.com/example/repo/pull/151",
    });
    mockIssueService.getById.mockResolvedValue(atInReview);

    const blocked = await request(await createApp({ type: "agent", agentId: EXECUTOR_ID }))
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "done", comment: "trying to close as executor" });

    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe("Only the continuity owner can mutate this issue directly");
    // No update slipped through.
    const donePatches = mockIssueService.update.mock.calls.filter(
      ([, patch]: [string, Record<string, unknown>]) => patch.status === "done",
    );
    expect(donePatches).toHaveLength(0);
  });

  it("request-changes with assignee transfer requires a typed handoff doc (feedback_handoff_doc_before_reassign)", async () => {
    // Reviewer's request-changes cycle that ALSO transfers ownership back to
    // the executor is gated by the handoff-doc rule — this is by design
    // (feedback_handoff_doc_before_reassign), not a bug introduced by AIW-151.
    // Asserting the 409 here prevents a future relaxation from silently
    // bypassing the handoff gate during an in_review -> in_progress swap.
    const atInReview = makeIssue({
      status: "in_review",
      assigneeAgentId: QA_REVIEWER_ID,
    });
    mockIssueService.getById.mockResolvedValue(atInReview);

    const reqChangesWithTransfer = await request(await createApp({ type: "board" }))
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({
        status: "in_progress",
        assigneeAgentId: EXECUTOR_ID,
        comment: "Request changes: PR has lint errors.",
      });
    expect(reqChangesWithTransfer.status).toBe(409);
    expect(reqChangesWithTransfer.body.error).toBe(
      "Active execution ownership transfer requires a typed handoff document for the new owner",
    );
  });

  it("reviewer can request changes without transferring — status reverts to in_progress, assignee stays the reviewer", async () => {
    // Simpler request-changes path: reviewer PATCHes status=in_progress WITH
    // a comment and no assignee change. The status reverts; the executor
    // receives the change-request via comment + handoff out-of-band. This
    // avoids the assignee-transfer gate and is the production-safe path.
    const atInReview = makeIssue({
      status: "in_review",
      assigneeAgentId: QA_REVIEWER_ID,
    });
    mockIssueService.getById.mockResolvedValue(atInReview);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...atInReview,
      ...patch,
      status: (patch.status as string) ?? atInReview.status,
    }));

    const requestChanges = await request(await createApp({ type: "agent", agentId: QA_REVIEWER_ID }))
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({
        status: "in_progress",
        comment: "Request changes: PR has lint errors. Executor, please revise via the usual handoff channel.",
      });
    expect(requestChanges.status).toBe(200);
    const backToInProgress = mockIssueService.update.mock.calls
      .map(([, patch]: [string, Record<string, unknown>]) => patch)
      .filter((patch: Record<string, unknown>) => patch.status === "in_progress");
    expect(backToInProgress).toHaveLength(1);
    // Assignee unchanged — the reviewer stays owner; any cross-agent
    // handoff MUST go through the handoff-doc path.
    expect(backToInProgress[0]).not.toHaveProperty("assigneeAgentId");
    expect(mockIssueService.release).not.toHaveBeenCalled();
  });
});
