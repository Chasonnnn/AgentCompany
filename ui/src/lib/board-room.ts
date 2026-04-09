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
    roomTitle: "",
    agenda: "",
    recommendedAction: "",
    nextActionOnApproval: "",
    risks: "",
    proposedComment: "",
    participantAgentIds: [],
  };
}

export function normalizeBoardRoomRequestPayload(draft: BoardRoomRequestDraft) {
  return normalizeRequestBoardApprovalPayload(draft);
}

export function isBoardRoomApproval(approval: Pick<Approval, "type">) {
  return approval.type === "request_board_approval";
}

function nonEmptyText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function boardRoomRoomTitle(payload: Record<string, unknown> | null | undefined) {
  return nonEmptyText(payload?.roomTitle);
}

export function boardRoomAgenda(payload: Record<string, unknown> | null | undefined) {
  return nonEmptyText(payload?.agenda);
}

export function boardRoomParticipantAgentIds(payload: Record<string, unknown> | null | undefined) {
  if (!Array.isArray(payload?.participantAgentIds)) return [];
  return Array.from(new Set(
    payload.participantAgentIds
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean),
  ));
}
