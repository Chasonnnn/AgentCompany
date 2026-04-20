import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockApprovalService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  requestRevision: vi.fn(),
  resubmit: vi.fn(),
  listComments: vi.fn(),
  addComment: vi.fn(),
}));

const mockConferenceApprovalService = vi.hoisted(() => ({
  createRequestBoardApproval: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  listIssuesForApproval: vi.fn(),
  linkManyForApproval: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeHireApprovalPayloadForPersistence: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

async function createApp(actorOverrides: Record<string, unknown> = {}) {
  vi.doUnmock("../routes/approvals.js");
  vi.doUnmock("../middleware/index.js");
  vi.doUnmock("../services/index.js");
  vi.doMock("../services/index.js", () => ({
    approvalService: () => mockApprovalService,
    conferenceApprovalService: () => mockConferenceApprovalService,
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => mockIssueApprovalService,
    issueContinuityService: () => ({
      recomputeIssueContinuityState: vi.fn(async () => null),
    }),
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
  }));
  const [{ approvalRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/approvals.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
      ...actorOverrides,
    };
    next();
  });
  app.use("/api", approvalRoutes({} as any));
  app.use(errorHandler);
  return app;
}

async function createAgentApp() {
  vi.doUnmock("../routes/approvals.js");
  vi.doUnmock("../middleware/index.js");
  vi.doUnmock("../services/index.js");
  vi.doMock("../services/index.js", () => ({
    approvalService: () => mockApprovalService,
    conferenceApprovalService: () => mockConferenceApprovalService,
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => mockIssueApprovalService,
    issueContinuityService: () => ({
      recomputeIssueContinuityState: vi.fn(async () => null),
    }),
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
  }));
  const [{ approvalRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/approvals.js"),
    import("../middleware/index.js"),
  ]);
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
  app.use("/api", approvalRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("approval routes idempotent retries", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockHeartbeatService.wakeup.mockResolvedValue({ id: "wake-1" });
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([{ id: "issue-1" }]);
    mockLogActivity.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.doUnmock("../routes/approvals.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../services/index.js");
  });

  it("does not emit duplicate approval side effects when approve is already resolved", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-1",
      companyId: "company-1",
      type: "hire_agent",
      status: "approved",
      payload: {},
      requestedByAgentId: "agent-1",
    });
    mockApprovalService.approve.mockResolvedValue({
      approval: {
        id: "approval-1",
        companyId: "company-1",
        type: "hire_agent",
        status: "approved",
        payload: {},
        requestedByAgentId: "agent-1",
      },
      applied: false,
    });

    const res = await request(await createApp())
      .post("/api/approvals/approval-1/approve")
      .send({});

    expect(res.status).toBe(200);
    expect(mockIssueApprovalService.listIssuesForApproval).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("does not emit duplicate rejection logs when reject is already resolved", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-1",
      companyId: "company-1",
      type: "hire_agent",
      status: "rejected",
      payload: {},
    });
    mockApprovalService.reject.mockResolvedValue({
      approval: {
        id: "approval-1",
        companyId: "company-1",
        type: "hire_agent",
        status: "rejected",
        payload: {},
      },
      applied: false,
    });

    const res = await request(await createApp())
      .post("/api/approvals/approval-1/reject")
      .send({});

    expect(res.status).toBe(200);
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("rejects approval decisions for companies outside the caller scope", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-2",
      companyId: "company-2",
      type: "hire_agent",
      status: "pending",
      payload: {},
    });

    const res = await request(await createApp())
      .post("/api/approvals/approval-2/approve")
      .send({});

    expect(res.status).toBe(403);
    expect(mockApprovalService.approve).not.toHaveBeenCalled();
  });

  it("rejects approval revision requests for companies outside the caller scope", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-3",
      companyId: "company-2",
      type: "hire_agent",
      status: "pending",
      payload: {},
    });

    const res = await request(await createApp())
      .post("/api/approvals/approval-3/request-revision")
      .send({ decisionNote: "Need changes" });

    expect(res.status).toBe(403);
    expect(mockApprovalService.requestRevision).not.toHaveBeenCalled();
  });

  it("lets agents create generic issue-linked board approval requests", async () => {
    mockConferenceApprovalService.createRequestBoardApproval.mockResolvedValue({
      id: "approval-1",
      companyId: "company-1",
      type: "request_board_approval",
      requestedByAgentId: "agent-1",
      requestedByUserId: null,
      status: "pending",
      payload: {
        title: "Approve hosting spend",
        summary: "Need board signoff before increasing hosting spend.",
        decisionTier: "board",
        roomKind: "issue_board_room",
        repoContext: {
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
                path: "server/src/routes/approvals.ts",
                previousPath: null,
                indexStatus: "M",
                worktreeStatus: " ",
                status: "M ",
              },
            ],
          },
        },
      },
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      createdAt: new Date("2026-04-06T00:00:00.000Z"),
      updatedAt: new Date("2026-04-06T00:00:00.000Z"),
    });

    const res = await request(await createAgentApp())
      .post("/api/companies/company-1/approvals")
      .send({
        type: "request_board_approval",
        issueIds: ["00000000-0000-0000-0000-000000000001"],
        payload: {
          title: "Approve hosting spend",
          summary: "Need board signoff before increasing hosting spend.",
        },
      });

    expect(res.status).toBe(201);
    expect(mockConferenceApprovalService.createRequestBoardApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-1",
        issueId: "00000000-0000-0000-0000-000000000001",
        actorType: "agent",
        actorId: "agent-1",
        requestedByAgentId: "agent-1",
        requestedByUserId: null,
        payload: {
          title: "Approve hosting spend",
          summary: "Need board signoff before increasing hosting spend.",
        },
      }),
    );
    expect(mockApprovalService.create).not.toHaveBeenCalled();
    expect(mockSecretService.normalizeHireApprovalPayloadForPersistence).not.toHaveBeenCalled();
    expect(mockIssueApprovalService.linkManyForApproval).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
    expect(res.body.payload.repoContext.git.rootPath).toBeNull();
    expect(res.body.payload.repoContext.git.workspacePath).toBeNull();
    expect(res.body.payload.repoContext.git.displayWorkspacePath).toBe("paperclip/worktrees/issue-1");
  });
});
