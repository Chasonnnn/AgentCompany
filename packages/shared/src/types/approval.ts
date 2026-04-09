import type { ApprovalStatus, ApprovalType } from "../constants.js";
import type { ConferenceContext } from "./conference-context.js";

export type RequestBoardApprovalPayload = Record<string, unknown> & {
  title: string;
  summary: string;
  roomTitle?: string;
  agenda?: string;
  recommendedAction?: string;
  nextActionOnApproval?: string;
  risks?: string[];
  proposedComment?: string;
  participantAgentIds?: string[];
  repoContext?: ConferenceContext;
  decisionTier: "board";
  roomKind: "issue_board_room";
};

export interface Approval {
  id: string;
  companyId: string;
  type: ApprovalType;
  requestedByAgentId: string | null;
  requestedByUserId: string | null;
  status: ApprovalStatus;
  payload: Record<string, unknown>;
  decisionNote: string | null;
  decidedByUserId: string | null;
  decidedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApprovalComment {
  id: string;
  companyId: string;
  approvalId: string;
  authorAgentId: string | null;
  authorUserId: string | null;
  body: string;
  createdAt: Date;
  updatedAt: Date;
}
