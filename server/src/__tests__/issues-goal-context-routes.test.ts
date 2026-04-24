import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";

const legacyProjectLinkedIssue = {
  id: "11111111-1111-4111-8111-111111111111",
  companyId: "company-1",
  identifier: "PAP-581",
  title: "Legacy onboarding task",
  description: "Seed the first CEO task",
  status: "todo",
  priority: "medium",
  projectId: "22222222-2222-4222-8222-222222222222",
  goalId: null,
  parentId: null,
  assigneeAgentId: "33333333-3333-4333-8333-333333333333",
  assigneeUserId: null,
  updatedAt: new Date("2026-03-24T12:00:00Z"),
  executionWorkspaceId: null,
  labels: [],
  labelIds: [],
};

const projectGoal = {
  id: "44444444-4444-4444-8444-444444444444",
  companyId: "company-1",
  title: "Launch the company",
  description: null,
  level: "company",
  status: "active",
  parentId: null,
  ownerAgentId: null,
  createdAt: new Date("2026-03-20T00:00:00Z"),
  updatedAt: new Date("2026-03-20T00:00:00Z"),
};

function buildContinuityResponse(overrides?: {
  continuityStatus?: string;
  planApprovalStatus?: string | null;
  planApprovalRequiresApproval?: boolean;
  executionState?: Record<string, unknown> | null;
}) {
  return {
    issueId: legacyProjectLinkedIssue.id,
    continuityState: {
      tier: "normal",
      status: overrides?.continuityStatus ?? "ready",
      health: "healthy",
      requiredDocumentKeys: [],
      missingDocumentKeys: [],
      specState: "editable",
      branchRole: "none",
      branchStatus: "none",
      unresolvedBranchIssueIds: [],
      returnedBranchIssueIds: [],
      openDecisionQuestionCount: 0,
      blockingDecisionQuestionCount: 0,
      lastProgressAt: null,
      lastHandoffAt: null,
      lastPreparedAt: null,
      lastBundleHash: null,
      planApproval: {
        approvalId: null,
        status: overrides?.planApprovalStatus ?? null,
        currentPlanRevisionId: null,
        requestedPlanRevisionId: null,
        approvedPlanRevisionId: null,
        specRevisionId: null,
        testPlanRevisionId: null,
        decisionNote: null,
        lastRequestedAt: null,
        lastDecidedAt: null,
        currentRevisionApproved: false,
        requiresApproval: overrides?.planApprovalRequiresApproval ?? false,
        requiresResubmission: false,
      },
    },
    continuityBundle: {
      executionState: overrides?.executionState ?? null,
      planApproval: {
        approvalId: null,
        status: overrides?.planApprovalStatus ?? null,
        currentPlanRevisionId: null,
        requestedPlanRevisionId: null,
        approvedPlanRevisionId: null,
        specRevisionId: null,
        testPlanRevisionId: null,
        decisionNote: null,
        lastRequestedAt: null,
        lastDecidedAt: null,
        currentRevisionApproved: false,
        requiresApproval: overrides?.planApprovalRequiresApproval ?? false,
        requiresResubmission: false,
      },
    },
    continuityOwner: {
      assigneeAgentId: legacyProjectLinkedIssue.assigneeAgentId,
      assigneeUserId: null,
    },
    activeGateParticipant: null,
    remediation: { suggestedActions: [], blockedActions: [] },
  };
}

