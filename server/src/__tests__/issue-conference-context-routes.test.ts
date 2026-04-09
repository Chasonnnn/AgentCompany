import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
  getAncestors: vi.fn(),
  getRelationSummaries: vi.fn(),
  findMentionedProjectIds: vi.fn(),
  getCommentCursor: vi.fn(),
  getComment: vi.fn(),
  listAttachments: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  listApprovalsForIssue: vi.fn(),
  link: vi.fn(),
  unlink: vi.fn(),
}));

const mockResolveConferenceContext = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
  }),
  agentService: () => ({
    getById: vi.fn(),
  }),
  documentService: () => ({
    getIssueDocumentPayload: vi.fn(async () => ({})),
  }),
  executionWorkspaceService: () => ({
    getById: vi.fn(),
  }),
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(async () => []),
    saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
  }),
  goalService: () => ({
    getById: vi.fn(async () => null),
    getDefaultCompanyGoal: vi.fn(async () => null),
  }),
  heartbeatService: () => ({
    wakeup: vi.fn(async () => undefined),
    reportRunActivity: vi.fn(async () => undefined),
  }),
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
  issueApprovalService: () => mockIssueApprovalService,
  issueService: () => mockIssueService,
  logActivity: vi.fn(async () => undefined),
  projectService: () => ({
    getById: vi.fn(async () => null),
    listByIds: vi.fn(async () => []),
  }),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({
    listForIssue: vi.fn(async () => []),
  }),
}));

vi.mock("../services/conference-context.js", async () => {
  const actual = await vi.importActual<typeof import("../services/conference-context.js")>(
    "../services/conference-context.js",
  );
  return {
    ...actual,
    conferenceContextService: () => ({
      resolveForIssueRecord: mockResolveConferenceContext,
      resolveForIssue: vi.fn(),
    }),
  };
});

function createBoardApp() {
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

function createAgentApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "api_key",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

function createContext() {
  return {
    capturedAt: "2026-04-08T12:00:00.000Z",
    projectWorkspace: null,
    executionWorkspace: null,
    git: {
      rootPath: "/Users/chason/paperclip",
      workspacePath: "/Users/chason/paperclip/worktrees/issue-1",
      displayRootPath: "paperclip",
      displayWorkspacePath: "paperclip/worktrees/issue-1",
      branchName: "codex/conference-context",
      baseRef: "origin/main",
      isGit: true,
      dirty: true,
      dirtyEntryCount: 1,
      untrackedEntryCount: 0,
      aheadCount: 1,
      behindCount: 0,
      changedFileCount: 1,
      truncated: false,
      changedFiles: [
        {
          path: "server/src/routes/issues.ts",
          previousPath: null,
          indexStatus: "M",
          worktreeStatus: " ",
          status: "M ",
        },
      ],
    },
  };
}

function createApproval() {
  return {
    id: "approval-1",
    companyId: "company-1",
    type: "request_board_approval",
    requestedByAgentId: "agent-1",
    requestedByUserId: null,
    status: "pending",
    payload: {
      title: "Approve conference context rollout",
      summary: "Need board signoff.",
      decisionTier: "board",
      roomKind: "issue_board_room",
      repoContext: createContext(),
    },
    decisionNote: null,
    decidedByUserId: null,
    decidedAt: null,
    createdAt: new Date("2026-04-08T00:00:00.000Z"),
    updatedAt: new Date("2026-04-08T00:00:00.000Z"),
  };
}

describe("issue conference context routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      projectId: null,
      issueNumber: 1,
      identifier: "PAP-1",
      title: "Test issue",
      description: null,
      status: "todo",
      priority: "medium",
      assigneeAgentId: null,
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      goalId: null,
      parentId: null,
      projectWorkspaceId: null,
      executionWorkspaceId: null,
      requestDepth: 0,
      billingCode: null,
      startedAt: null,
      completedAt: null,
      cancelledAt: null,
      createdAt: new Date("2026-04-08T00:00:00.000Z"),
      updatedAt: new Date("2026-04-08T00:00:00.000Z"),
    });
    mockIssueService.getByIdentifier.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
    });
    mockIssueService.getAncestors.mockResolvedValue([]);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.findMentionedProjectIds.mockResolvedValue([]);
    mockIssueService.getCommentCursor.mockResolvedValue({
      totalComments: 0,
      latestCommentId: null,
      latestCommentAt: null,
    });
    mockIssueService.getComment.mockResolvedValue(null);
    mockIssueService.listAttachments.mockResolvedValue([]);
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([createApproval()]);
    mockResolveConferenceContext.mockResolvedValue(createContext());
  });

  it("keeps raw repo paths for board callers on GET /issues/:id/conference-context", async () => {
    const res = await request(createBoardApp()).get("/api/issues/issue-1/conference-context");

    expect(res.status).toBe(200);
    expect(res.body.git.rootPath).toBe("/Users/chason/paperclip");
    expect(res.body.git.workspacePath).toBe("/Users/chason/paperclip/worktrees/issue-1");
  });

  it("sanitizes raw repo paths for agent callers on GET /issues/:id/conference-context", async () => {
    const res = await request(createAgentApp()).get("/api/issues/issue-1/conference-context");

    expect(res.status).toBe(200);
    expect(res.body.git.rootPath).toBeNull();
    expect(res.body.git.workspacePath).toBeNull();
    expect(res.body.git.displayWorkspacePath).toBe("paperclip/worktrees/issue-1");
  });

  it("sanitizes approval repo paths for agent callers on GET /issues/:id/approvals", async () => {
    const res = await request(createAgentApp()).get("/api/issues/issue-1/approvals");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]?.payload?.repoContext?.git?.rootPath).toBeNull();
    expect(res.body[0]?.payload?.repoContext?.git?.workspacePath).toBeNull();
    expect(res.body[0]?.payload?.repoContext?.git?.displayWorkspacePath).toBe(
      "paperclip/worktrees/issue-1",
    );
  });
});
