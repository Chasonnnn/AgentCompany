import { z } from "zod";
import {
  APPROVAL_STATUSES,
  ISSUE_BRANCH_ROLES,
  ISSUE_BRANCH_STATUSES,
  ISSUE_CONTINUITY_HEALTHS,
  ISSUE_CONTINUITY_STATUSES,
  ISSUE_CONTINUITY_TIERS,
  ISSUE_DECISION_QUESTION_STATUSES,
  ISSUE_DECISION_QUESTION_TARGETS,
  ISSUE_EXECUTION_DECISION_OUTCOMES,
  ISSUE_EXECUTION_POLICY_MODES,
  ISSUE_EXECUTION_STAGE_TYPES,
  ISSUE_EXECUTION_STATE_STATUSES,
  ISSUE_PRIORITIES,
  ISSUE_SPEC_STATES,
  ISSUE_STATUSES,
} from "../constants.js";

export const ISSUE_EXECUTION_WORKSPACE_PREFERENCES = [
  "inherit",
  "shared_workspace",
  "isolated_workspace",
  "operator_branch",
  "reuse_existing",
  "agent_default",
] as const;

const executionWorkspaceStrategySchema = z
  .object({
    type: z.enum(["project_primary", "git_worktree", "adapter_managed", "cloud_sandbox"]).optional(),
    baseRef: z.string().optional().nullable(),
    branchTemplate: z.string().optional().nullable(),
    worktreeParentDir: z.string().optional().nullable(),
    provisionCommand: z.string().optional().nullable(),
    teardownCommand: z.string().optional().nullable(),
  })
  .strict();

export const issueExecutionWorkspaceSettingsSchema = z
  .object({
    mode: z.enum(ISSUE_EXECUTION_WORKSPACE_PREFERENCES).optional(),
    workspaceStrategy: executionWorkspaceStrategySchema.optional().nullable(),
    workspaceRuntime: z.record(z.unknown()).optional().nullable(),
  })
  .strict();

export const issueAssigneeAdapterOverridesSchema = z
  .object({
    adapterConfig: z.record(z.unknown()).optional(),
    useProjectWorkspace: z.boolean().optional(),
  })
  .strict();

const issueExecutionStagePrincipalBaseSchema = z.object({
  type: z.enum(["agent", "user"]),
  agentId: z.string().uuid().optional().nullable(),
  userId: z.string().optional().nullable(),
});

export const issueExecutionStagePrincipalSchema = issueExecutionStagePrincipalBaseSchema
  .superRefine((value, ctx) => {
    if (value.type === "agent") {
      if (!value.agentId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Agent participants require agentId", path: ["agentId"] });
      }
      if (value.userId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Agent participants cannot set userId", path: ["userId"] });
      }
      return;
    }
    if (!value.userId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "User participants require userId", path: ["userId"] });
    }
    if (value.agentId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "User participants cannot set agentId", path: ["agentId"] });
    }
  });

export const issueExecutionStageParticipantSchema = issueExecutionStagePrincipalBaseSchema.extend({
  id: z.string().uuid().optional(),
}).superRefine((value, ctx) => {
  if (value.type === "agent") {
    if (!value.agentId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Agent participants require agentId", path: ["agentId"] });
    }
    if (value.userId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Agent participants cannot set userId", path: ["userId"] });
    }
    return;
  }
  if (!value.userId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "User participants require userId", path: ["userId"] });
  }
  if (value.agentId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "User participants cannot set agentId", path: ["agentId"] });
  }
});

export const issueExecutionStageSchema = z.object({
  id: z.string().uuid().optional(),
  type: z.enum(ISSUE_EXECUTION_STAGE_TYPES),
  approvalsNeeded: z.literal(1).optional().default(1),
  participants: z.array(issueExecutionStageParticipantSchema).default([]),
});

