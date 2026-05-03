import type {
  ApprovalStatus,
  IssueBranchRole,
  IssueBranchStatus,
  IssueContinuityHealth,
  IssueContinuityStatus,
  IssueContinuityTier,
  IssueDecisionQuestionStatus,
  IssueDecisionQuestionTarget,
  IssueExecutionDecisionOutcome,
  IssueExecutionPolicyMode,
  IssueExecutionStageType,
  IssueExecutionStateStatus,
  IssueOperatorState,
  IssueOriginKind,
  IssuePriority,
  IssueReferenceSourceKind,
  ModelProfileKey,
  IssueThreadInteractionContinuationPolicy,
  IssueThreadInteractionKind,
  IssueThreadInteractionStatus,
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
  projectId: string;
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
  modelProfile?: ModelProfileKey;
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

export interface IssueReferenceSource {
  kind: IssueReferenceSourceKind;
  sourceRecordId: string | null;
  label: string;
  matchedText: string | null;
}

export interface IssueRelatedWorkItem {
  issue: IssueRelationIssueSummary;
  mentionCount: number;
  sources: IssueReferenceSource[];
}

export interface IssueRelatedWorkSummary {
  outbound: IssueRelatedWorkItem[];
  inbound: IssueRelatedWorkItem[];
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

export interface IssueReviewRequest {
  instructions: string;
}

export interface IssueExecutionState {
  status: IssueExecutionStateStatus;
  currentStageId: string | null;
  currentStageIndex: number | null;
  currentStageType: IssueExecutionStageType | null;
  currentParticipant: IssueExecutionStagePrincipal | null;
  returnAssignee: IssueExecutionStagePrincipal | null;
  reviewRequest: IssueReviewRequest | null;
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

export interface IssueDecisionOption {
  key: string;
  label: string;
  description?: string | null;
}

export interface IssueDecisionAnswer {
  selectedOptionKey?: string | null;
  answer: string;
  note?: string | null;
}

export interface IssueDecisionQuestion {
  id: string;
  companyId: string;
  issueId: string;
  target: IssueDecisionQuestionTarget;
  requestedByAgentId: string | null;
  requestedByUserId: string | null;
  status: IssueDecisionQuestionStatus;
  blocking: boolean;
  title: string;
  question: string;
  whyBlocked: string | null;
  recommendedOptions: IssueDecisionOption[];
  suggestedDefault: string | null;
  answer: IssueDecisionAnswer | null;
  answeredByUserId: string | null;
  answeredAt: Date | null;
  linkedApprovalId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IssueDecisionQuestionListItem {
  question: IssueDecisionQuestion;
  issue: IssueRelationIssueSummary;
}

export interface IssuePlanApprovalSummary {
  approvalId: string | null;
  status: ApprovalStatus | null;
  currentPlanRevisionId: string | null;
  requestedPlanRevisionId: string | null;
  approvedPlanRevisionId: string | null;
  specRevisionId: string | null;
  testPlanRevisionId: string | null;
  decisionNote: string | null;
  lastRequestedAt: string | null;
  lastDecidedAt: string | null;
  currentRevisionApproved: boolean;
  requiresApproval: boolean;
  requiresResubmission: boolean;
}

export type IssueDocThawReason = "executive_thaw";

export interface IssueDocFreezeException {
  key: string;
  reason: IssueDocThawReason;
  decisionNote: string;
  grantedAt: string;
  grantedByAgentId: string | null;
  grantedByUserId: string | null;
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
  openDecisionQuestionCount?: number;
  blockingDecisionQuestionCount?: number;
  lastDecisionQuestionAt?: string | null;
  lastDecisionAnswerAt?: string | null;
  lastProgressAt: string | null;
  lastHandoffAt: string | null;
  lastReviewFindingsAt?: string | null;
  lastReviewReturnAt?: string | null;
  lastBranchReturnAt?: string | null;
  lastPreparedAt: string | null;
  lastBundleHash: string | null;
  planApproval: IssuePlanApprovalSummary;
  docFreezeExceptions?: IssueDocFreezeException[];
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
  decisionQuestions: IssueDecisionQuestion[];
  planApproval: IssuePlanApprovalSummary;
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
  evidenceManifest: IssueEvidenceManifest;
  referencedRevisionIds: Record<string, string | null>;
}

export interface IssueContinuitySummary {
  tier: IssueContinuityTier | null;
  status: IssueContinuityStatus | null;
  health: IssueContinuityHealth | null;
  specState: IssueSpecState | null;
  missingDocumentCount: number;
  activeGatePresent: boolean;
  openReviewFindings: boolean;
  openDecisionQuestions: number;
  blockingDecisionQuestions: number;
  returnedBranchCount: number;
}

export type IssueContinuityRemediationActionId =
  | "prepare_execution"
  | "request_plan_approval"
  | "resubmit_plan_approval"
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
  projectId: string;
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
  pullRequestUrl?: string | null;
  assigneeAdapterOverrides: IssueAssigneeAdapterOverrides | null;
  executionPolicy?: IssueExecutionPolicy | null;
  executionState?: IssueExecutionState | null;
  continuityState?: IssueContinuityState | null;
  continuitySummary?: IssueContinuitySummary | null;
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
  relatedWork?: IssueRelatedWorkSummary;
  referencedIssueIdentifiers?: string[];
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
  operatorState?: IssueOperatorState;
  operatorReason?: string | null;
  operatorWaitTargets?: IssueOperatorWaitTarget[];
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

export interface IssueThreadInteractionActorFields {
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
  resolvedByAgentId?: string | null;
  resolvedByUserId?: string | null;
}

export interface SuggestedTaskDraft {
  clientKey: string;
  title: string;
  description?: string | null;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  priority?: IssuePriority | null;
  projectId?: string | null;
  parentId?: string | null;
  parentClientKey?: string | null;
  blockedByIssueIds?: string[];
  goalId?: string | null;
  billingCode?: string | null;
  labels?: string[];
  hiddenInPreview?: boolean;
}

export interface SuggestTasksPayload {
  version: 1;
  defaultParentId?: string | null;
  tasks: SuggestedTaskDraft[];
}

export interface SuggestTasksResultCreatedTask {
  clientKey: string;
  issueId: string;
  identifier?: string | null;
  title?: string | null;
  parentIssueId?: string | null;
  parentIdentifier?: string | null;
}

export interface SuggestTasksResult {
  version: 1;
  createdTasks?: SuggestTasksResultCreatedTask[];
  skippedClientKeys?: string[];
  rejectionReason?: string | null;
}

export interface AskUserQuestionsQuestionOption {
  id: string;
  label: string;
  description?: string | null;
}

export interface AskUserQuestionsQuestion {
  id: string;
  prompt: string;
  selectionMode: "single" | "multi";
  required?: boolean;
  options: AskUserQuestionsQuestionOption[];
}

export interface AskUserQuestionsPayload {
  version: 1;
  title?: string | null;
  submitLabel?: string | null;
  questions: AskUserQuestionsQuestion[];
}

export interface AskUserQuestionsAnswer {
  questionId: string;
  optionIds: string[];
}

export interface AskUserQuestionsResult {
  version: 1;
  answers: AskUserQuestionsAnswer[];
  cancelled?: true;
  cancellationReason?: string | null;
  summaryMarkdown?: string | null;
}

export interface RequestConfirmationIssueDocumentTarget {
  type: "issue_document";
  issueId?: string | null;
  documentId?: string | null;
  key: string;
  revisionId: string;
  revisionNumber?: number | null;
  label?: string | null;
  href?: string | null;
}

export interface RequestConfirmationCustomTarget {
  type: "custom";
  key: string;
  revisionId?: string | null;
  revisionNumber?: number | null;
  label?: string | null;
  href?: string | null;
}

export type RequestConfirmationTarget =
  | RequestConfirmationIssueDocumentTarget
  | RequestConfirmationCustomTarget;

export interface RequestConfirmationPayload {
  version: 1;
  prompt: string;
  acceptLabel?: string | null;
  rejectLabel?: string | null;
  rejectRequiresReason?: boolean;
  rejectReasonLabel?: string | null;
  allowDeclineReason?: boolean;
  declineReasonPlaceholder?: string | null;
  detailsMarkdown?: string | null;
  supersedeOnUserComment?: boolean;
  target?: RequestConfirmationTarget | null;
}

export interface RequestConfirmationResult {
  version: 1;
  outcome: "accepted" | "rejected" | "superseded_by_comment" | "stale_target";
  reason?: string | null;
  commentId?: string | null;
  staleTarget?: RequestConfirmationTarget | null;
}

export interface IssueThreadInteractionBase extends IssueThreadInteractionActorFields {
  id: string;
  companyId: string;
  issueId: string;
  kind: IssueThreadInteractionKind;
  idempotencyKey?: string | null;
  sourceCommentId?: string | null;
  sourceRunId?: string | null;
  title?: string | null;
  summary?: string | null;
  status: IssueThreadInteractionStatus;
  continuationPolicy: IssueThreadInteractionContinuationPolicy;
  createdAt: Date | string;
  updatedAt: Date | string;
  resolvedAt?: Date | string | null;
}

export interface SuggestTasksInteraction extends IssueThreadInteractionBase {
  kind: "suggest_tasks";
  payload: SuggestTasksPayload;
  result?: SuggestTasksResult | null;
}

export interface AskUserQuestionsInteraction extends IssueThreadInteractionBase {
  kind: "ask_user_questions";
  payload: AskUserQuestionsPayload;
  result?: AskUserQuestionsResult | null;
}

export interface RequestConfirmationInteraction extends IssueThreadInteractionBase {
  kind: "request_confirmation";
  payload: RequestConfirmationPayload;
  result?: RequestConfirmationResult | null;
}

export type IssueThreadInteraction =
  | SuggestTasksInteraction
  | AskUserQuestionsInteraction
  | RequestConfirmationInteraction;

export type IssueThreadInteractionPayload =
  | SuggestTasksPayload
  | AskUserQuestionsPayload
  | RequestConfirmationPayload;

export type IssueThreadInteractionResult =
  | SuggestTasksResult
  | AskUserQuestionsResult
  | RequestConfirmationResult;

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
  scanStatus: "pending_scan" | "clean" | "quarantined" | "scan_failed";
  scanProvider: string | null;
  scanCompletedAt: Date | null;
  quarantinedAt: Date | null;
  quarantineReason: string | null;
  retentionClass: "standard" | "evidence" | "company_brand" | "temporary";
  expiresAt: Date | null;
  legalHold: boolean;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  contentPath: string;
}

export interface IssueOperatorWaitTarget {
  type: "issue" | "approval" | "decision_question" | "run" | "budget_incident";
  id: string;
  label: string;
}

export interface IssueEvidenceManifestAttachment {
  attachmentId: string;
  assetId: string;
  issueCommentId: string | null;
  originalFilename: string | null;
  contentType: string;
  sha256: string;
  scanStatus: "pending_scan" | "clean" | "quarantined" | "scan_failed";
  contentPath: string;
  createdAt: string;
}

export interface IssueEvidenceManifestComment {
  commentId: string;
  authorAgentId: string | null;
  authorUserId: string | null;
  createdAt: string;
  bodyExcerpt: string;
}

export interface IssueEvidenceManifestWorkspace {
  id: string;
  status: string;
  cwd: string | null;
  branchName: string | null;
  cleanupState?: string | null;
  reconcileState?: string | null;
  lastReconciledAt?: string | null;
}

export interface IssueEvidenceManifest {
  attachments: IssueEvidenceManifestAttachment[];
  recentComments: IssueEvidenceManifestComment[];
  executionWorkspace: IssueEvidenceManifestWorkspace | null;
}
