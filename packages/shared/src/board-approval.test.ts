import { describe, expect, it } from "vitest";
import {
  normalizeRequestBoardApprovalPayload,
  requestBoardApprovalPayloadSchema,
} from "./validators/approval.js";

describe("requestBoardApprovalPayloadSchema", () => {
  it("normalizes the canonical board approval payload", () => {
    expect(
      normalizeRequestBoardApprovalPayload({
        title: "  Approve board room rollout  ",
        summary: "  Pilot the board room on issue detail first. ",
        roomTitle: "  Migration Readiness Council  ",
        agenda: "  Review blockers, risks, and the staged rollout plan. ",
        recommendedAction: " Launch board room v2 ",
        nextActionOnApproval: " Implement inline board comments ",
        risks: " Extra review overhead \n\n Adoption confusion ",
        proposedComment: "  Approved for a narrow pilot. ",
        participantAgentIds: ["agent-2", " agent-1 ", "", "agent-2"],
      }),
    ).toEqual({
      title: "Approve board room rollout",
      summary: "Pilot the board room on issue detail first.",
      roomTitle: "Migration Readiness Council",
      agenda: "Review blockers, risks, and the staged rollout plan.",
      recommendedAction: "Launch board room v2",
      nextActionOnApproval: "Implement inline board comments",
      risks: ["Extra review overhead", "Adoption confusion"],
      proposedComment: "Approved for a narrow pilot.",
      participantAgentIds: ["agent-2", "agent-1"],
      decisionTier: "board",
      roomKind: "issue_board_room",
    });
  });

  it("rejects missing required fields", () => {
    expect(() =>
      requestBoardApprovalPayloadSchema.parse({
        title: "Only a title",
        summary: "   ",
      }),
    ).toThrow(/summary/i);
  });
});