export const issueExecutionPolicySchema = z.object({
  mode: z.enum(ISSUE_EXECUTION_POLICY_MODES).optional().default("normal"),
  commentRequired: z.boolean().optional().default(true),
  stages: z.array(issueExecutionStageSchema).default([]),
});

export const issueExecutionStateSchema = z.object({
  status: z.enum(ISSUE_EXECUTION_STATE_STATUSES),
  currentStageId: z.string().uuid().nullable(),
  currentStageIndex: z.number().int().nonnegative().nullable(),
  currentStageType: z.enum(ISSUE_EXECUTION_STAGE_TYPES).nullable(),
  currentParticipant: issueExecutionStagePrincipalSchema.nullable(),
  returnAssignee: issueExecutionStagePrincipalSchema.nullable(),
  completedStageIds: z.array(z.string().uuid()).default([]),
  lastDecisionId: z.string().uuid().nullable(),
  lastDecisionOutcome: z.enum(ISSUE_EXECUTION_DECISION_OUTCOMES).nullable(),
});

export const issueContinuityTierSchema = z.enum(ISSUE_CONTINUITY_TIERS);
export const issueContinuityStatusSchema = z.enum(ISSUE_CONTINUITY_STATUSES);
export const issueSpecStateSchema = z.enum(ISSUE_SPEC_STATES);
export const issueBranchRoleSchema = z.enum(ISSUE_BRANCH_ROLES);
export const issueBranchStatusSchema = z.enum(ISSUE_BRANCH_STATUSES);
export const issueContinuityHealthSchema = z.enum(ISSUE_CONTINUITY_HEALTHS);
export const issueDecisionQuestionStatusSchema = z.enum(ISSUE_DECISION_QUESTION_STATUSES);
export const issueDecisionQuestionTargetSchema = z.enum(ISSUE_DECISION_QUESTION_TARGETS);

export const issueDecisionOptionSchema = z.object({
  key: z.string().trim().min(1),
  label: z.string().trim().min(1),
  description: z.string().trim().min(1).optional().nullable(),
});

export const issueDecisionAnswerSchema = z.object({
  selectedOptionKey: z.string().trim().min(1).optional().nullable(),
  answer: z.string().trim().min(1),
  note: z.string().trim().min(1).optional().nullable(),
});

export const issueDecisionQuestionSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  issueId: z.string().uuid(),
  target: issueDecisionQuestionTargetSchema,
  requestedByAgentId: z.string().uuid().nullable(),
  requestedByUserId: z.string().nullable(),
  status: issueDecisionQuestionStatusSchema,
  blocking: z.boolean(),
  title: z.string().trim().min(1),
  question: z.string().trim().min(1),
  whyBlocked: z.string().trim().min(1).nullable(),
  recommendedOptions: z.array(issueDecisionOptionSchema).default([]),
  suggestedDefault: z.string().trim().min(1).nullable(),
  answer: issueDecisionAnswerSchema.nullable(),
  answeredByUserId: z.string().nullable(),
  answeredAt: z.coerce.date().nullable(),
  linkedApprovalId: z.string().uuid().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export const issueDecisionQuestionListItemSchema = z.object({
  question: issueDecisionQuestionSchema,
  issue: z.object({
    id: z.string().uuid(),
    identifier: z.string().trim().min(1).nullable(),
    title: z.string().trim().min(1),
    status: z.enum(ISSUE_STATUSES),
    priority: z.enum(ISSUE_PRIORITIES),
    assigneeAgentId: z.string().uuid().nullable(),
    assigneeUserId: z.string().nullable(),
  }),
});

export const ISSUE_DOC_THAW_REASONS = ["executive_thaw"] as const;
export const issueDocThawReasonSchema = z.enum(ISSUE_DOC_THAW_REASONS);

