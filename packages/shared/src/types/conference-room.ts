import type { ApprovalStatus, ConferenceRoomStatus } from "../constants.js";

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
  authorAgentId: string | null;
  authorUserId: string | null;
  body: string;
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
