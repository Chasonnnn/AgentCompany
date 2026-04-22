import type {
  CompanySkillCompatibility,
  CompanySkillFileInventoryEntry,
  SkillVerificationMetadata,
  CompanySkillTrustLevel,
  GlobalSkillCatalogSourceRoot,
} from "./company-skill.js";

export type SharedSkillMirrorState = "pristine" | "paperclip_modified" | "source_missing" | "source_unreadable";
export type SharedSkillSourceDriftState =
  | "in_sync"
  | "upstream_update_available"
  | "diverged_needs_review"
  | "source_missing"
  | "source_unreadable";
export type SharedSkillProposalKind = "self_improvement" | "upstream_adoption" | "merge_review";
export type SharedSkillProposalStatus = "pending" | "revision_requested" | "approved" | "rejected" | "superseded";
export type SharedSkillProposalChangeOp = "patch_text" | "replace_file" | "write_file" | "remove_file";
export type SharedSkillMirrorSyncMode = "bootstrap" | "refresh";

export interface SharedSkill {
  id: string;
  key: string;
  slug: string;
  name: string;
  description: string | null;
  markdown: string;
  fileInventory: CompanySkillFileInventoryEntry[];
  trustLevel: CompanySkillTrustLevel;
  compatibility: CompanySkillCompatibility;
  sourceRoot: GlobalSkillCatalogSourceRoot;
  sourcePath: string;
  sourceDigest: string | null;
  lastMirroredSourceDigest: string | null;
  mirrorDigest: string | null;
  lastAppliedMirrorDigest: string | null;
  mirrorState: SharedSkillMirrorState;
  sourceDriftState: SharedSkillSourceDriftState;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SharedSkillProposalChange {
  path: string;
  op: SharedSkillProposalChangeOp;
  oldText?: string;
  newText?: string;
  content?: string;
}

export interface SharedSkillProposalEvidence {
  issueId?: string;
  runId?: string;
  note?: string;
  failureFingerprint?: string;
  reproductionSummary?: string;
}

export interface SharedSkillProposalVerificationResults {
  passedUnitCommands: string[];
  passedIntegrationCommands: string[];
  passedPromptfooCaseIds: string[];
  passedArchitectureScenarioIds: string[];
  completedSmokeChecklist: string[];
}

export interface SharedSkillProposalPayload {
  changes: SharedSkillProposalChange[];
  evidence: SharedSkillProposalEvidence;
  requiredVerification?: SkillVerificationMetadata | null;
  verificationResults?: SharedSkillProposalVerificationResults | null;
  upstreamDecision?: "adopt_source" | "preserve_local" | "merge_required";
}

export interface SharedSkillProposal {
  id: string;
  sharedSkillId: string;
  companyId: string | null;
  issueId: string | null;
  runId: string | null;
  proposedByAgentId: string | null;
  proposedByUserId: string | null;
  kind: SharedSkillProposalKind;
  status: SharedSkillProposalStatus;
  summary: string;
  rationale: string;
  baseMirrorDigest: string | null;
  baseSourceDigest: string | null;
  proposalFingerprint: string;
  payload: SharedSkillProposalPayload;
  decisionNote: string | null;
  decidedByUserId: string | null;
  decidedAt: Date | null;
  appliedMirrorDigest: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SharedSkillProposalComment {
  id: string;
  proposalId: string;
  authorAgentId: string | null;
  authorUserId: string | null;
  body: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface SharedSkillProposalSummary {
  id: string;
  kind: SharedSkillProposalKind;
  status: SharedSkillProposalStatus;
  summary: string;
  createdAt: string;
}

export interface SharedSkillRuntimeContext {
  sharedSkillId: string;
  key: string;
  name: string;
  mirrorState: SharedSkillMirrorState;
  sourceDriftState: SharedSkillSourceDriftState;
  proposalAllowed: boolean;
  applyAllowed: false;
  openProposal: SharedSkillProposalSummary | null;
}

export interface SharedSkillMirrorSyncRequest {
  mode: SharedSkillMirrorSyncMode;
  sourceRoots?: GlobalSkillCatalogSourceRoot[];
}

export interface SharedSkillMirrorSyncItem {
  sharedSkillId: string;
  key: string;
  name: string;
  sourceRoot: GlobalSkillCatalogSourceRoot;
  sourcePath: string;
  action: "bootstrapped" | "updated_pristine_mirror" | "classified_only" | "unchanged";
  mirrorState: SharedSkillMirrorState;
  sourceDriftState: SharedSkillSourceDriftState;
}

export interface SharedSkillMirrorSyncResult {
  mode: SharedSkillMirrorSyncMode;
  totalCount: number;
  bootstrappedCount: number;
  updatedCount: number;
  unchangedCount: number;
  classifiedCount: number;
  items: SharedSkillMirrorSyncItem[];
}

export interface SharedSkillProposalCreateRequest {
  kind: SharedSkillProposalKind;
  summary: string;
  rationale: string;
  baseMirrorDigest: string | null;
  baseSourceDigest: string | null;
  changes: SharedSkillProposalChange[];
  evidence: SharedSkillProposalEvidence;
  requiredVerification?: SkillVerificationMetadata | null;
  verificationResults?: SharedSkillProposalVerificationResults | null;
  upstreamDecision?: "adopt_source" | "preserve_local" | "merge_required";
}

export interface SharedSkillProposalDecisionRequest {
  decisionNote?: string | null;
}

export interface SharedSkillProposalVerificationUpdateRequest {
  passedUnitCommands?: string[];
  passedIntegrationCommands?: string[];
  passedPromptfooCaseIds?: string[];
  passedArchitectureScenarioIds?: string[];
  completedSmokeChecklist?: string[];
}

export interface SharedSkillProposalCommentCreateRequest {
  body: string;
}