export const issueDocFreezeExceptionSchema = z.object({
  key: z.string().trim().min(1),
  reason: issueDocThawReasonSchema,
  decisionNote: z.string().trim().min(1),
  grantedAt: z.string().datetime(),
  grantedByAgentId: z.string().uuid().nullable(),
  grantedByUserId: z.string().nullable(),
});
// Canonical `IssueDocFreezeException` lives in ../types/issue.ts. Avoid a
// parallel z.infer<> alias here so the schema and the interface cannot drift.

export const issuePlanApprovalSummarySchema = z.object({
  approvalId: z.string().uuid().nullable().optional().default(null),
  status: z.enum(APPROVAL_STATUSES).nullable().optional().default(null),
  currentPlanRevisionId: z.string().uuid().nullable().optional().default(null),
  requestedPlanRevisionId: z.string().uuid().nullable().optional().default(null),
  approvedPlanRevisionId: z.string().uuid().nullable().optional().default(null),
  specRevisionId: z.string().uuid().nullable().optional().default(null),
  testPlanRevisionId: z.string().uuid().nullable().optional().default(null),
  decisionNote: z.string().trim().min(1).nullable().optional().default(null),
  lastRequestedAt: z.string().datetime().nullable().optional().default(null),
  lastDecidedAt: z.string().datetime().nullable().optional().default(null),
  currentRevisionApproved: z.boolean().optional().default(false),
  requiresApproval: z.boolean().optional().default(false),
  requiresResubmission: z.boolean().optional().default(false),
});

export const issueContinuityStateSchema = z.object({
  tier: issueContinuityTierSchema,
  status: issueContinuityStatusSchema,
  health: issueContinuityHealthSchema,
  healthReason: z.string().trim().min(1).nullable().optional(),
  healthDetails: z.array(z.string()).optional().default([]),
  requiredDocumentKeys: z.array(z.string()).default([]),
  missingDocumentKeys: z.array(z.string()).default([]),
  specState: issueSpecStateSchema,
  branchRole: issueBranchRoleSchema,
  branchStatus: issueBranchStatusSchema,
  unresolvedBranchIssueIds: z.array(z.string().uuid()).default([]),
  returnedBranchIssueIds: z.array(z.string().uuid()).default([]),
  openReviewFindingsRevisionId: z.string().uuid().nullable().optional(),
  openDecisionQuestionCount: z.number().int().nonnegative().optional().default(0),
  blockingDecisionQuestionCount: z.number().int().nonnegative().optional().default(0),
  lastDecisionQuestionAt: z.string().datetime().nullable().optional(),
  lastDecisionAnswerAt: z.string().datetime().nullable().optional(),
  lastProgressAt: z.string().datetime().nullable(),
  lastHandoffAt: z.string().datetime().nullable(),
  lastReviewFindingsAt: z.string().datetime().nullable().optional(),
  lastReviewReturnAt: z.string().datetime().nullable().optional(),
  lastBranchReturnAt: z.string().datetime().nullable().optional(),
  lastPreparedAt: z.string().datetime().nullable(),
  lastBundleHash: z.string().nullable(),
  planApproval: issuePlanApprovalSummarySchema.optional().default({}),
  docFreezeExceptions: z.array(issueDocFreezeExceptionSchema).optional().default([]),
});

const issueContinuityDocumentSnapshotSchema = z.object({
  key: z.string().min(1),
  title: z.string().nullable(),
  body: z.string(),
  latestRevisionId: z.string().uuid().nullable(),
  latestRevisionNumber: z.number().int().nonnegative(),
  updatedAt: z.string().datetime(),
});

const issueEvidenceManifestAttachmentSchema = z.object({
  attachmentId: z.string().uuid(),
  assetId: z.string().uuid(),
  issueCommentId: z.string().uuid().nullable(),
  originalFilename: z.string().nullable(),
  contentType: z.string().min(1),
  sha256: z.string().min(1),
  scanStatus: z.enum(["pending_scan", "clean", "quarantined", "scan_failed"]),
  contentPath: z.string().min(1),
  createdAt: z.string().datetime(),
});