async function createHarness(options?: {
  issue?: typeof legacyProjectLinkedIssue;
  continuity?: Parameters<typeof buildContinuityResponse>[0];
}) {
  vi.resetModules();
  const { issueRoutes } = await import("../routes/issues.js");
  const issueService = {
    getById: vi.fn().mockResolvedValue(options?.issue ?? legacyProjectLinkedIssue),
    getAncestors: vi.fn().mockResolvedValue([]),
    getRelationSummaries: vi.fn().mockResolvedValue({ blockedBy: [], blocks: [] }),
    findMentionedProjectIds: vi.fn().mockResolvedValue([]),
    getCommentCursor: vi.fn().mockResolvedValue({
      totalComments: 0,
      latestCommentId: null,
      latestCommentAt: null,
    }),
    getComment: vi.fn().mockResolvedValue(null),
    listAttachments: vi.fn().mockResolvedValue([]),
  };
  const projectService = {
    getById: vi.fn().mockResolvedValue({
      id: legacyProjectLinkedIssue.projectId,
      companyId: "company-1",
      urlKey: "onboarding",
      goalId: projectGoal.id,
      goalIds: [projectGoal.id],
      goals: [{ id: projectGoal.id, title: projectGoal.title }],
      name: "Onboarding",
      description: null,
      status: "in_progress",
      leadAgentId: null,
      targetDate: null,
      color: null,
      pauseReason: null,
      pausedAt: null,
      executionWorkspacePolicy: null,
      codebase: {
        workspaceId: null,
        repoUrl: null,
        repoRef: null,
        defaultRef: null,
        repoName: null,
        localFolder: null,
        managedFolder: "/tmp/company-1/project-1",
        effectiveLocalFolder: "/tmp/company-1/project-1",
        origin: "managed_checkout",
      },
      workspaces: [],
      primaryWorkspace: null,
      archivedAt: null,
      createdAt: new Date("2026-03-20T00:00:00Z"),
      updatedAt: new Date("2026-03-20T00:00:00Z"),
    }),
    listByIds: vi.fn().mockResolvedValue([]),
  };
  const goalService = {
    getById: vi.fn().mockImplementation(async (id: string) =>
      id === projectGoal.id ? projectGoal : null,
    ),
    getDefaultCompanyGoal: vi.fn().mockResolvedValue(null),
  };

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
  app.use("/api", issueRoutes({} as any, {} as any, {
    services: {
      accessService: {
        canUser: vi.fn(),
        hasPermission: vi.fn(),
      } as any,
      agentService: {
        getById: vi.fn(async (id: string) =>
          id === legacyProjectLinkedIssue.assigneeAgentId
            ? {
                id,
                companyId: "company-1",
                name: "Productivity Monitor",
                role: "general",
                archetypeKey: "productivity_monitor",
              }
            : null),
      } as any,
      documentService: {
        getIssueDocumentPayload: vi.fn(async () => ({})),
        getIssueDocumentByKey: vi.fn(async () => null),
      } as any,
      executionWorkspaceService: {
        getById: vi.fn(),
      } as any,
      feedbackService: {
        listIssueVotesForUser: vi.fn(async () => []),
        saveIssueVote: vi.fn(async () => ({
          vote: null,
          consentEnabledNow: false,
          sharingEnabled: false,
        })),
      } as any,
      goalService: goalService as any,
      heartbeatService: {
        wakeup: vi.fn(async () => undefined),
        reportRunActivity: vi.fn(async () => undefined),
      } as any,
      instanceSettingsService: {
        get: vi.fn(async () => ({
          id: "instance-settings-1",
          general: {
            censorUsernameInLogs: false,
            feedbackDataSharingPreference: "prompt",
          },
        })),
        listCompanyIds: vi.fn(async () => ["company-1"]),
      } as any,
      issueContinuityService: {
        getIssueContinuity: vi.fn(async () => buildContinuityResponse(options?.continuity)),
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
      issueApprovalService: {} as any,
      issueReferenceService: {
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
      } as any,
      issueService: issueService as any,
      logActivity: vi.fn(async () => undefined),
      productivityService: {
        companySummary: vi.fn(async () => ({
          companyId: "company-1",
          window: "7d",
          generatedAt: "2026-04-24T20:00:00.000Z",
          from: null,
          totals: {
            runCount: 10,
            terminalRunCount: 8,
            usefulRunCount: 4,
            completedRunCount: 1,
            blockedRunCount: 0,
            lowYieldRunCount: 2,
            planOnlyRunCount: 1,
            emptyResponseRunCount: 0,
            needsFollowupRunCount: 1,
            failedRunCount: 0,
            continuationExhaustionCount: 0,
            completedIssueCount: 1,
            inputTokens: 0,
            cachedInputTokens: 0,
            cacheCreationInputTokens: 0,
            outputTokens: 0,
            totalTokens: 1_250_000,
            costCents: 0,
            estimatedApiCostCents: 0,
            durationMs: 0,
            timeToFirstUsefulActionMs: 180_000,
          },
          ratios: {
            usefulRunRate: 0.5,
            lowYieldRunRate: 0.25,
            tokensPerUsefulRun: 312_500,
            tokensPerCompletedIssue: 1_250_000,
            avgRunDurationMs: null,
            avgTimeToFirstUsefulActionMs: 180_000,
          },
          agents: [{
            agentId: "33333333-3333-4333-8333-333333333333",
            agentName: "Productivity Monitor",
            agentStatus: "active",
            adapterType: "codex_local",
            role: "general",
            archetypeKey: "productivity_monitor",
            health: "watch",
            totals: {
              runCount: 2,
              terminalRunCount: 2,
              usefulRunCount: 1,
              completedRunCount: 0,
              blockedRunCount: 0,
              lowYieldRunCount: 1,
              planOnlyRunCount: 1,
              emptyResponseRunCount: 0,
              needsFollowupRunCount: 0,
              failedRunCount: 0,
              continuationExhaustionCount: 0,
              completedIssueCount: 0,
              inputTokens: 0,
              cachedInputTokens: 0,
              cacheCreationInputTokens: 0,
              outputTokens: 0,
              totalTokens: 500_000,
              costCents: 0,
              estimatedApiCostCents: 0,
              durationMs: 0,
              timeToFirstUsefulActionMs: 180_000,
            },
            ratios: {
              usefulRunRate: 0.5,
              lowYieldRunRate: 0.5,
              tokensPerUsefulRun: 500_000,
              tokensPerCompletedIssue: null,
              avgRunDurationMs: null,
              avgTimeToFirstUsefulActionMs: 180_000,
            },
            lowYieldRuns: [],
          }],
          lowYieldRuns: [{
            runId: "run-1",
            agentId: "agent-1",
            agentName: "QA",
            issueId: "issue-10",
            issueIdentifier: "PAP-10",
            issueTitle: "Overplanned fix",
            projectId: null,
            projectName: null,
            status: "succeeded",
            livenessState: "plan_only",
            livenessReason: "Plan only",
            continuationAttempt: 0,
            startedAt: "2026-04-24T19:00:00.000Z",
            finishedAt: "2026-04-24T19:03:00.000Z",
            durationMs: 180_000,
            totalTokens: 80_000,
            estimatedApiCostCents: 0,
            nextAction: "Reduce QA ceremony.",
          }],
          recommendations: ["Check low-yield agents first."],
        })),
      } as any,
      projectService: projectService as any,
      routineService: {
        syncRunStatusForIssue: vi.fn(async () => undefined),
      } as any,
      workProductService: {
        listForIssue: vi.fn(async () => []),
      } as any,
      conferenceContextService: {
        getIssueConferenceContext: vi.fn(async () => null),
      } as any,
    },
  }));
  app.use(errorHandler);

  return { app, goalService, issueService };
}

describe("issue goal context routes", () => {
  it("surfaces the project goal from GET /issues/:id when the issue has no direct goal", async () => {
    const { app, goalService } = await createHarness();
    const res = await request(app).get("/api/issues/11111111-1111-4111-8111-111111111111");

    expect(res.status).toBe(200);
    expect(res.body.goalId).toBe(projectGoal.id);
    expect(res.body.goal).toEqual(
      expect.objectContaining({
        id: projectGoal.id,
        title: projectGoal.title,
      }),
    );
    expect(goalService.getDefaultCompanyGoal).not.toHaveBeenCalled();
  });

  it("surfaces the project goal from GET /issues/:id/heartbeat-context", async () => {
    const { app, goalService } = await createHarness();
    const res = await request(app).get(
      "/api/issues/11111111-1111-4111-8111-111111111111/heartbeat-context",
    );

    expect(res.status).toBe(200);
    expect(res.body.issue.goalId).toBe(projectGoal.id);
    expect(res.body.goal).toEqual(
      expect.objectContaining({
        id: projectGoal.id,
        title: projectGoal.title,
      }),
    );
    expect(goalService.getDefaultCompanyGoal).not.toHaveBeenCalled();
    expect(res.body.attachments).toEqual([]);
    expect(res.body.mode).toBe("planning");
    expect(res.body.planningMode).toBe(true);
  });

  it("injects a read-only productivity report packet for assigned Productivity Monitor issues", async () => {
    const { app, issueService } = await createHarness();
    issueService.getById.mockResolvedValue({
      ...legacyProjectLinkedIssue,
      title: "Monitor productivity",
    });

    const res = await request(app).get(
      "/api/issues/11111111-1111-4111-8111-111111111111/heartbeat-context",
    );

    expect(res.status).toBe(200);
    expect(res.body.productivityReport).toEqual(expect.objectContaining({
      kind: "paperclip/productivity-report.v1",
      scope: "company",
      window: "7d",
    }));
    expect(res.body.productivityReport.totals).toMatchObject({
      terminalRunCount: 8,
      usefulRunCount: 4,
      lowYieldRunCount: 2,
    });
    expect(res.body.productivityReport.lowYieldRuns).toHaveLength(1);
    expect(res.body.productivityReport.agents[0]).toMatchObject({
      agentName: "Productivity Monitor",
      health: "watch",
    });
  });

  it("does not inject productivity reports for non-monitor assignees", async () => {
    const { app } = await createHarness({
      issue: {
        ...legacyProjectLinkedIssue,
        assigneeAgentId: null,
      },
    });

    const res = await request(app).get(
      "/api/issues/11111111-1111-4111-8111-111111111111/heartbeat-context",
    );

    expect(res.status).toBe(200);
    expect(res.body.productivityReport).toBeNull();
  });

  it("surfaces blocker summaries on GET /issues/:id/heartbeat-context", async () => {
    const { app, issueService } = await createHarness();
    issueService.getRelationSummaries.mockResolvedValue({
      blockedBy: [
        {
          id: "55555555-5555-4555-8555-555555555555",
          identifier: "PAP-580",
          title: "Finish wakeup plumbing",
          status: "done",
          priority: "medium",
          assigneeAgentId: null,
          assigneeUserId: null,
        },
      ],
      blocks: [],
    });

    const res = await request(app).get(
      "/api/issues/11111111-1111-4111-8111-111111111111/heartbeat-context",
    );

    expect(res.status).toBe(200);
    expect(res.body.issue.blockedBy).toEqual([
      expect.objectContaining({
        id: "55555555-5555-4555-8555-555555555555",
        identifier: "PAP-580",
        title: "Finish wakeup plumbing",
        status: "done",
      }),
    ]);
  });

  it("keeps pre-execution issues in planning mode even after checkout flipped the issue to in_progress", async () => {
    const { app, issueService } = await createHarness();
    issueService.getById.mockResolvedValue({
      ...legacyProjectLinkedIssue,
      status: "in_progress",
    });

    const res = await request(app).get(
      "/api/issues/11111111-1111-4111-8111-111111111111/heartbeat-context",
    );

    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("planning");
    expect(res.body.planningMode).toBe(true);
    expect(res.body.continuityStatus).toBe("ready");
  });

  it("surfaces approval mode for plan approval waits", async () => {
    const { app } = await createHarness({
      continuity: {
        continuityStatus: "awaiting_decision",
        planApprovalStatus: "pending",
        planApprovalRequiresApproval: true,
      },
    });
    const res = await request(app).get(
      "/api/issues/11111111-1111-4111-8111-111111111111/heartbeat-context",
    );

    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("approval");
    expect(res.body.planningMode).toBe(false);
    expect(res.body.planApproval).toEqual(
      expect.objectContaining({
        status: "pending",
        requiresApproval: true,
      }),
    );
  });

  it("surfaces review mode from execution review stages", async () => {
    const { app } = await createHarness({
      issue: { ...legacyProjectLinkedIssue, status: "in_review" },
      continuity: {
        continuityStatus: "active",
        executionState: {
          status: "pending",
          currentStageId: "stage-1",
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: "reviewer-1" },
          returnAssignee: { type: "agent", agentId: "author-1" },
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
        },
      },
    });
    const res = await request(app).get(
      "/api/issues/11111111-1111-4111-8111-111111111111/heartbeat-context",
    );

    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("review");
    expect(res.body.executionStage).toEqual(
      expect.objectContaining({
        stageId: "stage-1",
        stageType: "review",
      }),
    );
  });
});
