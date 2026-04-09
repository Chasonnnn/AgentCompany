import type { Approval } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import {
  isBoardRoomApproval,
  normalizeBoardRoomRequestPayload,
} from "./board-room";

describe("board room helpers", () => {
  it("normalizes structured board-room payloads", () => {
    expect(
      normalizeBoardRoomRequestPayload({
        title: "  Approve conference-room rollout  ",
        summary: "  We should pilot the board room on issue detail first. ",
        roomTitle: "  Launch Council  ",
        agenda: "  Decide the rollout shape and invite the right leads. ",
        recommendedAction: " Launch board room v1 ",
        nextActionOnApproval: " Implement the issue-level board room tab ",
        risks: "  Adds one more review surface \n\n Could slow approvals if overused ",
        proposedComment: "  Approved for the issue-level pilot. ",
        participantAgentIds: ["agent-1", " agent-2 ", "agent-1"],
      }),
    ).toEqual({
      title: "Approve conference-room rollout",
      summary: "We should pilot the board room on issue detail first.",
      roomTitle: "Launch Council",
      agenda: "Decide the rollout shape and invite the right leads.",
      recommendedAction: "Launch board room v1",
      nextActionOnApproval: "Implement the issue-level board room tab",
      risks: [
        "Adds one more review surface",
        "Could slow approvals if overused",
      ],
      proposedComment: "Approved for the issue-level pilot.",
      participantAgentIds: ["agent-1", "agent-2"],
      decisionTier: "board",
      roomKind: "issue_board_room",
    });
  });

  it("identifies board-room approvals from linked issue approvals", () => {
    const boardApproval = {
      id: "approval-board",
      companyId: "company-1",
      type: "request_board_approval",
      requestedByAgentId: null,
      requestedByUserId: "user-1",
      status: "pending",
      payload: {},
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      createdAt: new Date("2026-04-07T00:00:00.000Z"),
      updatedAt: new Date("2026-04-07T00:00:00.000Z"),
    } satisfies Approval;
    const nonBoardApproval = {
      ...boardApproval,
      id: "approval-budget",
      type: "budget_override_required",
    } satisfies Approval;

    expect(isBoardRoomApproval(boardApproval)).toBe(true);
    expect(isBoardRoomApproval(nonBoardApproval)).toBe(false);
  });
});