const issueEvidenceManifestCommentSchema = z.object({
  commentId: z.string().uuid(),
  authorAgentId: z.string().uuid().nullable(),
  authorUserId: z.string().nullable(),
  createdAt: z.string().datetime(),
  bodyExcerpt: z.string(),
});

const issueEvidenceManifestSchema = z.object({
  attachments: z.array(issueEvidenceManifestAttachmentSchema).default([]),
  recentComments: z.array(issueEvidenceManifestCommentSchema).default([]),
  executionWorkspace: z.object({
    id: z.string().uuid(),
    status: z.string().min(1),
    cwd: z.string().nullable(),
    branchName: z.string().nullable(),
    cleanupState: z.string().nullable().optional(),
    reconcileState: z.string().nullable().optional(),
    lastReconciledAt: z.string().datetime().nullable().optional(),
  }).nullable(),
});

export const issueContinuityBundleSchema = z.object({
  issueId: z.string().uuid(),
  generatedAt: z.string().datetime(),
  bundleHash: z.string().min(1),
  continuityState: issueContinuityStateSchema.nullable(),
  executionState: issueExecutionStateSchema.nullable(),
  decisionQuestions: z.array(issueDecisionQuestionSchema).default([]),
  planApproval: issuePlanApprovalSummarySchema.optional().default({}),
  issueDocuments: z.object({
    spec: issueContinuityDocumentSnapshotSchema.nullable(),
    plan: issueContinuityDocumentSnapshotSchema.nullable(),
    runbook: issueContinuityDocumentSnapshotSchema.nullable(),
    progress: issueContinuityDocumentSnapshotSchema.nullable(),
    "test-plan": issueContinuityDocumentSnapshotSchema.nullable(),
    handoff: issueContinuityDocumentSnapshotSchema.nullable(),
    "review-findings": issueContinuityDocumentSnapshotSchema.nullable(),
    "branch-return": issueContinuityDocumentSnapshotSchema.nullable(),
  }),
  projectDocuments: z.object({
    context: issueContinuityDocumentSnapshotSchema.nullable(),
    runbook: issueContinuityDocumentSnapshotSchema.nullable(),
  }),
  evidenceManifest: issueEvidenceManifestSchema,
  referencedRevisionIds: z.record(z.string(), z.string().uuid().nullable()),
});

export const issueContinuitySummarySchema = z.object({
  tier: issueContinuityTierSchema.nullable(),
  status: issueContinuityStatusSchema.nullable(),
  health: issueContinuityHealthSchema.nullable(),
  specState: issueSpecStateSchema.nullable(),
  missingDocumentCount: z.number().int().nonnegative(),
  activeGatePresent: z.boolean(),
  openReviewFindings: z.boolean(),
  openDecisionQuestions: z.number().int().nonnegative(),
  blockingDecisionQuestions: z.number().int().nonnegative(),
  returnedBranchCount: z.number().int().nonnegative(),
});

export const createIssueDecisionQuestionSchema = z.object({
  title: z.string().trim().min(1),
  question: z.string().trim().min(1),
  whyBlocked: z.string().trim().min(1).optional().nullable(),
  blocking: z.boolean().optional().default(true),
  recommendedOptions: z.array(issueDecisionOptionSchema).default([]),
  suggestedDefault: z.string().trim().min(1).optional().nullable(),
  linkedApprovalId: z.string().uuid().optional().nullable(),
});

export const answerIssueDecisionQuestionSchema = z.object({
  selectedOptionKey: z.string().trim().min(1).optional().nullable(),
  answer: z.string().trim().min(1).optional().nullable(),
  escalateToApproval: z.boolean().optional().default(false),
}).superRefine((value, ctx) => {
  const hasSelectedOption = typeof value.selectedOptionKey === "string" && value.selectedOptionKey.trim().length > 0;
  const hasCustomAnswer = typeof value.answer === "string" && value.answer.trim().length > 0;

  if (hasSelectedOption === hasCustomAnswer) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Provide exactly one of selectedOptionKey or answer",
      path: hasSelectedOption ? ["answer"] : ["selectedOptionKey"],
    });
  }
});

