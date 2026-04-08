import {
  normalizeRequestBoardApprovalPayload,
  type Approval,
  type RequestBoardApprovalPayloadInput,
} from "@paperclipai/shared";

export type BoardRoomRequestDraft = RequestBoardApprovalPayloadInput;

export function createBoardRoomRequestDraft(): BoardRoomRequestDraft {
  return {
    title: "",
    summary: "",
    recommendedAction: "",
    nextActionOnApproval: "",
    risks: "",
    proposedComment: "",
  };
}

export function normalizeBoardRoomRequestPayload(draft: BoardRoomRequestDraft) {
  return normalizeRequestBoardApprovalPayload(draft);
}

export function isBoardRoomApproval(approval: Pick<Approval, "type">) {
  return approval.type === "request_board_approval";
}
