import type { AgentDepartmentKey, CompanyStatus, PauseReason } from "../constants.js";
import type { Agent } from "./agent.js";
import type { DocumentFormat } from "./issue.js";

export interface Company {
  id: string;
  name: string;
  description: string | null;
  status: CompanyStatus;
  pauseReason: PauseReason | null;
  pausedAt: Date | null;
  issuePrefix: string;
  issueCounter: number;
  budgetMonthlyCents: number;
  spentMonthlyCents: number;
  attachmentMaxBytes?: number;
  requireBoardApprovalForNewAgents: boolean;
  feedbackDataSharingEnabled: boolean;
  feedbackDataSharingConsentAt: Date | null;
  feedbackDataSharingConsentByUserId: string | null;
  feedbackDataSharingTermsVersion: string | null;
  brandColor: string | null;
  logoAssetId: string | null;
  logoUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CompanyDocumentSummary {
  id: string;
  companyId: string;
  key: string;
  title: string | null;
  format: DocumentFormat;
  latestRevisionId: string | null;
  latestRevisionNumber: number;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  updatedByAgentId: string | null;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CompanyDocument extends CompanyDocumentSummary {
  body: string;
}

export interface CompanyDocumentRevision {
  id: string;
  companyId: string;
  documentId: string;
  key: string;
  revisionNumber: number;
  title: string | null;
  format: DocumentFormat;
  body: string;
  changeSummary: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
}

export interface TeamDocumentSummary {
  id: string;
  companyId: string;
  departmentKey: AgentDepartmentKey;
  departmentName: string | null;
  key: string;
  title: string | null;
  format: DocumentFormat;
  latestRevisionId: string | null;
  latestRevisionNumber: number;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  updatedByAgentId: string | null;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TeamDocument extends TeamDocumentSummary {
  body: string;
}

export interface TeamDocumentRevision {
  id: string;
  companyId: string;
  documentId: string;
  departmentKey: AgentDepartmentKey;
  departmentName: string | null;
  key: string;
  revisionNumber: number;
  title: string | null;
  format: DocumentFormat;
  body: string;
  changeSummary: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
}

export interface CompanyOfficeOperatorAdoptionRequest {
  reparentProjectLeads?: boolean;
  seedFromAgentId?: string | null;
}

export interface CompanyOfficeOperatorAdoptionResult {
  officeOperator: Agent;
  created: boolean;
  reparentedProjectLeadIds: string[];
  managerId: string | null;
  seedFromAgentId: string | null;
}