export const dismissIssueDecisionQuestionSchema = z.object({
  note: z.string().trim().min(1).optional().nullable(),
});

export const escalateIssueDecisionQuestionSchema = z.object({
  summary: z.string().trim().min(1).optional().nullable(),
  recommendedAction: z.string().trim().min(1).optional().nullable(),
  nextActionOnApproval: z.string().trim().min(1).optional().nullable(),
  risks: z.array(z.string().trim().min(1)).optional(),
  proposedComment: z.string().trim().min(1).optional().nullable(),
});

export const issueContinuityRemediationActionSchema = z.object({
  id: z.enum([
    "prepare_execution",
    "request_plan_approval",
    "resubmit_plan_approval",
    "progress_checkpoint",
    "handoff_repair",
    "handoff_cancel",
    "review_resubmit",
    "branch_merge",
  ]),
  label: z.string().trim().min(1),
  description: z.string().trim().min(1),
  actor: z.enum(["continuity_owner", "active_gate_participant", "branch_owner", "board"]),
  eligible: z.boolean(),
  blockedReason: z.string().trim().min(1).nullable(),
  targetIssueIds: z.array(z.string().uuid()).optional(),
});

export const issueContinuityRemediationSchema = z.object({
  suggestedActions: z.array(issueContinuityRemediationActionSchema).default([]),
  blockedActions: z.array(issueContinuityRemediationActionSchema).default([]),
});

export const issueBranchMergePreviewUpdateSchema = z.object({
  documentKey: z.string().trim().min(1),
  action: z.enum(["append", "replace"]),
  summary: z.string().trim().min(1),
  content: z.string().trim().min(1),
  title: z.string().trim().min(1).nullable(),
  existingParentRevisionId: z.string().uuid().nullable(),
});

export const issueBranchMergePreviewSchema = z.object({
  branchIssueId: z.string().uuid(),
  parentIssueId: z.string().uuid(),
  canMerge: z.boolean(),
  blockedReason: z.string().trim().min(1).nullable(),
  branchStatus: issueBranchStatusSchema,
  proposedUpdates: z.array(issueBranchMergePreviewUpdateSchema).default([]),
  mergeChecklist: z.array(z.string()).default([]),
  unresolvedRisks: z.array(z.string()).default([]),
  openQuestions: z.array(z.string()).default([]),
  evidence: z.array(z.string()).default([]),
  returnedArtifacts: z.array(z.string()).default([]),
});

export const createIssueContinuityDocOverrideSchema = z.object({
  title: z.string().trim().max(200).optional().nullable(),
  body: z.string().min(1).max(524288),
  format: z.literal("markdown").optional(),
});

export const createIssueContinuityDocsOverrideSchema = z.record(
  z.enum(["spec", "plan", "runbook", "progress", "test-plan", "handoff"]),
  createIssueContinuityDocOverrideSchema,
);

export type CreateIssueContinuityDocOverride = z.infer<typeof createIssueContinuityDocOverrideSchema>;
export type CreateIssueContinuityDocsOverride = z.infer<typeof createIssueContinuityDocsOverrideSchema>;

export const prepareIssueContinuitySchema = z.object({
  tier: issueContinuityTierSchema.optional(),
  docs: createIssueContinuityDocsOverrideSchema.optional(),
});

export const handoffIssueContinuitySchema = z.object({
  assigneeAgentId: z.string().uuid().optional().nullable(),
  assigneeUserId: z.string().optional().nullable(),
  reasonCode: z.string().trim().min(1),
  exactNextAction: z.string().trim().min(1),
  unresolvedBranches: z.array(z.string().uuid()).optional(),
  openQuestions: z.array(z.string()).optional(),
  evidence: z.array(z.string()).optional(),
});

