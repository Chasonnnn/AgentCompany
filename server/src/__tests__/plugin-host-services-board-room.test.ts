import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildHostServices } from "../services/plugin-host-services.js";

const mockIssueGetById = vi.hoisted(() => vi.fn());
const mockConferenceApprovalCreate = vi.hoisted(() => vi.fn());
const mockSerializeApprovalForActor = vi.hoisted(() => vi.fn());

vi.mock("../services/issues.js", () => ({
  issueService: () => ({
    getById: mockIssueGetById,
  }),
}));

vi.mock("../services/conference-context.js", () => ({
  conferenceApprovalService: () => ({
    createRequestBoardApproval: mockConferenceApprovalCreate,
  }),
  serializeApprovalForActor: mockSerializeApprovalForActor,
}));

function createEventBusStub() {
  return {
    forPlugin() {
      return {
        emit: vi.fn(),
        subscribe: vi.fn(),
      };
    },
  } as any;
}

describe("buildHostServices issues.requestBoardApproval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueGetById.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
    });
    const approval = {
      id: "approval-1",
      companyId: "company-1",
      type: "request_board_approval",
      requestedByAgentId: "agent-1",
      requestedByUserId: null,
      status: "pending",
      payload: {
        title: "Approve spend",
        summary: "Need board signoff",
        decisionTier: "board",
        roomKind: "issue_board_room",
      },
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      createdAt: new Date("2026-04-08T00:00:00.000Z"),
      updatedAt: new Date("2026-04-08T00:00:00.000Z"),
    };
    mockConferenceApprovalCreate.mockResolvedValue(approval);
    mockSerializeApprovalForActor.mockImplementation((input: any) => ({
      ...input,
      payload: {
        ...input.payload,
        repoContext: {
          capturedAt: "2026-04-08T12:00:00.000Z",
          projectWorkspace: null,
          executionWorkspace: null,
          git: {
            rootPath: null,
            workspacePath: null,
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
            changedFiles: [],
          },
        },
      },
    }));
  });

  it("creates an agent-authored board approval linked to the issue", async () => {
    const services = buildHostServices(
      {} as never,
      "plugin-record-id",
      "acme.plugin",
      createEventBusStub(),
    );

    const approval = await services.issues.requestBoardApproval({
      issueId: "issue-1",
      companyId: "company-1",
      requestedByAgentId: "agent-1",
      payload: {
        title: " Approve spend ",
        summary: " Need board signoff ",
        roomTitle: " Spend Review ",
        agenda: " Review the overage and invite the right leads. ",
        participantAgentIds: ["agent-2", " agent-3 "],
      },
    });

    expect(mockConferenceApprovalCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-1",
        issueId: "issue-1",
        actorType: "agent",
        actorId: "agent-1",
        requestedByAgentId: "agent-1",
        requestedByUserId: null,
        payload: {
          title: " Approve spend ",
          summary: " Need board signoff ",
          roomTitle: " Spend Review ",
          agenda: " Review the overage and invite the right leads. ",
          participantAgentIds: ["agent-2", " agent-3 "],
        },
      }),
    );
    expect(mockSerializeApprovalForActor).toHaveBeenCalledWith(
      expect.objectContaining({ id: "approval-1" }),
      "agent",
    );
    expect(approval.id).toBe("approval-1");
    expect(approval.payload.repoContext.git.rootPath).toBeNull();
    expect(approval.payload.repoContext.git.displayWorkspacePath).toBe("paperclip/worktrees/issue-1");
  });
});
