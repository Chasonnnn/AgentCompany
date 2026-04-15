import type {
  IssueBranchRole,
  IssueBranchStatus,
  IssueContinuityHealth,
  IssueContinuityStatus,
  IssueContinuityTier,
  IssueExecutionDecisionOutcome,
  IssueExecutionPolicyMode,
  IssueExecutionStageType,
  IssueExecutionStateStatus,
  IssueOriginKind,
  IssuePriority,
  IssueSpecState,
  IssueStatus,
} from "../constants.js";
import type { Goal } from "./goal.js";
import type { Project, ProjectWorkspace } from "./project.js";
import type { ExecutionWorkspace, IssueExecutionWorkspaceSettings } from "./workspace-runtime.js";
import type { IssueWorkProduct } from "./work-product.js";

export interface IssueAncestorProject {
  id: string;
  name: string;
  description: string | null;
  status: string;
  goalId: string | null;
  workspaces: ProjectWorkspace[];
  primaryWorkspace: ProjectWorkspace | null;
}

export interface IssueAncestorGoal {
  id: string;
  title: string;
  description: string | null;
  level: string;
  status: string;
}

export interface IssueAncestor {
  id: string;
  identifier: string | null;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  projectId: string | null;
  goalId: string | null;
  project: IssueAncestorProject | null;
  goal: IssueAncestorGoal | null;
}