export const issueReviewFindingInputSchema = z.object({
  severity: z.enum(["critical", "high", "medium", "low"]),
  category: z.string().trim().min(1),
  title: z.string().trim().min(1),
  detail: z.string().trim().min(1),
  requiredAction: z.string().trim().min(1),
  evidence: z.array(z.string()).optional(),
});

export const reviewReturnIssueContinuitySchema = z.object({
  decisionContext: z.string().trim().min(1).optional().nullable(),
  outcome: z.enum(["changes_requested", "approved_with_notes", "blocked"]),
  ownerNextAction: z.string().trim().min(1),
  findings: z.array(issueReviewFindingInputSchema).min(1),
});

export const promoteIssueReviewFindingSkillSchema = z.object({
  companySkillId: z.string().uuid().optional(),
  sharedSkillId: z.string().uuid().optional(),
  sourceRunId: z.string().uuid().optional().nullable(),
  reproductionSummary: z.string().trim().min(1).optional().nullable(),
}).refine((value) => Boolean(value.companySkillId || value.sharedSkillId), {
  message: "companySkillId or sharedSkillId is required",
});

export const progressCheckpointIssueContinuitySchema = z.object({
  summary: z.string().trim().min(1).optional().nullable(),
  currentState: z.string().trim().min(1),
  nextAction: z.string().trim().min(1),
  completed: z.array(z.string()).optional(),
  knownPitfalls: z.array(z.string()).optional(),
  openQuestions: z.array(z.string()).optional(),
  evidence: z.array(z.string()).optional(),
});

export const reviewResubmitIssueContinuitySchema = z.object({
  responseNote: z.string().trim().min(1).optional().nullable(),
  progressCheckpoint: progressCheckpointIssueContinuitySchema.optional(),
});

export const handoffRepairIssueContinuitySchema = z.object({
  reasonCode: z.string().trim().min(1),
  exactNextAction: z.string().trim().min(1),
  unresolvedBranches: z.array(z.string().uuid()).optional(),
  openQuestions: z.array(z.string()).optional(),
  evidence: z.array(z.string()).optional(),
});

export const handoffCancelIssueContinuitySchema = z.object({
  reasonNote: z.string().trim().min(1),
});

export const branchReturnProposedUpdateInputSchema = z.object({
  documentKey: z.string().trim().min(1),
  action: z.enum(["append", "replace"]),
  summary: z.string().trim().min(1),
  content: z.string().trim().min(1),
  title: z.string().trim().min(1).optional().nullable(),
});

export const returnIssueContinuityBranchSchema = z.object({
  purposeScopeRecap: z.string().trim().min(1),
  resultSummary: z.string().trim().min(1),
  proposedParentUpdates: z.array(branchReturnProposedUpdateInputSchema).default([]),
  mergeChecklist: z.array(z.string()).optional(),
  unresolvedRisks: z.array(z.string()).optional(),
  openQuestions: z.array(z.string()).optional(),
  evidence: z.array(z.string()).optional(),
  returnedArtifacts: z.array(z.string()).optional(),
});

export const mergeIssueContinuityBranchSchema = z.object({
  selectedDocumentKeys: z.array(z.string().trim().min(1)).default([]),
});

export const requestIssueSpecThawSchema = z.object({
  approvalId: z.string().uuid().optional().nullable(),
  reason: z.string().trim().min(1).optional().nullable(),
});

export const DOC_UNFREEZE_CONTINUITY_DOCUMENT_KEYS = [
  "spec",
  "plan",
  "test-plan",
  "handoff",
] as const;

export const requestIssueContinuityDocUnfreezeSchema = z.object({
  decisionNote: z.string().trim().min(1).max(1000),
  documentKeys: z
    .array(z.enum(DOC_UNFREEZE_CONTINUITY_DOCUMENT_KEYS))
    .min(1)
    .optional(),
});

