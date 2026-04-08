import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildHostServices } from "../services/plugin-host-services.js";

const mockIssueGetById = vi.hoisted(() => vi.fn());
const mockApprovalCreate = vi.hoisted(() => vi.fn());
const mockLinkManyForApproval = vi.hoisted(() => vi.fn());
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/issues.js", () => ({
  issueService: () => ({
    getById: mockIssueGetById,
  }),
}));

vi.mock("../services/approvals.js", () => ({
  approvalService: () => ({
    create: mockApprovalCreate,
  }),
}));

vi.mock("../services/issue-approvals.js", () => ({
  issueApprovalService: () => ({
    linkManyForApproval: mockLinkManyForApproval,
  }),
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
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
    mockApprovalCreate.mockResolvedValue({
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
    });
    mockLinkManyForApproval.mockResolvedValue(undefined);
    mockLogActivity.mockResolvedValue(undefined);
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
      },
    });

    expect(mockApprovalCreate).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        type: "request_board_approval",
        requestedByAgentId: "agent-1",
        requestedByUserId: null,
        status: "pending",
        decisionNote: null,
      }),
    );
    expect(mockLinkManyForApproval).toHaveBeenCalledWith(
      "approval-1",
      ["issue-1"],
      { agentId: "agent-1", userId: null },
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-1",
        actorType: "agent",
        actorId: "agent-1",
        action: "approval.created",
      }),
    );
    expect(approval.id).toBe("approval-1");
  });
});