export interface IssueLabel {
  id: string;
  companyId: string;
  name: string;
  color: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IssueAssigneeAdapterOverrides {
  adapterConfig?: Record<string, unknown>;
  useProjectWorkspace?: boolean;
}

export type DocumentFormat = "markdown";

export interface IssueDocumentSummary {
  id: string;
  companyId: string;
  issueId: string;
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

export interface IssueDocument extends IssueDocumentSummary {
  body: string;
}

export interface DocumentRevision {
  id: string;
  companyId: string;
  documentId: string;
  issueId: string;
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

export interface LegacyPlanDocument {
  key: "plan";
  body: string;
  source: "issue_description";
}

export interface IssueRelationIssueSummary {
  id: string;
  identifier: string | null;
  title: string;
  status: IssueStatus;
  priority: IssuePriority;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
}

export interface IssueRelation {
  id: string;
  companyId: string;
  issueId: string;
  relatedIssueId: string;
  type: "blocks";
  relatedIssue: IssueRelationIssueSummary;
}

export interface IssueExecutionStagePrincipal {
  type: "agent" | "user";
  agentId?: string | null;
  userId?: string | null;
}

export interface IssueExecutionStageParticipant extends IssueExecutionStagePrincipal {
  id: string;
}

export interface IssueExecutionStage {
  id: string;
  type: IssueExecutionStageType;
  approvalsNeeded: 1;
  participants: IssueExecutionStageParticipant[];
}

export interface IssueExecutionPolicy {
  mode: IssueExecutionPolicyMode;
  commentRequired: boolean;
  stages: IssueExecutionStage[];
}

export interface IssueExecutionState {
  status: IssueExecutionStateStatus;
  currentStageId: string | null;
  currentStageIndex: number | null;
  currentStageType: IssueExecutionStageType | null;
  currentParticipant: IssueExecutionStagePrincipal | null;
  returnAssignee: IssueExecutionStagePrincipal | null;
  completedStageIds: string[];
  lastDecisionId: string | null;
  lastDecisionOutcome: IssueExecutionDecisionOutcome | null;
}

export interface IssueExecutionDecision {
  id: string;
  companyId: string;
  issueId: string;
  stageId: string;
  stageType: IssueExecutionStageType;
  actorAgentId: string | null;
  actorUserId: string | null;
  outcome: IssueExecutionDecisionOutcome;
  body: string;
  createdByRunId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IssueContinuityState {
  tier: IssueContinuityTier;
  status: IssueContinuityStatus;
  health: IssueContinuityHealth;
  healthReason?: string | null;
  healthDetails?: string[] | null;
  requiredDocumentKeys: string[];
  missingDocumentKeys: string[];
  specState: IssueSpecState;
  branchRole: IssueBranchRole;
  branchStatus: IssueBranchStatus;
  unresolvedBranchIssueIds: string[];
  returnedBranchIssueIds?: string[];
  openReviewFindingsRevisionId?: string | null;
  lastProgressAt: string | null;
  lastHandoffAt: string | null;
  lastReviewFindingsAt?: string | null;
  lastReviewReturnAt?: string | null;
  lastBranchReturnAt?: string | null;
  lastPreparedAt: string | null;
  lastBundleHash: string | null;
}

export interface IssueContinuityDocumentSnapshot {
  key: string;
  title: string | null;
  body: string;
  latestRevisionId: string | null;
  latestRevisionNumber: number;
  updatedAt: string;
}

export interface IssueContinuityBundle {
  issueId: string;
  generatedAt: string;
  bundleHash: string;
  continuityState: IssueContinuityState | null;
  executionState: IssueExecutionState | null;
  issueDocuments: {
    spec: IssueContinuityDocumentSnapshot | null;
    plan: IssueContinuityDocumentSnapshot | null;
    runbook: IssueContinuityDocumentSnapshot | null;
    progress: IssueContinuityDocumentSnapshot | null;
    "test-plan": IssueContinuityDocumentSnapshot | null;
    handoff: IssueContinuityDocumentSnapshot | null;
    "review-findings": IssueContinuityDocumentSnapshot | null;
    "branch-return": IssueContinuityDocumentSnapshot | null;
  };
  projectDocuments: {
    context: IssueContinuityDocumentSnapshot | null;
    runbook: IssueContinuityDocumentSnapshot | null;
  };
  referencedRevisionIds: Record<string, string | null>;
}

export type IssueContinuityRemediationActionId =
  | "prepare_execution"
  | "progress_checkpoint"
  | "handoff_repair"
  | "handoff_cancel"
  | "review_resubmit"
  | "branch_merge";

export type IssueContinuityRemediationActor =
  | "continuity_owner"
  | "active_gate_participant"
  | "branch_owner"
  | "board";

export interface IssueContinuityRemediationAction {
  id: IssueContinuityRemediationActionId;
  label: string;
  description: string;
  actor: IssueContinuityRemediationActor;
  eligible: boolean;
  blockedReason: string | null;
  targetIssueIds?: string[];
}

export interface IssueContinuityRemediation {
  suggestedActions: IssueContinuityRemediationAction[];
  blockedActions: IssueContinuityRemediationAction[];
}

export interface IssueBranchMergePreviewUpdate {
  documentKey: string;
  action: "append" | "replace";
  summary: string;
  content: string;
  title: string | null;
  existingParentRevisionId: string | null;
}

export interface IssueBranchMergePreview {
  branchIssueId: string;
  parentIssueId: string;
  canMerge: boolean;
  blockedReason: string | null;
  branchStatus: IssueBranchStatus;
  proposedUpdates: IssueBranchMergePreviewUpdate[];
  mergeChecklist: string[];
  unresolvedRisks: string[];
  openQuestions: string[];
  evidence: string[];
  returnedArtifacts: string[];
}

export interface Issue {
  id: string;
  companyId: string;
  projectId: string | null;
  projectWorkspaceId: string | null;
  goalId: string | null;
  parentId: string | null;
  ancestors?: IssueAncestor[];
  title: string;
  description: string | null;
  status: IssueStatus;
  priority: IssuePriority;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  checkoutRunId: string | null;
  executionRunId: string | null;
  executionAgentNameKey: string | null;
  executionLockedAt: Date | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  issueNumber: number | null;
  identifier: string | null;
  originKind?: IssueOriginKind;
  originId?: string | null;
  originRunId?: string | null;
  requestDepth: number;
  billingCode: string | null;
  assigneeAdapterOverrides: IssueAssigneeAdapterOverrides | null;
  executionPolicy?: IssueExecutionPolicy | null;
  executionState?: IssueExecutionState | null;
  continuityState?: IssueContinuityState | null;
  executionWorkspaceId: string | null;
  executionWorkspacePreference: string | null;
  executionWorkspaceSettings: IssueExecutionWorkspaceSettings | null;
  startedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  hiddenAt: Date | null;
  labelIds?: string[];
  labels?: IssueLabel[];
  blockedBy?: IssueRelationIssueSummary[];
  blocks?: IssueRelationIssueSummary[];
  planDocument?: IssueDocument | null;
  documentSummaries?: IssueDocumentSummary[];
  legacyPlanDocument?: LegacyPlanDocument | null;
  project?: Project | null;
  goal?: Goal | null;
  currentExecutionWorkspace?: ExecutionWorkspace | null;
  workProducts?: IssueWorkProduct[];
  mentionedProjects?: Project[];
  myLastTouchAt?: Date | null;
  lastExternalCommentAt?: Date | null;
  lastActivityAt?: Date | null;
  isUnreadForMe?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface IssueComment {
  id: string;
  companyId: string;
  issueId: string;
  authorAgentId: string | null;
  authorUserId: string | null;
  body: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IssueAttachment {
  id: string;
  companyId: string;
  issueId: string;
  issueCommentId: string | null;
  assetId: string;
  provider: string;
  objectKey: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  originalFilename: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  contentPath: string;
}
