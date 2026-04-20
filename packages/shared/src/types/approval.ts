import type { ApprovalStatus, ApprovalType } from "../constants.js";
import type { ConferenceContext } from "./conference-context.js";

type BaseRequestBoardApprovalPayload = Record<string, unknown> & {
  title: string;
  summary: string;
  recommendedAction?: string;
  nextActionOnApproval?: string;
  risks?: string[];
  proposedComment?: string;
  repoContext?: ConferenceContext;
  decisionTier: "board";
};

export type LegacyIssueBoardRoomApprovalPayload = BaseRequestBoardApprovalPayload & {
  roomTitle?: string;
  agenda?: string;
  participantAgentIds?: string[];
  roomKind: "issue_board_room";
};

export type CompanyConferenceRoomApprovalPayload = BaseRequestBoardApprovalPayload & {
  conferenceRoomId: string;
  roomKind: "company_conference_room";
};

export type IssuePlanApprovalPayload = BaseRequestBoardApprovalPayload & {
  kind: "issue_plan_approval";
  issueId: string;
  identifier?: string | null;
  issueTitle: string;
  planRevisionId: string;
  specRevisionId?: string | null;
  testPlanRevisionId?: string | null;
};

export type RequestBoardApprovalPayload =
  | LegacyIssueBoardRoomApprovalPayload
  | CompanyConferenceRoomApprovalPayload
  | IssuePlanApprovalPayload;

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