export const createIssueContinuityBranchSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    title: z.string().trim().min(1),
    description: z.string().optional().nullable(),
    purpose: z.string().trim().min(1),
    scope: z.string().trim().min(1),
    budget: z.string().trim().min(1),
    expectedReturnArtifact: z.string().trim().min(1),
    mergeCriteria: z.array(z.string()).optional(),
    expiration: z.string().trim().min(1).optional().nullable(),
    timeout: z.string().trim().min(1).optional().nullable(),
    assigneeAgentId: z.string().uuid().optional().nullable(),
    assigneeUserId: z.string().optional().nullable(),
    priority: z.enum(ISSUE_PRIORITIES).optional(),
  }),
  z.object({
    action: z.literal("merge"),
    branchIssueId: z.string().uuid(),
  }),
]);

export const createIssueSchema = z.object({
  projectId: z.string().uuid().optional().nullable(),
  projectWorkspaceId: z.string().uuid().optional().nullable(),
  goalId: z.string().uuid().optional().nullable(),
  parentId: z.string().uuid().optional().nullable(),
  blockedByIssueIds: z.array(z.string().uuid()).optional(),
  inheritExecutionWorkspaceFromIssueId: z.string().uuid().optional().nullable(),
  title: z.string().min(1),
  description: z.string().optional().nullable(),
  status: z.enum(ISSUE_STATUSES).optional().default("backlog"),
  priority: z.enum(ISSUE_PRIORITIES).optional().default("medium"),
  assigneeAgentId: z.string().uuid().optional().nullable(),
  assigneeUserId: z.string().optional().nullable(),
  requestDepth: z.number().int().nonnegative().optional().default(0),
  billingCode: z.string().optional().nullable(),
  assigneeAdapterOverrides: issueAssigneeAdapterOverridesSchema.optional().nullable(),
  executionPolicy: issueExecutionPolicySchema.optional().nullable(),
  continuityTier: issueContinuityTierSchema.optional(),
  prepareContinuity: z.boolean().optional(),
  docs: createIssueContinuityDocsOverrideSchema.optional(),
  executionWorkspaceId: z.string().uuid().optional().nullable(),
  executionWorkspacePreference: z.enum(ISSUE_EXECUTION_WORKSPACE_PREFERENCES).optional().nullable(),
  executionWorkspaceSettings: issueExecutionWorkspaceSettingsSchema.optional().nullable(),
  labelIds: z.array(z.string().uuid()).optional(),
});

export type CreateIssue = z.infer<typeof createIssueSchema>;

export const createChildIssueSchema = createIssueSchema
  .omit({
    parentId: true,
    inheritExecutionWorkspaceFromIssueId: true,
  })
  .extend({
    acceptanceCriteria: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
    blockParentUntilDone: z.boolean().optional().default(false),
  });

export type CreateChildIssue = z.infer<typeof createChildIssueSchema>;

