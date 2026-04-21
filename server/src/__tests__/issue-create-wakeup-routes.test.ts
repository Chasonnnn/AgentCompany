import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ASSIGNEE_AGENT_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
}));

const mockOfficeCoordinationService = vi.hoisted(() => ({
  findOfficeOperator: vi.fn(async () => null),
  buildWakeSnapshot: vi.fn(async () => ({
    companyId: "company-1",
    officeAgentId: "office-1",
    trigger: { reason: "issue_intake_created" },
    queueCounts: {
      untriagedIntake: 1,
      unassignedIssues: 0,
      blockedIssues: 0,
      staleIssues: 0,
      staffingGaps: 0,
      engagementsNeedingAttention: 0,
      sharedSkillItems: 0,
    },
    untriagedIntake: [],
    unassignedIssues: [],
    blockedIssues: [],
    staleIssues: [],
    staffingGaps: [],
    engagementsNeedingAttention: [],
    sharedSkillItems: [],
    recentActions: [],
  })),
}));

const mockIssueService = vi.hoisted(() => ({
  create: vi.fn(),
}));

const mockContinuityService = vi.hoisted(() => ({
  recomputeIssueContinuityState: vi.fn(),
  prepare: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(async () => null),
  resolvePrimaryProjectLeadForProject: vi.fn(async () => ({ agent: null, ambiguous: false })),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    canUser: vi.fn(async () => true),
    hasPermission: vi.fn(async () => true),
  }),
  agentService: () => mockAgentService,
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
  issueContinuityService: () => mockContinuityService,
  issueService: () => mockIssueService,
  logActivity: vi.fn(async () => undefined),
  officeCoordinationService: () => mockOfficeCoordinationService,
  projectService: () => ({}),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({}),
}));

async function createApp() {
  const { issueRoutes } = await import("../routes/issues.js");
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
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err?.status ?? 500).json({ error: err?.message ?? "Internal server error" });
  });
  return app;
}

function makeContinuityState(overrides: Record<string, unknown> = {}) {
  return {
    tier: "normal",
    status: "ready",
    health: "healthy",
    healthReason: null,
    healthDetails: [],
    requiredDocumentKeys: ["spec", "plan", "progress", "test-plan"],
    missingDocumentKeys: [],
    specState: "editable",
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
    ...overrides,
  };
}

describe("issue creation wakeups", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockAgentService.resolvePrimaryProjectLeadForProject.mockResolvedValue({ agent: null, ambiguous: false });
    mockOfficeCoordinationService.findOfficeOperator.mockResolvedValue(null);
    mockIssueService.create.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      title: "Architecture audit",
      identifier: "PAP-1",
      status: "todo",
      assigneeAgentId: ASSIGNEE_AGENT_ID,
      assigneeUserId: null,
      priority: "medium",
      projectId: null,
      goalId: null,
      parentId: null,
    });
    mockContinuityService.recomputeIssueContinuityState.mockResolvedValue(makeContinuityState());
    mockContinuityService.prepare.mockResolvedValue({
      continuityState: makeContinuityState({
        status: "ready",
        health: "healthy",
        lastPreparedAt: "2026-04-17T00:00:00.000Z",
      }),
      continuityBundle: {
        issueId: "issue-1",
      },
    });
  });

  it("prepares continuity before waking a newly assigned issue when requested", async () => {
    const res = await request(await createApp()).post("/api/companies/company-1/issues").send({
      title: "Architecture audit",
      assigneeAgentId: ASSIGNEE_AGENT_ID,
      status: "todo",
      continuityTier: "normal",
      prepareContinuity: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(res.status).toBe(201);
    expect(mockContinuityService.prepare).toHaveBeenCalledWith(
      "issue-1",
      { tier: "normal" },
      expect.objectContaining({
        userId: "local-board",
      }),
    );
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({
        reason: "issue_assigned",
        payload: expect.objectContaining({
          issueId: "issue-1",
          mutation: "create",
        }),
      }),
    );
  });

  it("does not wake a newly assigned issue when continuity is still blocked", async () => {
    mockContinuityService.recomputeIssueContinuityState.mockResolvedValue(
      makeContinuityState({
        status: "blocked_missing_docs",
        health: "missing_required_docs",
        missingDocumentKeys: ["spec", "plan", "progress", "test-plan"],
      }),
    );

    const res = await request(await createApp()).post("/api/companies/company-1/issues").send({
      title: "Architecture audit",
      assigneeAgentId: ASSIGNEE_AGENT_ID,
      status: "todo",
      continuityTier: "normal",
      prepareContinuity: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(res.status).toBe(201);
    expect(mockContinuityService.prepare).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("defaults a project-scoped issue to the project lead when no office operator exists", async () => {
    mockAgentService.resolvePrimaryProjectLeadForProject.mockResolvedValue({
      agent: { id: ASSIGNEE_AGENT_ID },
      ambiguous: false,
    });

    const res = await request(await createApp()).post("/api/companies/company-1/issues").send({
      title: "Architecture audit",
      projectId: PROJECT_ID,
      status: "todo",
      continuityTier: "normal",
      prepareContinuity: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(res.status).toBe(201);
    expect(mockAgentService.resolvePrimaryProjectLeadForProject).toHaveBeenCalledWith("company-1", PROJECT_ID);
    expect(mockIssueService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        projectId: PROJECT_ID,
        assigneeAgentId: ASSIGNEE_AGENT_ID,
      }),
    );
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({
        reason: "issue_assigned",
      }),
    );
  });

  it("leaves project-scoped intake unassigned and wakes the office operator when one exists", async () => {
    mockOfficeCoordinationService.findOfficeOperator.mockResolvedValue({
      id: "office-1",
      companyId: "company-1",
      role: "coo",
      archetypeKey: "chief_of_staff",
      status: "idle",
    });
    mockIssueService.create.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      title: "Architecture audit",
      identifier: "PAP-1",
      status: "todo",
      assigneeAgentId: null,
      assigneeUserId: null,
      priority: "medium",
      projectId: PROJECT_ID,
      goalId: null,
      parentId: null,
    });

    const res = await request(await createApp()).post("/api/companies/company-1/issues").send({
      title: "Architecture audit",
      projectId: PROJECT_ID,
      status: "todo",
      continuityTier: "normal",
      prepareContinuity: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(res.status).toBe(201);
    expect(mockAgentService.resolvePrimaryProjectLeadForProject).not.toHaveBeenCalled();
    expect(mockIssueService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        projectId: PROJECT_ID,
        assigneeAgentId: null,
      }),
    );
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "office-1",
      expect.objectContaining({
        reason: "office_coordination_requested",
        contextSnapshot: expect.objectContaining({
          paperclipOfficeCoordination: expect.objectContaining({
            officeAgentId: "office-1",
          }),
        }),
      }),
    );
  });
});
