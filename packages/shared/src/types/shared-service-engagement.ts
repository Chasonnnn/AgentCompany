import type { SharedServiceEngagementStatus } from "../constants.js";

export interface SharedServiceEngagementAssignment {
  id: string;
  companyId: string;
  engagementId: string;
  agentId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface SharedServiceEngagement {
  id: string;
  companyId: string;
  targetProjectId: string;
  serviceAreaKey: string;
  serviceAreaLabel: string;
  title: string;
  summary: string;
  status: SharedServiceEngagementStatus;
  requestedByAgentId: string | null;
  requestedByUserId: string | null;
  approvedByAgentId: string | null;
  approvedByUserId: string | null;
  closedByAgentId: string | null;
  closedByUserId: string | null;
  approvedAt: Date | null;
  closedAt: Date | null;
  outcomeSummary: string | null;
  metadata: Record<string, unknown> | null;
  assignments: SharedServiceEngagementAssignment[];
  createdAt: Date;
  updatedAt: Date;
}

export interface SharedServiceEngagementCreateRequest {
  targetProjectId: string;
  serviceAreaKey: string;
  serviceAreaLabel?: string | null;
  title: string;
  summary: string;
  assignedAgentIds?: string[];
  metadata?: Record<string, unknown> | null;
}

export interface SharedServiceEngagementUpdateRequest {
  serviceAreaKey?: string;
  serviceAreaLabel?: string | null;
  title?: string;
  summary?: string;
  assignedAgentIds?: string[];
  outcomeSummary?: string | null;
  metadata?: Record<string, unknown> | null;
}