export const createIssueLabelSchema = z.object({
  name: z.string().trim().min(1).max(48),
  color: z.string().regex(/^#(?:[0-9a-fA-F]{6})$/, "Color must be a 6-digit hex value"),
});

export type CreateIssueLabel = z.infer<typeof createIssueLabelSchema>;

export const inReviewSelfAttestSchema = z.object({
  testsRun: z.boolean(),
  docsUpdated: z.boolean(),
  worktreeClean: z.boolean(),
});

export type InReviewSelfAttest = z.infer<typeof inReviewSelfAttestSchema>;

export const updateIssueSchema = createIssueSchema.partial().extend({
  comment: z.string().min(1).optional(),
  reopen: z.boolean().optional(),
  interrupt: z.boolean().optional(),
  hiddenAt: z.string().datetime().nullable().optional(),
  pullRequestUrl: z.string().url().max(2048).optional(),
  selfAttest: inReviewSelfAttestSchema.optional(),
});

export type UpdateIssue = z.infer<typeof updateIssueSchema>;
export type IssueExecutionWorkspaceSettings = z.infer<typeof issueExecutionWorkspaceSettingsSchema>;

export const checkoutIssueSchema = z.object({
  agentId: z.string().uuid(),
  expectedStatuses: z.array(z.enum(ISSUE_STATUSES)).nonempty(),
});

export type CheckoutIssue = z.infer<typeof checkoutIssueSchema>;

export const addIssueCommentSchema = z.object({
  body: z.string().min(1),
  reopen: z.boolean().optional(),
  interrupt: z.boolean().optional(),
});

export type AddIssueComment = z.infer<typeof addIssueCommentSchema>;

export const linkIssueApprovalSchema = z.object({
  approvalId: z.string().uuid(),
});

export type LinkIssueApproval = z.infer<typeof linkIssueApprovalSchema>;

export const createIssueAttachmentMetadataSchema = z.object({
  issueCommentId: z.string().uuid().optional().nullable(),
});

export type CreateIssueAttachmentMetadata = z.infer<typeof createIssueAttachmentMetadataSchema>;

export const ISSUE_DOCUMENT_FORMATS = ["markdown"] as const;

export const issueDocumentFormatSchema = z.enum(ISSUE_DOCUMENT_FORMATS);

export const issueDocumentKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "Document key must be lowercase letters, numbers, _ or -");

export const upsertIssueDocumentSchema = z.object({
  title: z.string().trim().max(200).nullable().optional(),
  format: issueDocumentFormatSchema,
  body: z.string().max(524288),
  changeSummary: z.string().trim().max(500).nullable().optional(),
  baseRevisionId: z.string().uuid().nullable().optional(),
});

export const restoreIssueDocumentRevisionSchema = z.object({});

export type IssueDocumentFormat = z.infer<typeof issueDocumentFormatSchema>;
export type UpsertIssueDocument = z.infer<typeof upsertIssueDocumentSchema>;
export type RestoreIssueDocumentRevision = z.infer<typeof restoreIssueDocumentRevisionSchema>;
export type PrepareIssueContinuity = z.infer<typeof prepareIssueContinuitySchema>;
export type HandoffIssueContinuity = z.infer<typeof handoffIssueContinuitySchema>;
export type ReviewReturnIssueContinuity = z.infer<typeof reviewReturnIssueContinuitySchema>;
export type PromoteIssueReviewFindingSkill = z.infer<typeof promoteIssueReviewFindingSkillSchema>;
export type ReviewResubmitIssueContinuity = z.infer<typeof reviewResubmitIssueContinuitySchema>;
export type ProgressCheckpointIssueContinuity = z.infer<typeof progressCheckpointIssueContinuitySchema>;
export type HandoffRepairIssueContinuity = z.infer<typeof handoffRepairIssueContinuitySchema>;
export type HandoffCancelIssueContinuity = z.infer<typeof handoffCancelIssueContinuitySchema>;
export type RequestIssueSpecThaw = z.infer<typeof requestIssueSpecThawSchema>;
export type RequestIssueContinuityDocUnfreeze = z.infer<typeof requestIssueContinuityDocUnfreezeSchema>;
export type CreateIssueDecisionQuestion = z.infer<typeof createIssueDecisionQuestionSchema>;
export type AnswerIssueDecisionQuestion = z.infer<typeof answerIssueDecisionQuestionSchema>;
export type DismissIssueDecisionQuestion = z.infer<typeof dismissIssueDecisionQuestionSchema>;
export type EscalateIssueDecisionQuestion = z.infer<typeof escalateIssueDecisionQuestionSchema>;
export type CreateIssueContinuityBranch = z.infer<typeof createIssueContinuityBranchSchema>;
export type ReturnIssueContinuityBranch = z.infer<typeof returnIssueContinuityBranchSchema>;
export type MergeIssueContinuityBranch = z.infer<typeof mergeIssueContinuityBranchSchema>;
