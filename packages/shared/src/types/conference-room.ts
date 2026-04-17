import type {
  ApprovalStatus,
  ConferenceRoomKind,
  ConferenceRoomMessageType,
  ConferenceRoomQuestionResponseStatus,
  ConferenceRoomStatus,
} from "../constants.js";

export interface ConferenceRoomIssueLinkSummary {
  issueId: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
  createdAt: Date;
}

export interface ConferenceRoomParticipant {
  id: string;
  companyId: string;
  conferenceRoomId: string;
  agentId: string;
  addedByAgentId: string | null;
  addedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConferenceRoomComment {
  id: string;
  companyId: string;
  conferenceRoomId: string;
  parentCommentId: string | null;
  authorAgentId: string | null;
  authorUserId: string | null;
  messageType: ConferenceRoomMessageType;
  body: string;
  responses: ConferenceRoomQuestionResponse[];
  createdAt: Date;
  updatedAt: Date;
}

export interface ConferenceRoomQuestionResponse {
  id: string;
  companyId: string;
  conferenceRoomId: string;
  questionCommentId: string;
  agentId: string;
  status: ConferenceRoomQuestionResponseStatus;
  repliedCommentId: string | null;
  latestWakeStatus?: string | null;
  latestWakeError?: string | null;
  latestWakeRequestedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConferenceRoomDecisionSummary {
  approvalId: string;
  status: ApprovalStatus;
  requestedByAgentId: string | null;
  requestedByUserId: string | null;
  title: string;
  summary: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConferenceRoom {
  id: string;
  companyId: string;
  title: string;
  summary: string;
  agenda: string | null;
  kind: ConferenceRoomKind | null;
  status: ConferenceRoomStatus;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  linkedIssues: ConferenceRoomIssueLinkSummary[];
  participants: ConferenceRoomParticipant[];
  decisions: ConferenceRoomDecisionSummary[];
  latestCommentAt: Date | null;
}
