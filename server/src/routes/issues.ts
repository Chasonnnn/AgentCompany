import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { issueExecutionDecisions } from "@paperclipai/db";
import {
  addIssueCommentSchema,
  answerIssueDecisionQuestionSchema,
  createIssueDecisionQuestionSchema,
  createIssueContinuityBranchSchema,
  dismissIssueDecisionQuestionSchema,
  ISSUE_BRANCH_CHARTER_DOCUMENT_KEY,
  createIssueAttachmentMetadataSchema,
  createIssueWorkProductSchema,
  createIssueLabelSchema,
  checkoutIssueSchema,
  createIssueSchema,
  feedbackTargetTypeSchema,
  feedbackTraceStatusSchema,
  feedbackVoteValueSchema,
  upsertIssueFeedbackVoteSchema,
  linkIssueApprovalSchema,
  ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
  issueDocumentKeySchema,
  parseIssueBranchCharterMarkdown,
  parseIssueBranchReturnMarkdown,
  parseIssueHandoffMarkdown,
  parseIssueProgressMarkdown,
  parseIssueReviewFindingsMarkdown,
  promoteIssueReviewFindingSkillSchema,
  progressCheckpointIssueContinuitySchema,
  prepareIssueContinuitySchema,
  requestIssueSpecThawSchema,
  restoreIssueDocumentRevisionSchema,
  returnIssueContinuityBranchSchema,
  reviewResubmitIssueContinuitySchema,
  reviewReturnIssueContinuitySchema,
  mergeIssueContinuityBranchSchema,
  handoffRepairIssueContinuitySchema,
  handoffCancelIssueContinuitySchema,
  handoffIssueContinuitySchema,
  escalateIssueDecisionQuestionSchema,
  updateIssueWorkProductSchema,
  upsertIssueDocumentSchema,
  updateIssueSchema,
  getClosedIsolatedExecutionWorkspaceMessage,
  isClosedIsolatedExecutionWorkspace,
  type ExecutionWorkspace,
} from "@paperclipai/shared";
import { trackAgentTaskCompleted } from "@paperclipai/shared/telemetry";
import { getTelemetryClient } from "../telemetry.js";
import type { StorageService } from "../storage/types.js";
import { validate } from "../middleware/validate.js";
import {
  accessService,
  agentService,
  officeCoordinationService,
  executionWorkspaceService,
  feedbackService,
  goalService,
  heartbeatService,
  instanceSettingsService,
  issueApprovalService,
  ISSUE_LIST_DEFAULT_LIMIT,
  ISSUE_LIST_MAX_LIMIT,
  issueContinuityService,
  issueService,
  issueReferenceService,
  clampIssueListLimit,
  documentService,
  logActivity as baseLogActivity,
  projectService,
  routineService,
  workProductService,
} from "../services/index.js";
import { buildIssueOperatorState } from "../services/issue-operator-state.js";
import { resolveIssueHeartbeatMode } from "../services/issue-heartbeat-mode.js";
import { assertInReviewEntryGate } from "../services/issue-review-gate.js";
import { wakeCompanyOfficeOperatorSafely } from "../services/office-coordination-wakeup.js";
import { issueDecisionQuestionService } from "../services/issue-decision-questions.js";
import { logger } from "../middleware/logger.js";
import { forbidden, HttpError, unauthorized } from "../errors.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { shouldWakeAssigneeOnCheckout } from "./issues-checkout-wakeup.js";
import {
  isInlineAttachmentContentType,
  MAX_ATTACHMENT_BYTES,
  normalizeContentType,
  SVG_CONTENT_TYPE,
} from "../attachment-types.js";
import {
  isIssueWakeBlockedByContinuity,
  queueIssueAssignmentWakeup,
  shouldWakeAssignedAgentForIssue,
} from "../services/issue-assignment-wakeup.js";
import {
  applyIssueExecutionPolicyTransition,
  normalizeIssueExecutionPolicy,
  parseIssueExecutionState,
} from "../services/issue-execution-policy.js";
import { buildIssueContinuitySummary } from "../services/issue-continuity-summary.js";
import {
  conferenceContextService,
  sanitizeConferenceContextForActor,
  serializeApprovalForActor,
} from "../services/conference-context.js";
import { agentHasCreatePermission } from "../services/agent-permissions.js";
import {
  buildAutoRouteComment,
  inReviewRoutingMissingReviewerError,
  selectLeastLoadedQaReviewer,
} from "../services/in-review-routing.js";

const MAX_ISSUE_COMMENT_LIMIT = 500;
const updateIssueRouteSchema = updateIssueSchema.extend({
  interrupt: z.boolean().optional(),
  autoRouteReviewer: z.boolean().optional(),
});

type IssueRouteDeps = {
  accessService: ReturnType<typeof accessService>;
  agentService: ReturnType<typeof agentService>;
  issueContinuityService: ReturnType<typeof createFallbackIssueContinuityService>;
  issueDecisionQuestionService: ReturnType<typeof issueDecisionQuestionService>;
  documentService: ReturnType<typeof documentService>;
  executionWorkspaceService: ReturnType<typeof executionWorkspaceService>;
  feedbackService: ReturnType<typeof feedbackService>;
  goalService: ReturnType<typeof goalService>;
  heartbeatService: ReturnType<typeof heartbeatService>;
  instanceSettingsService: ReturnType<typeof instanceSettingsService>;
  issueApprovalService: ReturnType<typeof issueApprovalService>;
  issueService: ReturnType<typeof issueService>;
  issueReferenceService: ReturnType<typeof createFallbackIssueReferenceService>;
  logActivity: typeof baseLogActivity;
  officeCoordinationService: ReturnType<typeof officeCoordinationService>;
  projectService: ReturnType<typeof projectService>;
  routineService: ReturnType<typeof routineService>;
  workProductService: ReturnType<typeof workProductService>;
  conferenceContextService: ReturnType<typeof conferenceContextService>;
};

type ParsedExecutionState = NonNullable<ReturnType<typeof parseIssueExecutionState>>;
type NormalizedExecutionPolicy = NonNullable<ReturnType<typeof normalizeIssueExecutionPolicy>>;
type ActivityIssueRelationSummary = {
  id: string;
  identifier: string | null;
  title: string;
};
type ActivityExecutionParticipant = Pick<
  NormalizedExecutionPolicy["stages"][number]["participants"][number],
  "type" | "agentId" | "userId"
>;

function createFallbackIssueContinuityService() {
  return {
    recomputeIssueContinuityState: async () => null,
    getIssueContinuity: async (issueId: string) => ({
      issueId,
      continuityState: null,
      continuityBundle: null,
      continuityOwner: null,
      activeGateParticipant: null,
      remediation: { suggestedActions: [], blockedActions: [] },
    }),
    prepare: async () => ({
      continuityState: null,
      continuityBundle: null,
      scaffoldedKeys: [],
      overriddenKeys: [],
      planApprovalRequest: null,
    }),
    handoff: async (_issueId: string) => ({
      issue: null,
      continuityState: null,
      continuityBundle: null,
    }),
    requestSpecThaw: async () => ({
      approvalId: null,
      continuityState: null,
      continuityBundle: null,
    }),
    requestPlanApproval: async () => ({
      approvalId: null,
      approvalStatus: null,
      continuityState: null,
      continuityBundle: null,
    }),
    progressCheckpoint: async () => ({
      continuityState: null,
      continuityBundle: null,
    }),
    reviewReturn: async (_issueId: string) => ({
      issue: null,
      continuityState: null,
      continuityBundle: null,
    }),
    reviewResubmit: async (_issueId: string) => ({
      issue: null,
      continuityState: null,
      continuityBundle: null,
    }),
    promoteReviewFindingSkill: async () => ({
      hardeningIssue: null,
      continuityState: null,
      continuityBundle: null,
    }),
    handoffRepair: async () => ({
      continuityState: null,
      continuityBundle: null,
    }),
    handoffCancel: async () => ({
      continuityState: null,
      continuityBundle: null,
    }),
    mutateBranch: async () => ({
      branchIssue: null,
      continuityState: null,
      continuityBundle: null,
    }),
    returnBranch: async () => ({
      branchIssue: null,
      continuityState: null,
      continuityBundle: null,
    }),
    getBranchMergePreview: async () => null,
    mergeBranch: async () => ({
      branchIssueId: null,
      appliedDocumentKeys: [],
      deferredDocumentKeys: [],
      continuityState: null,
      continuityBundle: null,
    }),
  };
}

function createFallbackIssueDecisionQuestionService() {
  return {
    listForIssue: async () => [],
    listOpenForCompany: async () => [],
    listOpenForCompanyWithIssues: async () => [],
    create: async () => ({
      question: null,
      continuityState: null,
      continuityBundle: null,
    }),
    answer: async () => ({
      question: null,
      continuityState: null,
      continuityBundle: null,
      shouldEscalateToApproval: false,
    }),
    dismiss: async () => ({
      question: null,
      continuityState: null,
      continuityBundle: null,
    }),
    escalateToApproval: async () => ({
      question: null,
      approvalId: null,
      continuityState: null,
      continuityBundle: null,
    }),
  };
}

function createFallbackIssueReferenceService() {
  return {
    syncIssue: async () => undefined,
    syncComment: async () => undefined,
    syncDocument: async () => undefined,
    deleteCommentSource: async () => undefined,
    deleteDocumentSource: async () => undefined,
    syncAllForIssue: async () => undefined,
    syncAllForCompany: async () => undefined,
    listIssueReferenceSummary: async () => ({
      outbound: [],
      inbound: [],
    }),
    diffIssueReferenceSummary: () => ({
      addedReferencedIssues: [],
      removedReferencedIssues: [],
      currentReferencedIssues: [],
    }),
    emptySummary: () => ({
      outbound: [],
      inbound: [],
    }),
  };
}
type ExecutionStageWakeContext = {
  wakeRole: "reviewer" | "approver" | "executor";
  stageId: string | null;
  stageType: ParsedExecutionState["currentStageType"];
  currentParticipant: ParsedExecutionState["currentParticipant"];
  returnAssignee: ParsedExecutionState["returnAssignee"];
  lastDecisionOutcome: ParsedExecutionState["lastDecisionOutcome"];
  allowedActions: string[];
};

function executionPrincipalsEqual(
  left: ParsedExecutionState["currentParticipant"] | null,
  right: ParsedExecutionState["currentParticipant"] | null,
) {
  if (!left || !right || left.type !== right.type) return false;
  return left.type === "agent" ? left.agentId === right.agentId : left.userId === right.userId;
}

function buildExecutionStageWakeContext(input: {
  state: ParsedExecutionState;
  wakeRole: ExecutionStageWakeContext["wakeRole"];
  allowedActions: string[];
}): ExecutionStageWakeContext {
  return {
    wakeRole: input.wakeRole,
    stageId: input.state.currentStageId,
    stageType: input.state.currentStageType,
    currentParticipant: input.state.currentParticipant,
    returnAssignee: input.state.returnAssignee,
    lastDecisionOutcome: input.state.lastDecisionOutcome,
    allowedActions: input.allowedActions,
  };
}

const CONTINUITY_CONTROLLED_DOCUMENT_KEYS = new Set([
  "spec",
  "plan",
  "runbook",
  "progress",
  "handoff",
  "review-findings",
  "branch-return",
  ISSUE_BRANCH_CHARTER_DOCUMENT_KEY,
]);
const EXECUTION_APPROVAL_GATED_DOCUMENT_KEYS = new Set(["spec", "plan", "runbook", "test-plan"]);

function isContinuityActive(issue: {
  status: string;
  startedAt?: Date | null;
  executionState?: unknown;
}) {
  const executionState = parseIssueExecutionState(issue.executionState ?? null);
  return (
    issue.startedAt != null ||
    issue.status === "in_progress" ||
    issue.status === "in_review" ||
    issue.status === "blocked" ||
    executionState?.status === "pending" ||
    executionState?.status === "changes_requested"
  );
}

function withIssueContinuitySummary<T extends { continuityState?: unknown; executionState?: unknown }>(issue: T) {
  const continuitySummary = buildIssueContinuitySummary(issue);
  const operatorState = buildIssueOperatorState({
    issueId: (issue as { id?: string }).id ?? "",
    status: ((issue as { status?: string }).status ?? "todo") as any,
    hiddenAt: (issue as { hiddenAt?: Date | null }).hiddenAt ?? null,
    continuitySummary,
    activeRun: (issue as { activeRun?: { id: string; status: string } | null }).activeRun ?? null,
  });
  return {
    ...issue,
    continuitySummary,
    operatorState: operatorState.operatorState,
    operatorReason: operatorState.operatorReason,
    operatorWaitTargets: operatorState.operatorWaitTargets,
  };
}

function describeExecutionReadinessBlock(input: {
  status?: string | null;
  health?: string | null;
  missingDocumentKeys?: string[] | null;
  blockingDecisionQuestionCount?: number | null;
  planApproval?: {
    status?: string | null;
    requiresApproval?: boolean | null;
  } | null;
} | null) {
  if (!input) return "Issue continuity has not been prepared yet";
  const planApprovalBlocked =
    input.planApproval?.requiresApproval === true ||
    input.planApproval?.status === "pending" ||
    input.planApproval?.status === "revision_requested";
  if (input.status === "awaiting_decision" && planApprovalBlocked) {
    return "Issue planning is waiting on board plan approval";
  }
  if (input.status === "awaiting_decision" || (input.blockingDecisionQuestionCount ?? 0) > 0) {
    return "Issue planning is waiting on a blocking decision question";
  }
  if (input.health === "invalid_handoff") {
    return "Issue continuity is invalid: repair the pending handoff before starting execution";
  }
  if ((input.missingDocumentKeys?.length ?? 0) > 0) {
    return `Issue planning is incomplete: missing required docs ${input.missingDocumentKeys?.join(", ")}`;
  }
  return null;
}

function issueActorPrincipal(req: Request): ParsedExecutionState["currentParticipant"] | null {
  if (req.actor.type === "agent" && req.actor.agentId) {
    return { type: "agent", agentId: req.actor.agentId, userId: null };
  }
  if (req.actor.type === "board" && req.actor.userId) {
    return { type: "user", userId: req.actor.userId, agentId: null };
  }
  return null;
}

function isContinuityOwnerActor(
  req: Request,
  issue: { assigneeAgentId: string | null; assigneeUserId?: string | null },
) {
  if (req.actor.type === "board") return true;
  if (req.actor.type === "agent" && req.actor.agentId) {
    return issue.assigneeAgentId === req.actor.agentId;
  }
  return false;
}

function isActiveExecutionParticipantActor(
  req: Request,
  issue: { executionState?: unknown },
) {
  const executionState = parseIssueExecutionState(issue.executionState ?? null);
  return executionPrincipalsEqual(executionState?.currentParticipant ?? null, issueActorPrincipal(req));
}

function requestedAssigneeTarget(input: { assigneeAgentId?: string | null; assigneeUserId?: string | null }) {
  if (input.assigneeAgentId) return `agent:${input.assigneeAgentId}`;
  if (input.assigneeUserId) return `user:${input.assigneeUserId}`;
  return null;
}

function isClosedIssueStatus(status: string | null | undefined): status is "done" | "cancelled" {
  return status === "done" || status === "cancelled";
}

function shouldImplicitlyReopenCommentForAgent(input: {
  issueStatus: string | null | undefined;
  assigneeAgentId: string | null | undefined;
  actorType: "agent" | "user";
  actorId: string;
}) {
  if (!isClosedIssueStatus(input.issueStatus)) return false;
  if (typeof input.assigneeAgentId !== "string" || input.assigneeAgentId.length === 0) return false;
  if (input.actorType === "agent" && input.actorId === input.assigneeAgentId) return false;
  return true;
}

function summarizeIssueRelationForActivity(relation: {
  id: string;
  identifier: string | null;
  title: string;
}): ActivityIssueRelationSummary {
  return {
    id: relation.id,
    identifier: relation.identifier,
    title: relation.title,
  };
}

function summarizeIssueReferenceActivityDetails(input:
  | {
      addedReferencedIssues: ActivityIssueRelationSummary[];
      removedReferencedIssues: ActivityIssueRelationSummary[];
      currentReferencedIssues: ActivityIssueRelationSummary[];
    }
  | null
  | undefined,
) {
  if (!input) return {};
  return {
    referencedIssueIds: input.currentReferencedIssues.map((issue) => issue.id),
    referencedIssueIdentifiers: input.currentReferencedIssues.map((issue) => issue.identifier).filter(Boolean),
    referencedIssues: input.currentReferencedIssues,
    addedReferencedIssues: input.addedReferencedIssues,
    removedReferencedIssues: input.removedReferencedIssues,
  };
}

function activityExecutionParticipantKey(participant: ActivityExecutionParticipant): string {
  return participant.type === "agent" ? `agent:${participant.agentId}` : `user:${participant.userId}`;
}

function summarizeExecutionParticipants(
  policy: NormalizedExecutionPolicy | null,
  stageType: NormalizedExecutionPolicy["stages"][number]["type"],
): ActivityExecutionParticipant[] {
  const stage = policy?.stages.find((candidate) => candidate.type === stageType);
  return (
    stage?.participants.map((participant) => ({
      type: participant.type,
      agentId: participant.agentId ?? null,
      userId: participant.userId ?? null,
    })) ?? []
  );
}

function diffExecutionParticipants(
  previousPolicy: NormalizedExecutionPolicy | null,
  nextPolicy: NormalizedExecutionPolicy | null,
  stageType: NormalizedExecutionPolicy["stages"][number]["type"],
) {
  const previousParticipants = summarizeExecutionParticipants(previousPolicy, stageType);
  const nextParticipants = summarizeExecutionParticipants(nextPolicy, stageType);
  const previousByKey = new Map(previousParticipants.map((participant) => [
    activityExecutionParticipantKey(participant),
    participant,
  ]));
  const nextByKey = new Map(nextParticipants.map((participant) => [
    activityExecutionParticipantKey(participant),
    participant,
  ]));

  return {
    participants: nextParticipants,
    addedParticipants: nextParticipants.filter((participant) => !previousByKey.has(activityExecutionParticipantKey(participant))),
    removedParticipants: previousParticipants.filter((participant) => !nextByKey.has(activityExecutionParticipantKey(participant))),
  };
}

function buildExecutionStageWakeup(input: {
  issueId: string;
  previousState: ParsedExecutionState | null;
  nextState: ParsedExecutionState | null;
  interruptedRunId: string | null;
  requestedByActorType: "user" | "agent";
  requestedByActorId: string;
}) {
  const { issueId, previousState, nextState, interruptedRunId } = input;
  if (!nextState) return null;

  if (nextState.status === "pending") {
    const agentId =
      nextState.currentParticipant?.type === "agent" ? (nextState.currentParticipant.agentId ?? null) : null;
    const stageChanged =
      previousState?.status !== "pending" ||
      previousState?.currentStageId !== nextState.currentStageId ||
      !executionPrincipalsEqual(previousState?.currentParticipant ?? null, nextState.currentParticipant ?? null);
    if (!agentId || !stageChanged) return null;

    const reason =
      nextState.currentStageType === "approval" ? "execution_approval_requested" : "execution_review_requested";
    const executionStage = buildExecutionStageWakeContext({
      state: nextState,
      wakeRole: nextState.currentStageType === "approval" ? "approver" : "reviewer",
      allowedActions: ["approve", "request_changes"],
    });

    return {
      agentId,
      wakeup: {
        source: "assignment" as const,
        triggerDetail: "system" as const,
        reason,
        payload: {
          issueId,
          mutation: "update",
          executionStage,
          ...(interruptedRunId ? { interruptedRunId } : {}),
        },
        requestedByActorType: input.requestedByActorType,
        requestedByActorId: input.requestedByActorId,
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: reason,
          source: "issue.execution_stage",
          executionStage,
          ...(interruptedRunId ? { interruptedRunId } : {}),
        },
      },
    };
  }

  if (nextState.status === "changes_requested") {
    const agentId = nextState.returnAssignee?.type === "agent" ? (nextState.returnAssignee.agentId ?? null) : null;
    const becameChangesRequested =
      previousState?.status !== "changes_requested" ||
      previousState?.lastDecisionId !== nextState.lastDecisionId ||
      !executionPrincipalsEqual(previousState?.returnAssignee ?? null, nextState.returnAssignee ?? null);
    if (!agentId || !becameChangesRequested) return null;

    const executionStage = buildExecutionStageWakeContext({
      state: nextState,
      wakeRole: "executor",
      allowedActions: ["address_changes", "resubmit"],
    });

    return {
      agentId,
      wakeup: {
        source: "assignment" as const,
        triggerDetail: "system" as const,
        reason: "execution_changes_requested",
        payload: {
          issueId,
          mutation: "update",
          executionStage,
          ...(interruptedRunId ? { interruptedRunId } : {}),
        },
        requestedByActorType: input.requestedByActorType,
        requestedByActorId: input.requestedByActorId,
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "execution_changes_requested",
          source: "issue.execution_stage",
          executionStage,
          ...(interruptedRunId ? { interruptedRunId } : {}),
        },
      },
    };
  }

  return null;
}

export function issueRoutes(
  db: Db,
  storage: StorageService,
  opts?: {
    feedbackExportService?: {
      flushPendingFeedbackTraces(input?: {
        companyId?: string;
        traceId?: string;
        limit?: number;
        now?: Date;
      }): Promise<unknown>;
    };
    services?: Partial<IssueRouteDeps>;
    telemetry?: {
      getTelemetryClient?: typeof getTelemetryClient;
      trackAgentTaskCompleted?: typeof trackAgentTaskCompleted;
    };
  },
) {
  const router = Router();
  const svc = opts?.services?.issueService ?? issueService(db);
  const access = opts?.services?.accessService ?? accessService(db);
  const heartbeat = opts?.services?.heartbeatService ?? heartbeatService(db);
  const feedback = opts?.services?.feedbackService ?? feedbackService(db);
  const instanceSettings = opts?.services?.instanceSettingsService ?? instanceSettingsService(db);
  const agentsSvc = opts?.services?.agentService ?? agentService(db);
  const officeCoordinationSvc =
    opts?.services?.officeCoordinationService ?? officeCoordinationService(db);
  const projectsSvc = opts?.services?.projectService ?? projectService(db);
  const goalsSvc = opts?.services?.goalService ?? goalService(db);
  const issueApprovalsSvc = opts?.services?.issueApprovalService ?? issueApprovalService(db);
  const continuitySvc = opts?.services?.issueContinuityService
    ?? (typeof issueContinuityService === "function"
      ? issueContinuityService(db)
      : createFallbackIssueContinuityService());
  const decisionQuestionsSvc = opts?.services?.issueDecisionQuestionService
    ?? (typeof issueDecisionQuestionService === "function"
      ? issueDecisionQuestionService(db)
      : createFallbackIssueDecisionQuestionService());
  const executionWorkspacesSvc =
    opts?.services?.executionWorkspaceService ?? executionWorkspaceService(db);
  const workProductsSvc = opts?.services?.workProductService ?? workProductService(db);
  const documentsSvc = opts?.services?.documentService ?? documentService(db);
  const issueReferencesSvc = opts?.services?.issueReferenceService
    ?? (typeof issueReferenceService === "function"
      ? issueReferenceService(db)
      : createFallbackIssueReferenceService());
  const routinesSvc = opts?.services?.routineService ?? routineService(db);
  const conferenceContext = opts?.services?.conferenceContextService ?? conferenceContextService(db);
  const logActivity = opts?.services?.logActivity ?? baseLogActivity;
  const feedbackExportService = opts?.feedbackExportService;
  const getTelemetryClientFn =
    opts?.telemetry?.getTelemetryClient ?? getTelemetryClient;
  const trackAgentTaskCompletedFn =
    opts?.telemetry?.trackAgentTaskCompleted ?? trackAgentTaskCompleted;
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 },
  });

  function activeExecutionDocumentApprovalError(documentKey: string, action: "Editing" | "Restoring" | "Deleting") {
    if (documentKey === "spec") {
      return `${action} a frozen spec requires an approved linked approval`;
    }
    return `${action} ${documentKey} during active execution requires an approved linked approval`;
  }

  async function requireApprovedLinkedApprovalForActiveDocumentEdit(
    res: Response,
    issueId: string,
    documentKey: string,
    continuityActive: boolean,
    action: "Editing" | "Restoring" | "Deleting",
  ) {
    if (!continuityActive || !EXECUTION_APPROVAL_GATED_DOCUMENT_KEYS.has(documentKey)) return true;
    const linkedApprovals = await issueApprovalsSvc.listApprovalsForIssue(issueId);
    if (linkedApprovals.some((approval) => approval.status === "approved")) return true;
    res.status(403).json({ error: activeExecutionDocumentApprovalError(documentKey, action) });
    return false;
  }

  function withContentPath<T extends { id: string }>(attachment: T) {
    return {
      ...attachment,
      contentPath: `/api/attachments/${attachment.id}/content`,
    };
  }

  async function buildIssueAttachmentGovernance() {
    const settings = await instanceSettings.getGeneral();
    const retentionClass = settings.enterprisePolicy.defaultAttachmentRetentionClass;
    const now = new Date();
    return {
      scanStatus: "clean" as const,
      scanProvider: settings.enterprisePolicy.enforceAttachmentScanning ? "builtin_metadata_guard" : null,
      scanCompletedAt: settings.enterprisePolicy.enforceAttachmentScanning ? now : null,
      quarantinedAt: null,
      quarantineReason: null,
      retentionClass,
      expiresAt: retentionClass === "temporary"
        ? new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
        : null,
      legalHold: false,
    };
  }

  function parseBooleanQuery(value: unknown) {
    return value === true || value === "true" || value === "1";
  }

  function parseDateQuery(value: unknown, field: string) {
    if (typeof value !== "string" || value.trim().length === 0) return undefined;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new HttpError(400, `Invalid ${field} query value`);
    }
    return parsed;
  }

  function getConferenceActor(req: Request) {
    return req.actor.type === "agent" ? "agent" : "board";
  }

  async function runSingleFileUpload(req: Request, res: Response) {
    await new Promise<void>((resolve, reject) => {
      upload.single("file")(req, res, (err: unknown) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async function assertCanManageIssueApprovalLinks(req: Request, res: Response, companyId: string) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "board") return true;
    if (!req.actor.agentId) {
      res.status(403).json({ error: "Agent authentication required" });
      return false;
    }
    const actorAgent = await agentsSvc.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== companyId) {
      res.status(403).json({ error: "Forbidden" });
      return false;
    }
    if (agentHasCreatePermission(actorAgent)) return true;
    res.status(403).json({ error: "Missing permission to link approvals" });
    return false;
  }

  function actorCanAccessCompany(req: Request, companyId: string) {
    if (req.actor.type === "none") return false;
    if (req.actor.type === "agent") return req.actor.companyId === companyId;
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return true;
    return (req.actor.companyIds ?? []).includes(companyId);
  }

  async function assertCanAssignTasks(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "board") {
      if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
      const allowed = await access.canUser(companyId, req.actor.userId, "tasks:assign");
      if (!allowed) throw forbidden("Missing permission: tasks:assign");
      return;
    }
    if (req.actor.type === "agent") {
      if (!req.actor.agentId) throw forbidden("Agent authentication required");
      const allowedByGrant = await access.hasPermission(companyId, "agent", req.actor.agentId, "tasks:assign");
      if (allowedByGrant) return;
      const actorAgent = await agentsSvc.getById(req.actor.agentId);
      if (actorAgent && actorAgent.companyId === companyId && agentHasCreatePermission(actorAgent)) return;
      throw forbidden("Missing permission: tasks:assign");
    }
    throw unauthorized();
  }

  function requireAgentRunId(req: Request, res: Response) {
    if (req.actor.type !== "agent") return null;
    const runId = req.actor.runId?.trim();
    if (runId) return runId;
    res.status(401).json({ error: "Agent run id required" });
    return null;
  }

  async function hasActiveCheckoutManagementOverride(
    actorAgentId: string,
    companyId: string,
    assigneeAgentId: string,
  ) {
    const allowedByGrant = await access.hasPermission(
      companyId,
      "agent",
      actorAgentId,
      "tasks:manage_active_checkouts",
    );
    if (allowedByGrant) return true;

    const companyAgents = await agentsSvc.list(companyId);
    const agentsById = new Map(companyAgents.map((agent) => [agent.id, agent]));
    const actorAgent = agentsById.get(actorAgentId);
    if (!actorAgent) return false;
    if (agentHasCreatePermission(actorAgent)) return true;

    let cursor: string | null = assigneeAgentId;
    for (let depth = 0; cursor && depth < 50; depth += 1) {
      const assignee = agentsById.get(cursor);
      if (!assignee) return false;
      if (assignee.reportsTo === actorAgentId) return true;
      cursor = assignee.reportsTo;
    }

    return false;
  }

  async function assertAgentIssueMutationAllowed(
    req: Request,
    res: Response,
    issue: { id: string; companyId: string; status: string; assigneeAgentId: string | null },
  ) {
    if (req.actor.type !== "agent") return true;
    const actorAgentId = req.actor.agentId;
    if (!actorAgentId) {
      res.status(403).json({ error: "Agent authentication required" });
      return false;
    }
    if (issue.status !== "in_progress" || issue.assigneeAgentId === null) {
      return true;
    }
    if (issue.assigneeAgentId !== actorAgentId) {
      if (await hasActiveCheckoutManagementOverride(actorAgentId, issue.companyId, issue.assigneeAgentId)) {
        return true;
      }
      res.status(409).json({
        error: "Issue is checked out by another agent",
        details: {
          issueId: issue.id,
          assigneeAgentId: issue.assigneeAgentId,
          actorAgentId,
        },
      });
      return false;
    }
    const runId = requireAgentRunId(req, res);
    if (!runId) return false;
    const ownership = await svc.assertCheckoutOwner(issue.id, actorAgentId, runId);
    if (ownership.adoptedFromRunId) {
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.checkout_lock_adopted",
        entityType: "issue",
        entityId: issue.id,
        details: {
          previousCheckoutRunId: ownership.adoptedFromRunId,
          checkoutRunId: runId,
          reason: "stale_checkout_run",
        },
      });
    }
    return true;
  }

  async function resolveActiveIssueRun(issue: {
    id: string;
    assigneeAgentId: string | null;
    executionRunId?: string | null;
  }) {
    let runToInterrupt = issue.executionRunId ? await heartbeat.getRun(issue.executionRunId) : null;

    if ((!runToInterrupt || runToInterrupt.status !== "running") && issue.assigneeAgentId) {
      const activeRun = await heartbeat.getActiveRunForAgent(issue.assigneeAgentId);
      const activeIssueId =
        activeRun &&
        activeRun.contextSnapshot &&
        typeof activeRun.contextSnapshot === "object" &&
        typeof (activeRun.contextSnapshot as Record<string, unknown>).issueId === "string"
          ? ((activeRun.contextSnapshot as Record<string, unknown>).issueId as string)
          : null;
      if (activeRun && activeRun.status === "running" && activeIssueId === issue.id) {
        runToInterrupt = activeRun;
      }
    }

    return runToInterrupt?.status === "running" ? runToInterrupt : null;
  }

  function toValidTimestamp(value: Date | string | null | undefined) {
    if (!value) return null;
    const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  function isQueuedIssueCommentForActiveRun(params: {
    comment: {
      authorAgentId?: string | null;
      createdAt?: Date | string | null;
    };
    activeRun: {
      agentId?: string | null;
      startedAt?: Date | string | null;
      createdAt?: Date | string | null;
    };
  }) {
    const activeRunStartedAtMs =
      toValidTimestamp(params.activeRun.startedAt) ?? toValidTimestamp(params.activeRun.createdAt);
    const commentCreatedAtMs = toValidTimestamp(params.comment.createdAt);

    if (activeRunStartedAtMs === null || commentCreatedAtMs === null) return false;
    if (params.comment.authorAgentId && params.comment.authorAgentId === params.activeRun.agentId) return false;
    return commentCreatedAtMs >= activeRunStartedAtMs;
  }

  async function getClosedIssueExecutionWorkspace(issue: { executionWorkspaceId?: string | null }) {
    if (!issue.executionWorkspaceId) return null;
    const workspace = await executionWorkspacesSvc.getById(issue.executionWorkspaceId);
    if (!workspace || !isClosedIsolatedExecutionWorkspace(workspace)) return null;
    return workspace;
  }

  function respondClosedIssueExecutionWorkspace(
    res: Response,
    workspace: Pick<ExecutionWorkspace, "closedAt" | "id" | "mode" | "name" | "status">,
  ) {
    res.status(409).json({
      error: getClosedIsolatedExecutionWorkspaceMessage(workspace),
      executionWorkspace: workspace,
    });
  }

  async function normalizeIssueIdentifier(rawId: string): Promise<string> {
    if (/^[A-Z]+-\d+$/i.test(rawId)) {
      const issue = await svc.getByIdentifier(rawId);
      if (issue) {
        return issue.id;
      }
    }
    return rawId;
  }

  async function resolveIssueProjectAndGoal(issue: {
    companyId: string;
    projectId: string | null;
    goalId: string | null;
  }) {
    const projectPromise = issue.projectId ? projectsSvc.getById(issue.projectId) : Promise.resolve(null);
    const directGoalPromise = issue.goalId ? goalsSvc.getById(issue.goalId) : Promise.resolve(null);
    const [project, directGoal] = await Promise.all([projectPromise, directGoalPromise]);

    if (directGoal) {
      return { project, goal: directGoal };
    }

    const projectGoalId = project?.goalId ?? project?.goalIds[0] ?? null;
    if (projectGoalId) {
      const projectGoal = await goalsSvc.getById(projectGoalId);
      return { project, goal: projectGoal };
    }

    if (!issue.projectId) {
      const defaultGoal = await goalsSvc.getDefaultCompanyGoal(issue.companyId);
      return { project, goal: defaultGoal };
    }

    return { project, goal: null };
  }

  // Resolve issue identifiers (e.g. "PAP-39") to UUIDs for all /issues/:id routes
  router.param("id", async (req, res, next, rawId) => {
    try {
      req.params.id = await normalizeIssueIdentifier(rawId);
      next();
    } catch (err) {
      next(err);
    }
  });

  // Resolve issue identifiers (e.g. "PAP-39") to UUIDs for company-scoped attachment routes.
  router.param("issueId", async (req, res, next, rawId) => {
    try {
      req.params.issueId = await normalizeIssueIdentifier(rawId);
      next();
    } catch (err) {
      next(err);
    }
  });

  // Common malformed path when companyId is empty in "/api/companies/{companyId}/issues".
  router.get("/issues", (_req, res) => {
    res.status(400).json({
      error: "Missing companyId in path. Use /api/companies/{companyId}/issues.",
    });
  });

  router.get("/companies/:companyId/issues", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const assigneeUserFilterRaw = req.query.assigneeUserId as string | undefined;
    const touchedByUserFilterRaw = req.query.touchedByUserId as string | undefined;
    const inboxArchivedByUserFilterRaw = req.query.inboxArchivedByUserId as string | undefined;
    const unreadForUserFilterRaw = req.query.unreadForUserId as string | undefined;
    const assigneeUserId =
      assigneeUserFilterRaw === "me" && req.actor.type === "board"
        ? req.actor.userId
        : assigneeUserFilterRaw;
    const touchedByUserId =
      touchedByUserFilterRaw === "me" && req.actor.type === "board"
        ? req.actor.userId
        : touchedByUserFilterRaw;
    const inboxArchivedByUserId =
      inboxArchivedByUserFilterRaw === "me" && req.actor.type === "board"
        ? req.actor.userId
        : inboxArchivedByUserFilterRaw;
    const unreadForUserId =
      unreadForUserFilterRaw === "me" && req.actor.type === "board"
        ? req.actor.userId
        : unreadForUserFilterRaw;
    const rawLimit = req.query.limit as string | undefined;
    const parsedLimit = rawLimit !== undefined && /^\d+$/.test(rawLimit)
      ? Number.parseInt(rawLimit, 10)
      : null;
    const limit = parsedLimit === null ? ISSUE_LIST_DEFAULT_LIMIT : clampIssueListLimit(parsedLimit);

    if (assigneeUserFilterRaw === "me" && (!assigneeUserId || req.actor.type !== "board")) {
      res.status(403).json({ error: "assigneeUserId=me requires board authentication" });
      return;
    }
    if (touchedByUserFilterRaw === "me" && (!touchedByUserId || req.actor.type !== "board")) {
      res.status(403).json({ error: "touchedByUserId=me requires board authentication" });
      return;
    }
    if (inboxArchivedByUserFilterRaw === "me" && (!inboxArchivedByUserId || req.actor.type !== "board")) {
      res.status(403).json({ error: "inboxArchivedByUserId=me requires board authentication" });
      return;
    }
    if (unreadForUserFilterRaw === "me" && (!unreadForUserId || req.actor.type !== "board")) {
      res.status(403).json({ error: "unreadForUserId=me requires board authentication" });
      return;
    }
    if (rawLimit !== undefined && (parsedLimit === null || !Number.isInteger(parsedLimit) || parsedLimit <= 0)) {
      res.status(400).json({ error: `limit must be a positive integer up to ${ISSUE_LIST_MAX_LIMIT}` });
      return;
    }

    const result = await svc.list(companyId, {
      status: req.query.status as string | undefined,
      assigneeAgentId: req.query.assigneeAgentId as string | undefined,
      participantAgentId: req.query.participantAgentId as string | undefined,
      assigneeUserId,
      touchedByUserId,
      inboxArchivedByUserId,
      unreadForUserId,
      projectId: req.query.projectId as string | undefined,
      executionWorkspaceId: req.query.executionWorkspaceId as string | undefined,
      parentId: req.query.parentId as string | undefined,
      labelId: req.query.labelId as string | undefined,
      originKind: req.query.originKind as string | undefined,
      originId: req.query.originId as string | undefined,
      includeRoutineExecutions:
        req.query.includeRoutineExecutions === "true" || req.query.includeRoutineExecutions === "1",
      q: req.query.q as string | undefined,
      limit,
    });
    res.json(result.map((issue) => withIssueContinuitySummary(issue)));
  });

  router.get("/companies/:companyId/issue-questions", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board user context required" });
      return;
    }
    const status = (req.query.status as string | undefined) ?? "open";
    if (status !== "open") {
      res.status(400).json({ error: "Only status=open is supported" });
      return;
    }
    const rawLimit = req.query.limit as string | undefined;
    const parsedLimit = rawLimit ? Number.parseInt(rawLimit, 10) : 25;
    if (!Number.isInteger(parsedLimit) || parsedLimit <= 0) {
      res.status(400).json({ error: "limit must be a positive integer" });
      return;
    }
    res.json(await decisionQuestionsSvc.listOpenForCompanyWithIssues(companyId, parsedLimit));
  });

  router.get("/companies/:companyId/labels", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.listLabels(companyId);
    res.json(result);
  });

  router.post("/companies/:companyId/labels", validate(createIssueLabelSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const label = await svc.createLabel(companyId, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "label.created",
      entityType: "label",
      entityId: label.id,
      details: { name: label.name, color: label.color },
    });
    res.status(201).json(label);
  });

  router.delete("/labels/:labelId", async (req, res) => {
    const labelId = req.params.labelId as string;
    const existing = await svc.getLabelById(labelId);
    if (!existing) {
      res.status(404).json({ error: "Label not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const removed = await svc.deleteLabel(labelId);
    if (!removed) {
      res.status(404).json({ error: "Label not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: removed.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "label.deleted",
      entityType: "label",
      entityId: removed.id,
      details: { name: removed.name, color: removed.color },
    });
    res.json(removed);
  });

  router.get("/issues/:id", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const [continuityState, { project, goal }, ancestors, mentionedProjectIds, documentPayload, relations, continuationSummary, referenceSummary] = await Promise.all([
      continuitySvc.recomputeIssueContinuityState(issue.id),
      resolveIssueProjectAndGoal(issue),
      svc.getAncestors(issue.id),
      svc.findMentionedProjectIds(issue.id),
      documentsSvc.getIssueDocumentPayload(issue),
      svc.getRelationSummaries(issue.id),
      documentsSvc.getIssueDocumentByKey(issue.id, ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY),
      issueReferencesSvc.listIssueReferenceSummary(issue.id),
    ]);
    const mentionedProjects = mentionedProjectIds.length > 0
      ? await projectsSvc.listByIds(issue.companyId, mentionedProjectIds)
      : [];
    const currentExecutionWorkspace = issue.executionWorkspaceId
      ? await executionWorkspacesSvc.getById(issue.executionWorkspaceId)
      : null;
    const workProducts = await workProductsSvc.listForIssue(issue.id);
    res.json(withIssueContinuitySummary({
      ...issue,
      continuityState,
      goalId: goal?.id ?? issue.goalId,
      ancestors,
      blockedBy: relations.blockedBy,
      blocks: relations.blocks,
      relatedWork: referenceSummary,
      referencedIssueIdentifiers: referenceSummary.outbound.map((item) => item.issue.identifier ?? item.issue.id),
      ...documentPayload,
      project: project ?? null,
      goal: goal ?? null,
      mentionedProjects,
      currentExecutionWorkspace,
      workProducts,
      continuationSummary: continuationSummary
        ? {
            key: continuationSummary.key,
            title: continuationSummary.title,
            body: continuationSummary.body,
            latestRevisionId: continuationSummary.latestRevisionId,
            latestRevisionNumber: continuationSummary.latestRevisionNumber,
            updatedAt: continuationSummary.updatedAt,
          }
        : null,
    }));
  });

  router.get("/issues/:id/continuity", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    res.json(await continuitySvc.getIssueContinuity(issue.id, {
      agentId: req.actor.type === "agent" ? req.actor.agentId ?? null : null,
      userId: req.actor.type === "board" ? req.actor.userId ?? null : null,
      isBoard: req.actor.type === "board",
    }));
  });

  router.get("/issues/:id/questions", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    res.json(await decisionQuestionsSvc.listForIssue(issue.id));
  });

  router.post("/issues/:id/questions", validate(createIssueDecisionQuestionSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const actor = getActorInfo(req);
    const result = await decisionQuestionsSvc.create(issue.id, req.body, {
      agentId: actor.agentId ?? null,
      userId: actor.actorType === "user" ? actor.actorId : null,
    });
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.question_created",
      entityType: "issue",
      entityId: issue.id,
      details: {
        questionId: result.question?.id ?? null,
        blocking: req.body.blocking === true,
        title: req.body.title,
      },
    });
    res.status(201).json(result);
  });

  router.post("/issues/:id/continuity/prepare", validate(prepareIssueContinuitySchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (!isContinuityOwnerActor(req, issue)) {
      res.status(403).json({ error: "Only the continuity owner can prepare execution" });
      return;
    }
    const actor = getActorInfo(req);
    const result = await continuitySvc.prepare(issue.id, req.body, {
      agentId: actor.agentId ?? null,
      userId: actor.actorType === "user" ? actor.actorId : null,
      runId: actor.runId ?? null,
    });
    if (result.planApprovalRequest?.approvalId) {
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.plan_approval_requested",
        entityType: "issue",
        entityId: issue.id,
        details: {
          approvalId: result.planApprovalRequest.approvalId,
          approvalStatus: result.planApprovalRequest.approvalStatus,
          planRevisionId: result.continuityState?.planApproval.currentPlanRevisionId ?? null,
          source: "continuity_prepare",
        },
      });
    }
    res.json(result);
  });

  router.post("/issues/:id/continuity/plan-approval", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (!isContinuityOwnerActor(req, issue)) {
      res.status(403).json({ error: "Only the continuity owner can request plan approval" });
      return;
    }
    const actor = getActorInfo(req);
    const result = await continuitySvc.requestPlanApproval(issue.id, {
      agentId: actor.agentId ?? null,
      userId: actor.actorType === "user" ? actor.actorId : null,
    });
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.plan_approval_requested",
      entityType: "issue",
      entityId: issue.id,
      details: {
        approvalId: result.approvalId,
        approvalStatus: result.approvalStatus,
        planRevisionId: result.continuityState?.planApproval.currentPlanRevisionId ?? null,
      },
    });
    res.json(result);
  });

  router.post("/issues/:id/continuity/handoff", validate(handoffIssueContinuitySchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (!isContinuityOwnerActor(req, issue)) {
      res.status(403).json({ error: "Only the continuity owner can start a handoff" });
      return;
    }
    if (req.body.assigneeAgentId || req.body.assigneeUserId) {
      await assertCanAssignTasks(req, issue.companyId);
    }
    const actor = getActorInfo(req);
    res.json(
      await continuitySvc.handoff(issue.id, req.body, {
        agentId: actor.agentId ?? null,
        userId: actor.actorType === "user" ? actor.actorId : null,
        runId: actor.runId ?? null,
      }),
    );
  });

  router.post("/issues/:id/continuity/progress-checkpoint", validate(progressCheckpointIssueContinuitySchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (!isContinuityOwnerActor(req, issue)) {
      res.status(403).json({ error: "Only the continuity owner can add progress checkpoints" });
      return;
    }
    const actor = getActorInfo(req);
    res.json(await continuitySvc.progressCheckpoint(issue.id, req.body, {
      agentId: actor.agentId ?? null,
      userId: actor.actorType === "user" ? actor.actorId : null,
      runId: actor.runId ?? null,
    }));
  });

  router.post("/issues/:id/continuity/review-return", validate(reviewReturnIssueContinuitySchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    if (!isActiveExecutionParticipantActor(req, existing)) {
      res.status(403).json({ error: "Only the active reviewer or approver can return findings" });
      return;
    }
    const actor = getActorInfo(req);
    const result = await continuitySvc.reviewReturn(existing.id, req.body, {
      agentId: actor.agentId ?? null,
      userId: actor.actorType === "user" ? actor.actorId : null,
      runId: actor.runId ?? null,
    });
    const executionStageWakeup = buildExecutionStageWakeup({
      issueId: existing.id,
      previousState: parseIssueExecutionState(existing.executionState),
      nextState: parseIssueExecutionState(result.issue?.executionState),
      interruptedRunId: null,
      requestedByActorType: actor.actorType,
      requestedByActorId: actor.actorId,
    });
    if (executionStageWakeup) {
      void heartbeat
        .wakeup(executionStageWakeup.agentId, executionStageWakeup.wakeup)
        .catch((err) => logger.warn({ err, issueId: existing.id }, "failed to wake agent after review return"));
    }
    res.json(result);
  });

  router.post("/issues/:id/continuity/review-resubmit", validate(reviewResubmitIssueContinuitySchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    if (!isContinuityOwnerActor(req, existing)) {
      res.status(403).json({ error: "Only the continuity owner can resubmit after findings" });
      return;
    }
    const actor = getActorInfo(req);
    const result = await continuitySvc.reviewResubmit(existing.id, req.body, {
      agentId: actor.agentId ?? null,
      userId: actor.actorType === "user" ? actor.actorId : null,
      runId: actor.runId ?? null,
    });
    const executionStageWakeup = buildExecutionStageWakeup({
      issueId: existing.id,
      previousState: parseIssueExecutionState(existing.executionState),
      nextState: parseIssueExecutionState(result.issue?.executionState),
      interruptedRunId: null,
      requestedByActorType: actor.actorType,
      requestedByActorId: actor.actorId,
    });
    if (executionStageWakeup) {
      void heartbeat
        .wakeup(executionStageWakeup.agentId, executionStageWakeup.wakeup)
        .catch((err) => logger.warn({ err, issueId: existing.id }, "failed to wake agent after review resubmit"));
    }
    res.json(result);
  });

  router.post(
    "/issues/:id/continuity/review-findings/:findingId/promote-skill",
    validate(promoteIssueReviewFindingSkillSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const findingId = req.params.findingId as string;
      const issue = await svc.getById(id);
      if (!issue) {
        res.status(404).json({ error: "Issue not found" });
        return;
      }
      assertCompanyAccess(req, issue.companyId);
      if (!isContinuityOwnerActor(req, issue)) {
        res.status(403).json({ error: "Only the continuity owner can promote review findings into skill hardening work" });
        return;
      }
      const actor = getActorInfo(req);
      const result = await continuitySvc.promoteReviewFindingSkill(issue.id, findingId, req.body, {
        agentId: actor.agentId ?? null,
        userId: actor.actorType === "user" ? actor.actorId : null,
        runId: actor.runId ?? null,
      });
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.review_finding_skill_promoted",
        entityType: "issue",
        entityId: issue.id,
        details: {
          findingId,
          hardeningIssueId: result.hardeningIssue?.id ?? null,
          hardeningIssueIdentifier: result.hardeningIssue?.identifier ?? null,
        },
      });
      res.json(result);
    },
  );

  router.post("/issues/:id/continuity/handoff-repair", validate(handoffRepairIssueContinuitySchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (!isContinuityOwnerActor(req, issue)) {
      res.status(403).json({ error: "Only the continuity owner can repair handoff state" });
      return;
    }
    const actor = getActorInfo(req);
    res.json(await continuitySvc.handoffRepair(issue.id, req.body, {
      agentId: actor.agentId ?? null,
      userId: actor.actorType === "user" ? actor.actorId : null,
      runId: actor.runId ?? null,
    }));
  });

  router.post("/issues/:id/continuity/handoff-cancel", validate(handoffCancelIssueContinuitySchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (!isContinuityOwnerActor(req, issue)) {
      res.status(403).json({ error: "Only the continuity owner can cancel a pending handoff" });
      return;
    }
    const actor = getActorInfo(req);
    res.json(await continuitySvc.handoffCancel(issue.id, req.body, {
      agentId: actor.agentId ?? null,
      userId: actor.actorType === "user" ? actor.actorId : null,
      runId: actor.runId ?? null,
    }));
  });

  router.post("/issues/:id/continuity/spec-thaw", validate(requestIssueSpecThawSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (!isContinuityOwnerActor(req, issue)) {
      res.status(403).json({ error: "Only the continuity owner can request a spec thaw" });
      return;
    }
    const actor = getActorInfo(req);
    res.json(
      await continuitySvc.requestSpecThaw(issue.id, req.body, {
        agentId: actor.agentId ?? null,
        userId: actor.actorType === "user" ? actor.actorId : null,
      }),
    );
  });

  router.post("/issues/:id/continuity/branches", validate(createIssueContinuityBranchSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (!isContinuityOwnerActor(req, issue)) {
      res.status(403).json({ error: "Only the continuity owner can manage branch work" });
      return;
    }
    if (req.body.action === "create" && (req.body.assigneeAgentId || req.body.assigneeUserId)) {
      await assertCanAssignTasks(req, issue.companyId);
    }
    const actor = getActorInfo(req);
    const result = await continuitySvc.mutateBranch(issue.id, req.body, {
      agentId: actor.agentId ?? null,
      userId: actor.actorType === "user" ? actor.actorId : null,
      runId: actor.runId ?? null,
    });
    res.status(req.body.action === "create" ? 201 : 200).json(result);
  });

  router.post(
    "/issues/:id/continuity/branches/:branchIssueId/return",
    validate(returnIssueContinuityBranchSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const branchIssueId = req.params.branchIssueId as string;
      const parentIssue = await svc.getById(id);
      const branchIssue = await svc.getById(branchIssueId);
      if (!parentIssue || !branchIssue) {
        res.status(404).json({ error: "Issue not found" });
        return;
      }
      assertCompanyAccess(req, parentIssue.companyId);
      if (!isContinuityOwnerActor(req, branchIssue)) {
        res.status(403).json({ error: "Only the branch continuity owner can return branch work" });
        return;
      }
      const actor = getActorInfo(req);
      res.status(200).json(await continuitySvc.returnBranch(parentIssue.id, branchIssue.id, req.body, {
        agentId: actor.agentId ?? null,
        userId: actor.actorType === "user" ? actor.actorId : null,
        runId: actor.runId ?? null,
      }));
    },
  );

  router.get("/issues/:id/continuity/branches/:branchIssueId/merge-preview", async (req, res) => {
    const id = req.params.id as string;
    const branchIssueId = req.params.branchIssueId as string;
    const parentIssue = await svc.getById(id);
    if (!parentIssue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, parentIssue.companyId);
    if (!isContinuityOwnerActor(req, parentIssue)) {
      res.status(403).json({ error: "Only the parent continuity owner can preview branch merges" });
      return;
    }
    res.json(await continuitySvc.getBranchMergePreview(parentIssue.id, branchIssueId));
  });

  router.post(
    "/issues/:id/continuity/branches/:branchIssueId/merge",
    validate(mergeIssueContinuityBranchSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const branchIssueId = req.params.branchIssueId as string;
      const parentIssue = await svc.getById(id);
      if (!parentIssue) {
        res.status(404).json({ error: "Issue not found" });
        return;
      }
      assertCompanyAccess(req, parentIssue.companyId);
      if (!isContinuityOwnerActor(req, parentIssue)) {
        res.status(403).json({ error: "Only the parent continuity owner can merge branch returns" });
        return;
      }
      const actor = getActorInfo(req);
      res.json(await continuitySvc.mergeBranch(parentIssue.id, branchIssueId, req.body, {
        agentId: actor.agentId ?? null,
        userId: actor.actorType === "user" ? actor.actorId : null,
        runId: actor.runId ?? null,
      }));
    },
  );

  router.post("/questions/:questionId/answer", validate(answerIssueDecisionQuestionSchema), async (req, res) => {
    const questionId = req.params.questionId as string;
    if (req.actor.type !== "board" || !req.actor.userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }
    const actor = getActorInfo(req);
    const answered = await decisionQuestionsSvc.answer(questionId, req.body, { userId: req.actor.userId });
    if (!answered.question) {
      res.status(404).json({ error: "Decision question not found" });
      return;
    }
    let question = answered.question;
    let response: typeof answered | Awaited<ReturnType<typeof decisionQuestionsSvc.escalateToApproval>> = answered;
    let approvalId: string | null = null;
    const issue = await svc.getById(question.issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);

    if (answered.shouldEscalateToApproval) {
      const escalated = await decisionQuestionsSvc.escalateToApproval(questionId, {}, { userId: req.actor.userId });
      if (!escalated.question) {
        res.status(404).json({ error: "Decision question not found" });
        return;
      }
      question = escalated.question;
      approvalId = escalated.approvalId;
      response = escalated;
    }

    if (question.requestedByAgentId) {
      void heartbeat.wakeup(question.requestedByAgentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: approvalId ? "decision_question_escalated" : "decision_question_answered",
        payload: {
          issueId: issue.id,
          questionId: question.id,
          answer: question.answer,
          ...(approvalId ? { approvalId } : {}),
        },
        requestedByActorType: actor.actorType,
        requestedByActorId: actor.actorId,
        contextSnapshot: {
          issueId: issue.id,
          decisionQuestionId: question.id,
          decisionQuestionStatus: question.status,
          decisionQuestionAnswer: question.answer,
          ...(approvalId ? { linkedApprovalId: approvalId } : {}),
          source: approvalId ? "issue.question.escalate" : "issue.question.answer",
        },
      }).catch((err) => logger.warn({ err, questionId }, "failed to wake requesting agent after decision answer"));
    }

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: approvalId ? "issue.question_escalated_to_approval" : "issue.question_answered",
      entityType: "issue",
      entityId: issue.id,
      details: {
        questionId: question.id,
        selectedOptionKey: question.answer?.selectedOptionKey ?? null,
        ...(approvalId ? { approvalId } : {}),
      },
    });

    res.json(response);
  });

  router.post("/questions/:questionId/dismiss", validate(dismissIssueDecisionQuestionSchema), async (req, res) => {
    const questionId = req.params.questionId as string;
    if (req.actor.type !== "board" || !req.actor.userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }
    const actor = getActorInfo(req);
    const result = await decisionQuestionsSvc.dismiss(questionId, req.body, { userId: req.actor.userId });
    if (!result.question) {
      res.status(404).json({ error: "Decision question not found" });
      return;
    }
    const issue = await svc.getById(result.question.issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);

    if (result.question.requestedByAgentId) {
      void heartbeat.wakeup(result.question.requestedByAgentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "decision_question_dismissed",
        payload: {
          issueId: issue.id,
          questionId: result.question.id,
        },
        requestedByActorType: actor.actorType,
        requestedByActorId: actor.actorId,
        contextSnapshot: {
          issueId: issue.id,
          decisionQuestionId: result.question.id,
          decisionQuestionStatus: result.question.status,
          source: "issue.question.dismiss",
        },
      }).catch((err) => logger.warn({ err, questionId }, "failed to wake requesting agent after decision dismissal"));
    }

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.question_dismissed",
      entityType: "issue",
      entityId: issue.id,
      details: { questionId: result.question.id },
    });

    res.json(result);
  });

  router.post("/questions/:questionId/escalate-approval", validate(escalateIssueDecisionQuestionSchema), async (req, res) => {
    const questionId = req.params.questionId as string;
    if (req.actor.type !== "board" || !req.actor.userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }
    const actor = getActorInfo(req);
    const result = await decisionQuestionsSvc.escalateToApproval(questionId, req.body, { userId: req.actor.userId });
    if (!result.question) {
      res.status(404).json({ error: "Decision question not found" });
      return;
    }
    const issue = await svc.getById(result.question.issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);

    if (result.question.requestedByAgentId) {
      void heartbeat.wakeup(result.question.requestedByAgentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "decision_question_escalated",
        payload: {
          issueId: issue.id,
          questionId: result.question.id,
          approvalId: result.approvalId,
        },
        requestedByActorType: actor.actorType,
        requestedByActorId: actor.actorId,
        contextSnapshot: {
          issueId: issue.id,
          decisionQuestionId: result.question.id,
          decisionQuestionStatus: result.question.status,
          linkedApprovalId: result.approvalId,
          source: "issue.question.escalate_approval",
        },
      }).catch((err) => logger.warn({ err, questionId }, "failed to wake requesting agent after decision escalation"));
    }

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.question_escalated_to_approval",
      entityType: "issue",
      entityId: issue.id,
      details: {
        questionId: result.question.id,
        approvalId: result.approvalId,
      },
    });

    res.json(result);
  });

  router.get("/issues/:id/heartbeat-context", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);

    const wakeCommentId =
      typeof req.query.wakeCommentId === "string" && req.query.wakeCommentId.trim().length > 0
        ? req.query.wakeCommentId.trim()
        : null;

    const [{ project, goal }, ancestors, commentCursor, wakeComment, relations, attachments, continuity] =
      await Promise.all([
      resolveIssueProjectAndGoal(issue),
      svc.getAncestors(issue.id),
      svc.getCommentCursor(issue.id),
      wakeCommentId ? svc.getComment(wakeCommentId) : null,
      svc.getRelationSummaries(issue.id),
      svc.listAttachments(issue.id),
      continuitySvc.getIssueContinuity(issue.id, {
        agentId: req.actor.type === "agent" ? req.actor.agentId ?? null : null,
        userId: req.actor.type === "board" ? req.actor.userId ?? null : null,
        isBoard: req.actor.type === "board",
      }),
    ]);
    const continuityState = continuity?.continuityState ?? null;
    const executionState = continuity?.continuityBundle?.executionState ?? null;
    const planApproval = continuityState?.planApproval ?? continuity?.continuityBundle?.planApproval ?? null;
    const mode = resolveIssueHeartbeatMode({
      issueStatus: issue.status,
      continuityStatus: continuityState?.status ?? null,
      planApprovalStatus: planApproval?.status ?? null,
      planApprovalRequired: planApproval?.requiresApproval ?? false,
      executionStateStatus: executionState?.status ?? null,
      executionStageType: executionState?.currentStageType ?? null,
    });
    const executionStage =
      executionState &&
        (
          executionState.currentStageId ||
          executionState.currentStageType ||
          executionState.currentParticipant ||
          executionState.returnAssignee ||
          executionState.lastDecisionOutcome
        )
        ? {
            stageId: executionState.currentStageId,
            stageType: executionState.currentStageType,
            currentParticipant: executionState.currentParticipant,
            returnAssignee: executionState.returnAssignee,
            lastDecisionOutcome: executionState.lastDecisionOutcome,
          }
        : null;

    res.json({
      mode,
      planningMode: mode === "planning",
      continuityStatus: continuityState?.status ?? null,
      planApproval,
      executionStage,
      issue: {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description,
        status: issue.status,
        priority: issue.priority,
        projectId: issue.projectId,
        goalId: goal?.id ?? issue.goalId,
        parentId: issue.parentId,
        blockedBy: relations.blockedBy,
        blocks: relations.blocks,
        assigneeAgentId: issue.assigneeAgentId,
        assigneeUserId: issue.assigneeUserId,
        pullRequestUrl: issue.pullRequestUrl ?? null,
        updatedAt: issue.updatedAt,
      },
      ancestors: ancestors.map((ancestor) => ({
        id: ancestor.id,
        identifier: ancestor.identifier,
        title: ancestor.title,
        status: ancestor.status,
        priority: ancestor.priority,
      })),
      project: project
        ? {
            id: project.id,
            name: project.name,
            status: project.status,
            targetDate: project.targetDate,
          }
        : null,
      goal: goal
        ? {
            id: goal.id,
            title: goal.title,
            status: goal.status,
            level: goal.level,
            parentId: goal.parentId,
          }
        : null,
      commentCursor,
      wakeComment:
        wakeComment && wakeComment.issueId === issue.id
          ? wakeComment
          : null,
      attachments: attachments.map((a) => ({
        id: a.id,
        filename: a.originalFilename,
        contentType: a.contentType,
        byteSize: a.byteSize,
        contentPath: withContentPath(a).contentPath,
        createdAt: a.createdAt,
      })),
    });
  });

  router.get("/issues/:id/work-products", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const workProducts = await workProductsSvc.listForIssue(issue.id);
    res.json(workProducts);
  });

  router.get("/issues/:id/documents", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const docs = await documentsSvc.listIssueDocuments(issue.id);
    res.json(docs);
  });

  router.get("/issues/:id/documents/:key", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
      return;
    }
    const doc = await documentsSvc.getIssueDocumentByKey(issue.id, keyParsed.data);
    if (!doc) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    res.json(doc);
  });

  router.put("/issues/:id/documents/:key", validate(upsertIssueDocumentSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;
    const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
      return;
    }
    const documentKey = keyParsed.data;
    const continuityActive = isContinuityActive(issue);

    if (documentKey === "progress" && !parseIssueProgressMarkdown(req.body.body)) {
      res.status(422).json({ error: "Progress documents require paperclip/issue-progress.v1 frontmatter" });
      return;
    }
    if (documentKey === "handoff" && !parseIssueHandoffMarkdown(req.body.body)) {
      res.status(422).json({ error: "Handoff documents require paperclip/issue-handoff.v1 frontmatter" });
      return;
    }
    if (documentKey === ISSUE_BRANCH_CHARTER_DOCUMENT_KEY) {
      if (!issue.parentId) {
        res.status(422).json({ error: "Branch charter documents are only valid on child issues" });
        return;
      }
      if (!parseIssueBranchCharterMarkdown(req.body.body)) {
        res.status(422).json({ error: "Branch charter documents require paperclip/issue-branch-charter.v1 frontmatter" });
        return;
      }
    }
    if (
      continuityActive &&
      CONTINUITY_CONTROLLED_DOCUMENT_KEYS.has(documentKey) &&
      !isContinuityOwnerActor(req, issue)
    ) {
      res.status(403).json({ error: "Only the continuity owner can edit this document while execution is active" });
      return;
    }
    if (!(await requireApprovedLinkedApprovalForActiveDocumentEdit(res, issue.id, documentKey, continuityActive, "Editing"))) {
      return;
    }

    const actor = getActorInfo(req);
    const referenceSummaryBefore = await issueReferencesSvc.listIssueReferenceSummary(issue.id);
    const result = await documentsSvc.upsertIssueDocument({
      issueId: issue.id,
      key: documentKey,
      title: req.body.title ?? null,
      format: req.body.format,
      body: req.body.body,
      changeSummary: req.body.changeSummary ?? null,
      baseRevisionId: req.body.baseRevisionId ?? null,
      createdByAgentId: actor.agentId ?? null,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      createdByRunId: actor.runId ?? null,
    });
    const doc = result.document;
    await issueReferencesSvc.syncDocument(doc.id);
    const referenceSummaryAfter = await issueReferencesSvc.listIssueReferenceSummary(issue.id);
    const referenceDiff = issueReferencesSvc.diffIssueReferenceSummary(referenceSummaryBefore, referenceSummaryAfter);

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: result.created ? "issue.document_created" : "issue.document_updated",
      entityType: "issue",
      entityId: issue.id,
      details: {
        key: doc.key,
        documentId: doc.id,
        title: doc.title,
        format: doc.format,
        revisionNumber: doc.latestRevisionNumber,
        ...summarizeIssueReferenceActivityDetails({
          addedReferencedIssues: referenceDiff.addedReferencedIssues.map(summarizeIssueRelationForActivity),
          removedReferencedIssues: referenceDiff.removedReferencedIssues.map(summarizeIssueRelationForActivity),
          currentReferencedIssues: referenceDiff.currentReferencedIssues.map(summarizeIssueRelationForActivity),
        }),
      },
    });

    await continuitySvc.recomputeIssueContinuityState(issue.id);

    res.status(result.created ? 201 : 200).json(doc);
  });

  router.get("/issues/:id/documents/:key/revisions", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
      return;
    }
    const revisions = await documentsSvc.listIssueDocumentRevisions(issue.id, keyParsed.data);
    res.json(revisions);
  });

  router.post(
    "/issues/:id/documents/:key/revisions/:revisionId/restore",
    validate(restoreIssueDocumentRevisionSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const revisionId = req.params.revisionId as string;
      const issue = await svc.getById(id);
      if (!issue) {
        res.status(404).json({ error: "Issue not found" });
        return;
      }
      assertCompanyAccess(req, issue.companyId);
      if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;
      const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
      if (!keyParsed.success) {
        res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
        return;
      }
      const documentKey = keyParsed.data;
      const revisions = await documentsSvc.listIssueDocumentRevisions(issue.id, documentKey);
      const revision = revisions.find((entry) => entry.id === revisionId);
      if (!revision) {
        res.status(404).json({ error: "Document revision not found" });
        return;
      }
      const continuityActive = isContinuityActive(issue);
      if (
        continuityActive &&
        CONTINUITY_CONTROLLED_DOCUMENT_KEYS.has(documentKey) &&
        !isContinuityOwnerActor(req, issue)
      ) {
        res.status(403).json({ error: "Only the continuity owner can restore this document while execution is active" });
        return;
      }
      if (!(await requireApprovedLinkedApprovalForActiveDocumentEdit(res, issue.id, documentKey, continuityActive, "Restoring"))) {
        return;
      }
      if (documentKey === "progress" && !parseIssueProgressMarkdown(revision.body)) {
        res.status(422).json({ error: "Progress documents require paperclip/issue-progress.v1 frontmatter" });
        return;
      }
      if (documentKey === "handoff" && !parseIssueHandoffMarkdown(revision.body)) {
        res.status(422).json({ error: "Handoff documents require paperclip/issue-handoff.v1 frontmatter" });
        return;
      }
      if (documentKey === ISSUE_BRANCH_CHARTER_DOCUMENT_KEY) {
        if (!issue.parentId) {
          res.status(422).json({ error: "Branch charter documents are only valid on child issues" });
          return;
        }
        if (!parseIssueBranchCharterMarkdown(revision.body)) {
          res.status(422).json({ error: "Branch charter documents require paperclip/issue-branch-charter.v1 frontmatter" });
          return;
        }
      }
      const actor = getActorInfo(req);
      const referenceSummaryBefore = await issueReferencesSvc.listIssueReferenceSummary(issue.id);
      const result = await documentsSvc.restoreIssueDocumentRevision({
        issueId: issue.id,
        key: documentKey,
        revisionId,
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      });
      await issueReferencesSvc.syncDocument(result.document.id);
      const referenceSummaryAfter = await issueReferencesSvc.listIssueReferenceSummary(issue.id);
      const referenceDiff = issueReferencesSvc.diffIssueReferenceSummary(referenceSummaryBefore, referenceSummaryAfter);

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.document_restored",
        entityType: "issue",
        entityId: issue.id,
        details: {
          key: result.document.key,
          documentId: result.document.id,
          title: result.document.title,
          format: result.document.format,
          revisionNumber: result.document.latestRevisionNumber,
          restoredFromRevisionId: result.restoredFromRevisionId,
          restoredFromRevisionNumber: result.restoredFromRevisionNumber,
          ...summarizeIssueReferenceActivityDetails({
            addedReferencedIssues: referenceDiff.addedReferencedIssues.map(summarizeIssueRelationForActivity),
            removedReferencedIssues: referenceDiff.removedReferencedIssues.map(summarizeIssueRelationForActivity),
            currentReferencedIssues: referenceDiff.currentReferencedIssues.map(summarizeIssueRelationForActivity),
          }),
        },
      });

      await continuitySvc.recomputeIssueContinuityState(issue.id);

      res.json(result.document);
    },
  );

  router.delete("/issues/:id/documents/:key", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
      return;
    }
    const continuityActive = isContinuityActive(issue);
    if (!(await requireApprovedLinkedApprovalForActiveDocumentEdit(res, issue.id, keyParsed.data, continuityActive, "Deleting"))) {
      return;
    }
    const referenceSummaryBefore = await issueReferencesSvc.listIssueReferenceSummary(issue.id);
    const removed = await documentsSvc.deleteIssueDocument(issue.id, keyParsed.data);
    if (!removed) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    await issueReferencesSvc.deleteDocumentSource(removed.id);
    const referenceSummaryAfter = await issueReferencesSvc.listIssueReferenceSummary(issue.id);
    const referenceDiff = issueReferencesSvc.diffIssueReferenceSummary(referenceSummaryBefore, referenceSummaryAfter);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.document_deleted",
      entityType: "issue",
      entityId: issue.id,
      details: {
        key: removed.key,
        documentId: removed.id,
        title: removed.title,
        ...summarizeIssueReferenceActivityDetails({
          addedReferencedIssues: referenceDiff.addedReferencedIssues.map(summarizeIssueRelationForActivity),
          removedReferencedIssues: referenceDiff.removedReferencedIssues.map(summarizeIssueRelationForActivity),
          currentReferencedIssues: referenceDiff.currentReferencedIssues.map(summarizeIssueRelationForActivity),
        }),
      },
    });
    await continuitySvc.recomputeIssueContinuityState(issue.id);
    res.json({ ok: true });
  });

  router.post("/issues/:id/work-products", validate(createIssueWorkProductSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;
    const product = await workProductsSvc.createForIssue(issue.id, issue.companyId, {
      ...req.body,
      projectId: req.body.projectId ?? issue.projectId ?? null,
    });
    if (!product) {
      res.status(422).json({ error: "Invalid work product payload" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.work_product_created",
      entityType: "issue",
      entityId: issue.id,
      details: { workProductId: product.id, type: product.type, provider: product.provider },
    });
    res.status(201).json(product);
  });

  router.patch("/work-products/:id", validate(updateIssueWorkProductSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await workProductsSvc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Work product not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const issue = await svc.getById(existing.issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;
    const product = await workProductsSvc.update(id, req.body);
    if (!product) {
      res.status(404).json({ error: "Work product not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.work_product_updated",
      entityType: "issue",
      entityId: existing.issueId,
      details: { workProductId: product.id, changedKeys: Object.keys(req.body).sort() },
    });
    res.json(product);
  });

  router.delete("/work-products/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await workProductsSvc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Work product not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const issue = await svc.getById(existing.issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;
    const removed = await workProductsSvc.remove(id);
    if (!removed) {
      res.status(404).json({ error: "Work product not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.work_product_deleted",
      entityType: "issue",
      entityId: existing.issueId,
      details: { workProductId: removed.id, type: removed.type },
    });
    res.json(removed);
  });

  router.post("/issues/:id/read", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    if (!req.actor.userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }
    const readState = await svc.markRead(issue.companyId, issue.id, req.actor.userId, new Date());
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.read_marked",
      entityType: "issue",
      entityId: issue.id,
      details: { userId: req.actor.userId, lastReadAt: readState.lastReadAt },
    });
    res.json(readState);
  });

  router.delete("/issues/:id/read", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    if (!req.actor.userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }
    const removed = await svc.markUnread(issue.companyId, issue.id, req.actor.userId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.read_unmarked",
      entityType: "issue",
      entityId: issue.id,
      details: { userId: req.actor.userId },
    });
    res.json({ id: issue.id, removed });
  });

  router.post("/issues/:id/inbox-archive", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    if (!req.actor.userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }
    const archiveState = await svc.archiveInbox(issue.companyId, issue.id, req.actor.userId, new Date());
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.inbox_archived",
      entityType: "issue",
      entityId: issue.id,
      details: { userId: req.actor.userId, archivedAt: archiveState.archivedAt },
    });
    res.json(archiveState);
  });

  router.delete("/issues/:id/inbox-archive", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    if (!req.actor.userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }
    const removed = await svc.unarchiveInbox(issue.companyId, issue.id, req.actor.userId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.inbox_unarchived",
      entityType: "issue",
      entityId: issue.id,
      details: { userId: req.actor.userId },
    });
    res.json(removed ?? { ok: true });
  });

  router.get("/issues/:id/approvals", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const approvals = await issueApprovalsSvc.listApprovalsForIssue(id);
    const actor = getConferenceActor(req);
    res.json(approvals.map((approval) => serializeApprovalForActor(approval, actor)));
  });

  router.get("/issues/:id/conference-context", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);

    const context = await conferenceContext.resolveForIssueRecord(issue);
    if (!context) {
      res.status(404).json({ error: "Conference context not found" });
      return;
    }

    res.json(sanitizeConferenceContextForActor(context, getConferenceActor(req)));
  });

  router.post("/issues/:id/approvals", validate(linkIssueApprovalSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;
    if (!(await assertCanManageIssueApprovalLinks(req, res, issue.companyId))) return;

    const actor = getActorInfo(req);
    await issueApprovalsSvc.link(id, req.body.approvalId, {
      agentId: actor.agentId,
      userId: actor.actorType === "user" ? actor.actorId : null,
    });

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.approval_linked",
      entityType: "issue",
      entityId: issue.id,
      details: { approvalId: req.body.approvalId },
    });

    await continuitySvc.recomputeIssueContinuityState(issue.id);

    const approvals = await issueApprovalsSvc.listApprovalsForIssue(id);
    const conferenceActor = getConferenceActor(req);
    res.status(201).json(approvals.map((approval) => serializeApprovalForActor(approval, conferenceActor)));
  });

  router.delete("/issues/:id/approvals/:approvalId", async (req, res) => {
    const id = req.params.id as string;
    const approvalId = req.params.approvalId as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;
    if (!(await assertCanManageIssueApprovalLinks(req, res, issue.companyId))) return;

    await issueApprovalsSvc.unlink(id, approvalId);

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.approval_unlinked",
      entityType: "issue",
      entityId: issue.id,
      details: { approvalId },
    });

    await continuitySvc.recomputeIssueContinuityState(issue.id);

    res.json({ ok: true });
  });

  router.post("/companies/:companyId/issues", validate(createIssueSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const hasExplicitAssignee = !!(req.body.assigneeAgentId || req.body.assigneeUserId);
    if (hasExplicitAssignee) {
      await assertCanAssignTasks(req, companyId);
    }

    const actor = getActorInfo(req);
    const executionPolicy = normalizeIssueExecutionPolicy(req.body.executionPolicy);
    const { continuityTier, prepareContinuity, docs, ...createInput } = req.body;
    if (docs) {
      const progressOverride = (docs as Record<string, { body: string } | undefined>).progress;
      if (progressOverride && !parseIssueProgressMarkdown(progressOverride.body)) {
        res.status(400).json({
          error: "docs.progress must include valid paperclip/issue-progress.v1 frontmatter",
          field: "docs.progress.body",
        });
        return;
      }
      const handoffOverride = (docs as Record<string, { body: string } | undefined>).handoff;
      if (handoffOverride && !parseIssueHandoffMarkdown(handoffOverride.body)) {
        res.status(400).json({
          error: "docs.handoff must include valid paperclip/issue-handoff.v1 frontmatter",
          field: "docs.handoff.body",
        });
        return;
      }
    }
    const shouldAutoPrepareContinuity =
      prepareContinuity === true ||
      (prepareContinuity === undefined && typeof req.body.parentId === "string");
    let defaultAssigneeAgentId = typeof req.body.assigneeAgentId === "string" ? req.body.assigneeAgentId : null;
    if (!defaultAssigneeAgentId && !req.body.assigneeUserId && req.body.projectId) {
      const officeOperator = await officeCoordinationSvc.findOfficeOperator(companyId);
      if (!officeOperator) {
        const resolvedProjectLead = await agentsSvc.resolvePrimaryProjectLeadForProject(companyId, req.body.projectId);
        defaultAssigneeAgentId = resolvedProjectLead.agent?.id ?? null;
      }
    }
    const issue = await svc.create(companyId, {
      ...createInput,
      assigneeAgentId: defaultAssigneeAgentId,
      executionPolicy,
      createdByAgentId: actor.agentId,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
    });
    let continuityState = await continuitySvc.recomputeIssueContinuityState(issue.id, {
      tier: continuityTier ?? "normal",
    });
    let scaffoldedKeys: string[] = [];
    let overriddenKeys: string[] = [];
    let planApprovalRequest: { approvalId: string | null; approvalStatus: string | null } | null = null;
    if (shouldAutoPrepareContinuity) {
      const prepared = await continuitySvc.prepare(
        issue.id,
        { tier: continuityTier ?? "normal", docs },
        {
          agentId: actor.agentId ?? null,
          userId: actor.actorType === "user" ? actor.actorId : null,
          runId: actor.runId ?? null,
        },
      );
      continuityState = prepared.continuityState;
      scaffoldedKeys = prepared.scaffoldedKeys ?? [];
      overriddenKeys = prepared.overriddenKeys ?? [];
      planApprovalRequest = prepared.planApprovalRequest ?? null;
    }
    await issueReferencesSvc.syncIssue(issue.id);
    const referenceSummary = await issueReferencesSvc.listIssueReferenceSummary(issue.id);
    const referenceDiff = issueReferencesSvc.diffIssueReferenceSummary(
      issueReferencesSvc.emptySummary(),
      referenceSummary,
    );

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.created",
      entityType: "issue",
      entityId: issue.id,
      details: {
        title: issue.title,
        identifier: issue.identifier,
        ...(Array.isArray(req.body.blockedByIssueIds) ? { blockedByIssueIds: req.body.blockedByIssueIds } : {}),
        ...(scaffoldedKeys.length > 0 || overriddenKeys.length > 0
          ? {
              continuityScaffold: {
                scaffoldedKeys,
                overriddenKeys,
                tier: continuityTier ?? "normal",
                planApprovalRequest,
              },
            }
          : {}),
        ...summarizeIssueReferenceActivityDetails({
          addedReferencedIssues: referenceDiff.addedReferencedIssues.map(summarizeIssueRelationForActivity),
          removedReferencedIssues: referenceDiff.removedReferencedIssues.map(summarizeIssueRelationForActivity),
          currentReferencedIssues: referenceDiff.currentReferencedIssues.map(summarizeIssueRelationForActivity),
        }),
      },
    });

    if (planApprovalRequest?.approvalId) {
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.plan_approval_requested",
        entityType: "issue",
        entityId: issue.id,
        details: {
          approvalId: planApprovalRequest.approvalId,
          approvalStatus: planApprovalRequest.approvalStatus,
          planRevisionId: continuityState?.planApproval.currentPlanRevisionId ?? null,
          source: "issue_create_prepare",
        },
      });
    }

    void queueIssueAssignmentWakeup({
      heartbeat,
      issue,
      continuityState,
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "issue.create",
      requestedByActorType: actor.actorType,
      requestedByActorId: actor.actorId,
    });

    if (!issue.assigneeAgentId && !issue.assigneeUserId) {
      void wakeCompanyOfficeOperatorSafely({
        officeCoordination: officeCoordinationSvc,
        heartbeat,
        companyId,
        reason: "issue_intake_created",
        entityType: "issue",
        entityId: issue.id,
        summary: issue.identifier ?? issue.title,
        requestedByActorType: actor.actorType,
        requestedByActorId: actor.actorId,
        skipIfActorAgentId: actor.agentId ?? null,
        logContext: { issueId: issue.id },
      });
    }

    res.status(201).json(withIssueContinuitySummary({
      ...issue,
      continuityState,
      relatedWork: referenceSummary,
      referencedIssueIdentifiers: referenceSummary.outbound.map((item) => item.issue.identifier ?? item.issue.id),
    }));
  });

  router.patch("/issues/:id", validate(updateIssueRouteSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    if (!(await assertAgentIssueMutationAllowed(req, res, existing))) return;

    const reviewGateError = assertInReviewEntryGate(existing, req.body);
    if (reviewGateError) {
      res.status(422).json(reviewGateError);
      return;
    }

    const actor = getActorInfo(req);
    const isClosed = isClosedIssueStatus(existing.status);
    const titleOrDescriptionChanged = req.body.title !== undefined || req.body.description !== undefined;
    const existingRelations =
      Array.isArray(req.body.blockedByIssueIds)
        ? await svc.getRelationSummaries(existing.id)
        : null;
    const {
      comment: commentBody,
      reopen: reopenRequested,
      interrupt: interruptRequested,
      hiddenAt: hiddenAtRaw,
      pullRequestUrl: incomingPullRequestUrl,
      selfAttest: _selfAttest,
      autoRouteReviewer: _autoRouteReviewer,
      ...updateFields
    } = req.body;
    // AIW-148 (AIW-29 follow-up): persist pullRequestUrl when the in_review
    // gate accepts a URL. Gate shape is frozen; selfAttest-only entries
    // intentionally do not write a URL. We also accept updates on subsequent
    // in_review->in_review PATCHes so reviewers can correct the link without
    // a status bounce.
    if (
      typeof incomingPullRequestUrl === "string" &&
      incomingPullRequestUrl.length > 0 &&
      req.body.status === "in_review"
    ) {
      updateFields.pullRequestUrl = incomingPullRequestUrl;
    }
    const effectiveReopenRequested =
      reopenRequested ||
      (!!commentBody &&
        shouldImplicitlyReopenCommentForAgent({
          issueStatus: existing.status,
          assigneeAgentId:
            req.body.assigneeAgentId === undefined ? existing.assigneeAgentId : (req.body.assigneeAgentId as string | null),
          actorType: actor.actorType,
          actorId: actor.actorId,
        }));
    const updateReferenceSummaryBefore = titleOrDescriptionChanged
      ? await issueReferencesSvc.listIssueReferenceSummary(existing.id)
      : null;
    const requestedUpdateKeys = Object.keys(updateFields).filter(
      (key) => updateFields[key as keyof typeof updateFields] !== undefined,
    );
    let interruptedRunId: string | null = null;
    const closedExecutionWorkspace = await getClosedIssueExecutionWorkspace(existing);
    const isAgentWorkUpdate = req.actor.type === "agent" && Object.keys(updateFields).length > 0;

    if (closedExecutionWorkspace && (commentBody || isAgentWorkUpdate)) {
      respondClosedIssueExecutionWorkspace(res, closedExecutionWorkspace);
      return;
    }

    if (interruptRequested) {
      if (!commentBody) {
        res.status(400).json({ error: "Interrupt is only supported when posting a comment" });
        return;
      }
      if (req.actor.type !== "board") {
        res.status(403).json({ error: "Only board users can interrupt active runs from issue comments" });
        return;
      }

      const runToInterrupt = await resolveActiveIssueRun(existing);
      if (runToInterrupt) {
        const cancelled = await heartbeat.cancelRun(runToInterrupt.id);
        if (cancelled) {
          interruptedRunId = cancelled.id;
          await logActivity(db, {
            companyId: cancelled.companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "heartbeat.cancelled",
            entityType: "heartbeat_run",
            entityId: cancelled.id,
            details: { agentId: cancelled.agentId, source: "issue_comment_interrupt", issueId: existing.id },
          });
        }
      }
    }

    if (hiddenAtRaw !== undefined) {
      updateFields.hiddenAt = hiddenAtRaw ? new Date(hiddenAtRaw) : null;
    }
    if (commentBody && effectiveReopenRequested && isClosed && updateFields.status === undefined) {
      updateFields.status = "todo";
    }
    if (req.body.executionPolicy !== undefined) {
      updateFields.executionPolicy = normalizeIssueExecutionPolicy(req.body.executionPolicy);
    }
    const previousExecutionPolicy = normalizeIssueExecutionPolicy(existing.executionPolicy ?? null);
    const nextExecutionPolicy =
      updateFields.executionPolicy !== undefined
        ? (updateFields.executionPolicy as NormalizedExecutionPolicy | null)
        : previousExecutionPolicy;

    const transition = applyIssueExecutionPolicyTransition({
      issue: existing,
      policy: nextExecutionPolicy,
      requestedStatus: typeof updateFields.status === "string" ? updateFields.status : undefined,
      requestedAssigneePatch: {
        assigneeAgentId:
          req.body.assigneeAgentId === undefined ? undefined : (req.body.assigneeAgentId as string | null),
        assigneeUserId:
          req.body.assigneeUserId === undefined ? undefined : (req.body.assigneeUserId as string | null),
      },
      actor: {
        agentId: actor.agentId ?? null,
        userId: actor.actorType === "user" ? actor.actorId : null,
      },
      commentBody,
    });
    const decisionId = transition.decision ? randomUUID() : null;
    if (decisionId) {
      const nextExecutionState = transition.patch.executionState;
      if (!nextExecutionState || typeof nextExecutionState !== "object") {
        throw new Error("Execution policy decision patch is missing executionState");
      }
      transition.patch.executionState = {
        ...nextExecutionState,
        lastDecisionId: decisionId,
      };
    }
    Object.assign(updateFields, transition.patch);

    const nextRequestedStatus =
      typeof updateFields.status === "string"
        ? updateFields.status
        : existing.status;
    if (nextRequestedStatus === "in_progress" && existing.status !== "in_progress") {
      const continuityState = await continuitySvc.recomputeIssueContinuityState(existing.id);
      const executionBlock = describeExecutionReadinessBlock(continuityState);
      if (executionBlock) {
        res.status(409).json({ error: executionBlock });
        return;
      }
    }

    // AIW-137: auto-route a QA reviewer (or honor an explicit reviewer in the
    // body) when a plain `status: "in_review"` transition has no execution
    // policy review stage driving it. The policy-driven path sets
    // `updateFields.executionState.status = "pending"`; when that did not
    // happen we fall into this gate so the issue does not stall on the
    // executor with no reviewer picked.
    const advancedByExecutionPolicy =
      updateFields.executionState !== undefined &&
      updateFields.executionState !== null &&
      typeof updateFields.executionState === "object" &&
      !Array.isArray(updateFields.executionState) &&
      (updateFields.executionState as Record<string, unknown>).status === "pending";
    const inReviewRoutingApplies =
      req.body.status === "in_review" &&
      existing.status !== "in_review" &&
      !advancedByExecutionPolicy;
    let autoRouteOutcome: {
      reviewer: { id: string; name: string };
      executor: { id: string; name: string } | null;
      routedBy: "auto" | "explicit";
      openIssueCount: number | null;
      candidateCount: number | null;
    } | null = null;
    if (inReviewRoutingApplies) {
      const explicitReviewerAgentId =
        typeof req.body.assigneeAgentId === "string" ? req.body.assigneeAgentId : null;
      const explicitAssigneeUserId =
        typeof req.body.assigneeUserId === "string" ? req.body.assigneeUserId : null;
      const bodyProvidedAssignee =
        req.body.assigneeAgentId !== undefined || req.body.assigneeUserId !== undefined;
      const autoRouteFlag =
        typeof (req.body as { autoRouteReviewer?: unknown }).autoRouteReviewer === "boolean"
          ? ((req.body as { autoRouteReviewer: boolean }).autoRouteReviewer)
          : undefined;
      const executor = existing.assigneeAgentId
        ? await agentsSvc.getById(existing.assigneeAgentId)
        : null;

      if (explicitReviewerAgentId) {
        const reviewer = await agentsSvc.getById(explicitReviewerAgentId);
        if (!reviewer || reviewer.companyId !== existing.companyId) {
          res.status(422).json(inReviewRoutingMissingReviewerError());
          return;
        }
        autoRouteOutcome = {
          reviewer: { id: reviewer.id, name: reviewer.name },
          executor: executor ? { id: executor.id, name: executor.name } : null,
          routedBy: "explicit",
          openIssueCount: null,
          candidateCount: null,
        };
      } else if (bodyProvidedAssignee && explicitAssigneeUserId) {
        // User-assignee path: caller chose a human reviewer. Skip auto-route
        // (no QA balancer for user assignees) but honor the transition.
      } else if (autoRouteFlag === false) {
        res.status(422).json(inReviewRoutingMissingReviewerError());
        return;
      } else {
        const selection = await selectLeastLoadedQaReviewer(db, {
          companyId: existing.companyId,
          excludeAgentId: existing.assigneeAgentId ?? null,
        });
        if (!selection.reviewer) {
          res.status(422).json(inReviewRoutingMissingReviewerError());
          return;
        }
        updateFields.assigneeAgentId = selection.reviewer.id;
        updateFields.assigneeUserId = null;
        autoRouteOutcome = {
          reviewer: { id: selection.reviewer.id, name: selection.reviewer.name },
          executor: executor ? { id: executor.id, name: executor.name } : null,
          routedBy: "auto",
          openIssueCount: selection.reviewer.openIssueCount,
          candidateCount: selection.candidateCount,
        };
      }
    }

    const nextAssigneeAgentId =
      updateFields.assigneeAgentId === undefined ? existing.assigneeAgentId : (updateFields.assigneeAgentId as string | null);
    const nextAssigneeUserId =
      updateFields.assigneeUserId === undefined ? existing.assigneeUserId : (updateFields.assigneeUserId as string | null);
    const assigneeWillChange =
      nextAssigneeAgentId !== existing.assigneeAgentId || nextAssigneeUserId !== existing.assigneeUserId;
    const continuityActive = isContinuityActive(existing);
    const activeExecutionParticipantActor = isActiveExecutionParticipantActor(req, existing);
    const isAgentReturningIssueToCreator =
      req.actor.type === "agent" &&
      !!req.actor.agentId &&
      existing.assigneeAgentId === req.actor.agentId &&
      nextAssigneeAgentId === null &&
      typeof nextAssigneeUserId === "string" &&
      !!existing.createdByUserId &&
      nextAssigneeUserId === existing.createdByUserId;

    if (req.actor.type === "agent" && existing.assigneeAgentId !== req.actor.agentId) {
      const stageDecisionOnly =
        activeExecutionParticipantActor &&
        requestedUpdateKeys.every((key) => key === "status") &&
        !!commentBody;
      const activeCheckoutOverride =
        existing.status === "in_progress" &&
        !!existing.assigneeAgentId &&
        !!req.actor.agentId &&
        existing.assigneeAgentId !== req.actor.agentId &&
        (await hasActiveCheckoutManagementOverride(req.actor.agentId, existing.companyId, existing.assigneeAgentId));
      // Staff reassignment bypass: when the mutation is strictly an assignee change,
      // let managers-of-record through the continuity gate. assertCanAssignTasks below
      // enforces the actual permission (tasks:assign or capability-profile grant).
      const isAssignmentOnlyMutation =
        assigneeWillChange &&
        requestedUpdateKeys.length > 0 &&
        requestedUpdateKeys.every(
          (key) => key === "assigneeAgentId" || key === "assigneeUserId",
        );
      const staffReassignmentOverride =
        isAssignmentOnlyMutation &&
        !!req.actor.agentId &&
        (existing.assigneeAgentId === null
          ? true
          : await hasActiveCheckoutManagementOverride(
              req.actor.agentId,
              existing.companyId,
              existing.assigneeAgentId,
            ));
      if (!stageDecisionOnly && !activeCheckoutOverride && !staffReassignmentOverride) {
        res.status(403).json({ error: "Only the continuity owner can mutate this issue directly" });
        return;
      }
    }

    if (assigneeWillChange && !transition.workflowControlledAssignment && !autoRouteOutcome) {
      if (continuityActive) {
        const handoffDocument = await documentsSvc.getIssueDocumentByKey(existing.id, "handoff");
        const parsedHandoff = handoffDocument ? parseIssueHandoffMarkdown(handoffDocument.body ?? "") : null;
        const transferTarget = requestedAssigneeTarget({
          assigneeAgentId: nextAssigneeAgentId,
          assigneeUserId: nextAssigneeUserId,
        });
        if (!transferTarget || !parsedHandoff || parsedHandoff.document.transferTarget !== transferTarget) {
          res.status(409).json({
            error: "Active execution ownership transfer requires a typed handoff document for the new owner",
          });
          return;
        }
      }
      if (!isAgentReturningIssueToCreator) {
        await assertCanAssignTasks(req, existing.companyId);
      }
    }

    let issue;
    try {
      if (transition.decision && decisionId) {
        const decision = transition.decision;
        issue = await db.transaction(async (tx) => {
          const updated = await svc.update(
            id,
            {
              ...updateFields,
              actorAgentId: actor.agentId ?? null,
              actorUserId: actor.actorType === "user" ? actor.actorId : null,
            },
            tx,
          );
          if (!updated) return null;

          await tx.insert(issueExecutionDecisions).values({
            id: decisionId,
            companyId: updated.companyId,
            issueId: updated.id,
            stageId: decision.stageId,
            stageType: decision.stageType,
            actorAgentId: actor.agentId ?? null,
            actorUserId: actor.actorType === "user" ? actor.actorId : null,
            outcome: decision.outcome,
            body: decision.body,
            createdByRunId: actor.runId ?? null,
          });

          return updated;
        });
      } else {
        issue = await svc.update(id, {
          ...updateFields,
          actorAgentId: actor.agentId ?? null,
          actorUserId: actor.actorType === "user" ? actor.actorId : null,
        });
      }
    } catch (err) {
      if (err instanceof HttpError && err.status === 422) {
        logger.warn(
          {
            issueId: id,
            companyId: existing.companyId,
            assigneePatch: {
              assigneeAgentId:
                req.body.assigneeAgentId === undefined ? "__omitted__" : req.body.assigneeAgentId,
              assigneeUserId:
                req.body.assigneeUserId === undefined ? "__omitted__" : req.body.assigneeUserId,
            },
            currentAssignee: {
              assigneeAgentId: existing.assigneeAgentId,
              assigneeUserId: existing.assigneeUserId,
            },
            error: err.message,
            details: err.details,
          },
          "issue update rejected with 422",
        );
      }
      throw err;
    }
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (titleOrDescriptionChanged) {
      await issueReferencesSvc.syncIssue(issue.id);
    }
    const updateReferenceSummaryAfter = titleOrDescriptionChanged
      ? await issueReferencesSvc.listIssueReferenceSummary(issue.id)
      : null;
    const updateReferenceDiff = updateReferenceSummaryBefore && updateReferenceSummaryAfter
      ? issueReferencesSvc.diffIssueReferenceSummary(updateReferenceSummaryBefore, updateReferenceSummaryAfter)
      : null;
    let issueResponse: typeof issue & {
      blockedBy?: unknown;
      blocks?: unknown;
      continuityState?: unknown;
      relatedWork?: Awaited<ReturnType<typeof issueReferencesSvc.listIssueReferenceSummary>>;
      referencedIssueIdentifiers?: string[];
    } = issue;
    let updatedRelations: Awaited<ReturnType<typeof svc.getRelationSummaries>> | null = null;
    if (issue && Array.isArray(req.body.blockedByIssueIds)) {
      updatedRelations = await svc.getRelationSummaries(issue.id);
      issueResponse = {
        ...issue,
        blockedBy: updatedRelations.blockedBy,
        blocks: updatedRelations.blocks,
      };
    }
    const continuityState = await continuitySvc.recomputeIssueContinuityState(issue.id);
    if (issue.parentId) {
      await continuitySvc.recomputeIssueContinuityState(issue.parentId);
    }
    issueResponse = {
      ...issueResponse,
      continuityState: continuityState as unknown as Record<string, unknown>,
    };
    await routinesSvc.syncRunStatusForIssue(issue.id);

    if (actor.runId) {
      await heartbeat.reportRunActivity(actor.runId).catch((err) =>
        logger.warn({ err, runId: actor.runId }, "failed to clear detached run warning after issue activity"));
    }

    // Build activity details with previous values for changed fields
    const previous: Record<string, unknown> = {};
    for (const key of Object.keys(updateFields)) {
      if (key in existing && (existing as Record<string, unknown>)[key] !== (updateFields as Record<string, unknown>)[key]) {
        previous[key] = (existing as Record<string, unknown>)[key];
      }
    }
    if (Array.isArray(req.body.blockedByIssueIds)) {
      previous.blockedByIssueIds = existingRelations?.blockedBy.map((relation) => relation.id) ?? [];
    }

    const hasFieldChanges = Object.keys(previous).length > 0;
    const reopened =
      commentBody &&
      effectiveReopenRequested &&
      isClosed &&
      previous.status !== undefined &&
      issue.status === "todo";
    const reopenFromStatus = reopened ? existing.status : null;
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.updated",
      entityType: "issue",
      entityId: issue.id,
      details: {
        ...updateFields,
        identifier: issue.identifier,
        ...(commentBody ? { source: "comment" } : {}),
        ...(reopened ? { reopened: true, reopenedFrom: reopenFromStatus } : {}),
        ...(interruptedRunId ? { interruptedRunId } : {}),
        _previous: hasFieldChanges ? previous : undefined,
        ...summarizeIssueReferenceActivityDetails(
          updateReferenceDiff
            ? {
                addedReferencedIssues: updateReferenceDiff.addedReferencedIssues.map(summarizeIssueRelationForActivity),
                removedReferencedIssues: updateReferenceDiff.removedReferencedIssues.map(summarizeIssueRelationForActivity),
                currentReferencedIssues: updateReferenceDiff.currentReferencedIssues.map(summarizeIssueRelationForActivity),
              }
            : null,
        ),
      },
    });

    if (Array.isArray(req.body.blockedByIssueIds)) {
      const previousBlockedByIds = new Set((existingRelations?.blockedBy ?? []).map((relation) => relation.id));
      const nextBlockedByIds = new Set(req.body.blockedByIssueIds as string[]);
      const addedBlockedByIssueIds = [...nextBlockedByIds].filter((candidate) => !previousBlockedByIds.has(candidate));
      const removedBlockedByIssueIds = [...previousBlockedByIds].filter((candidate) => !nextBlockedByIds.has(candidate));
      const nextBlockedByRelations = updatedRelations?.blockedBy ?? [];
      const previousBlockedByRelations = existingRelations?.blockedBy ?? [];
      if (addedBlockedByIssueIds.length > 0 || removedBlockedByIssueIds.length > 0) {
        await logActivity(db, {
          companyId: issue.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "issue.blockers_updated",
          entityType: "issue",
          entityId: issue.id,
          details: {
            identifier: issue.identifier,
            blockedByIssueIds: req.body.blockedByIssueIds,
            addedBlockedByIssueIds,
            removedBlockedByIssueIds,
            blockedByIssues: nextBlockedByRelations.map(summarizeIssueRelationForActivity),
            addedBlockedByIssues: nextBlockedByRelations
              .filter((relation) => addedBlockedByIssueIds.includes(relation.id))
              .map(summarizeIssueRelationForActivity),
            removedBlockedByIssues: previousBlockedByRelations
              .filter((relation) => removedBlockedByIssueIds.includes(relation.id))
              .map(summarizeIssueRelationForActivity),
          },
        });
      }
    }

    const reviewerChanges = diffExecutionParticipants(previousExecutionPolicy, nextExecutionPolicy, "review");
    if (reviewerChanges.addedParticipants.length > 0 || reviewerChanges.removedParticipants.length > 0) {
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.reviewers_updated",
        entityType: "issue",
        entityId: issue.id,
        details: {
          identifier: issue.identifier,
          participants: reviewerChanges.participants,
          addedParticipants: reviewerChanges.addedParticipants,
          removedParticipants: reviewerChanges.removedParticipants,
        },
      });
    }

    const approverChanges = diffExecutionParticipants(previousExecutionPolicy, nextExecutionPolicy, "approval");
    if (approverChanges.addedParticipants.length > 0 || approverChanges.removedParticipants.length > 0) {
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.approvers_updated",
        entityType: "issue",
        entityId: issue.id,
        details: {
          identifier: issue.identifier,
          participants: approverChanges.participants,
          addedParticipants: approverChanges.addedParticipants,
          removedParticipants: approverChanges.removedParticipants,
        },
      });
    }

    if (issue.status === "done" && existing.status !== "done") {
      const tc = getTelemetryClientFn();
      if (tc && actor.agentId) {
        const actorAgent = await agentsSvc.getById(actor.agentId);
        if (actorAgent) {
          trackAgentTaskCompletedFn(tc, { agentRole: actorAgent.role });
        }
      }
    }

    let comment = null;
    if (commentBody) {
      const commentReferenceSummaryBefore = updateReferenceSummaryAfter
        ?? await issueReferencesSvc.listIssueReferenceSummary(issue.id);
      comment = await svc.addComment(id, commentBody, {
        agentId: actor.agentId ?? undefined,
        userId: actor.actorType === "user" ? actor.actorId : undefined,
        runId: actor.runId,
      });
      await issueReferencesSvc.syncComment(comment.id);
      const commentReferenceSummaryAfter = await issueReferencesSvc.listIssueReferenceSummary(issue.id);
      const commentReferenceDiff = issueReferencesSvc.diffIssueReferenceSummary(
        commentReferenceSummaryBefore,
        commentReferenceSummaryAfter,
      );
      issueResponse = {
        ...issueResponse,
        relatedWork: commentReferenceSummaryAfter,
        referencedIssueIdentifiers: commentReferenceSummaryAfter.outbound.map(
          (item) => item.issue.identifier ?? item.issue.id,
        ),
      };

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.comment_added",
        entityType: "issue",
        entityId: issue.id,
        details: {
          commentId: comment.id,
          bodySnippet: comment.body.slice(0, 120),
          identifier: issue.identifier,
          issueTitle: issue.title,
          ...(reopened ? { reopened: true, reopenedFrom: reopenFromStatus, source: "comment" } : {}),
          ...(interruptedRunId ? { interruptedRunId } : {}),
          ...(hasFieldChanges ? { updated: true } : {}),
          ...summarizeIssueReferenceActivityDetails({
            addedReferencedIssues: commentReferenceDiff.addedReferencedIssues.map(summarizeIssueRelationForActivity),
            removedReferencedIssues: commentReferenceDiff.removedReferencedIssues.map(summarizeIssueRelationForActivity),
            currentReferencedIssues: commentReferenceDiff.currentReferencedIssues.map(summarizeIssueRelationForActivity),
          }),
        },
      });

    } else if (updateReferenceSummaryAfter) {
      issueResponse = {
        ...issueResponse,
        relatedWork: updateReferenceSummaryAfter,
        referencedIssueIdentifiers: updateReferenceSummaryAfter.outbound.map(
          (item) => item.issue.identifier ?? item.issue.id,
        ),
      };
    }

    // AIW-137: post the system-authored auto-route comment + activity log once
    // the issue update (and any caller comment) has landed. The comment is
    // intentionally authored with no agent/user so the activity attributes to
    // `system` rather than the executor who requested the transition.
    if (autoRouteOutcome) {
      const autoRouteBody = buildAutoRouteComment({
        executor: autoRouteOutcome.executor,
        reviewer: autoRouteOutcome.reviewer,
        routedBy: autoRouteOutcome.routedBy,
      });
      const autoRouteComment = await svc.addComment(id, autoRouteBody, {
        runId: actor.runId,
      });
      await issueReferencesSvc.syncComment(autoRouteComment.id).catch((err) =>
        logger.warn({ err, issueId: id }, "failed to sync auto-route comment references"),
      );
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.in_review_auto_routed",
        entityType: "issue",
        entityId: issue.id,
        details: {
          identifier: issue.identifier,
          routedBy: autoRouteOutcome.routedBy,
          reviewerAgentId: autoRouteOutcome.reviewer.id,
          executorAgentId: autoRouteOutcome.executor?.id ?? null,
          openIssueCount: autoRouteOutcome.openIssueCount,
          candidateCount: autoRouteOutcome.candidateCount,
          commentId: autoRouteComment.id,
        },
      });
    }

    const assigneeChanged =
      issue.assigneeAgentId !== existing.assigneeAgentId || issue.assigneeUserId !== existing.assigneeUserId;
    const currentContinuityStateRecord =
      typeof continuityState === "object" && continuityState !== null && !Array.isArray(continuityState)
        ? (continuityState as unknown as Record<string, unknown>)
        : null;
    const continuityHealth =
      currentContinuityStateRecord && typeof currentContinuityStateRecord.health === "string"
        ? currentContinuityStateRecord.health
        : null;
    const previousContinuityState =
      typeof existing.continuityState === "object" &&
      existing.continuityState !== null &&
      !Array.isArray(existing.continuityState)
        ? (existing.continuityState as unknown as Record<string, unknown>)
        : null;
    const previousContinuityHealth =
      previousContinuityState && typeof previousContinuityState.health === "string"
        ? previousContinuityState.health
        : null;
    const blockCurrentIssueWakeups = isIssueWakeBlockedByContinuity(continuityState);
    const statusChangedFromBacklog =
      existing.status === "backlog" &&
      issue.status !== "backlog" &&
      req.body.status !== undefined;
    const previousExecutionState = parseIssueExecutionState(existing.executionState);
    const nextExecutionState = parseIssueExecutionState(issue.executionState);
    const executionStageWakeup = buildExecutionStageWakeup({
      issueId: issue.id,
      previousState: previousExecutionState,
      nextState: nextExecutionState,
      interruptedRunId,
      requestedByActorType: actor.actorType,
      requestedByActorId: actor.actorId,
    });

    // Merge all wakeups from this update into one enqueue per agent to avoid duplicate runs.
    void (async () => {
      type WakeupRequest = NonNullable<Parameters<typeof heartbeat.wakeup>[1]>;
      const wakeups = new Map<string, { agentId: string; wakeup: WakeupRequest }>();
      const wakeupPriority = (wakeup: WakeupRequest) => {
        switch (wakeup.reason) {
          case "execution_changes_requested":
          case "execution_review_requested":
          case "execution_approval_requested":
            return 3;
          case "issue_assigned":
          case "issue_reopened_via_comment":
          case "issue_status_changed":
            return 2;
          case "issue_comment_mentioned":
            return 1;
          case "issue_commented":
          default:
            return 0;
        }
      };
      const addWakeup = (agentId: string, wakeup: WakeupRequest) => {
        const wakeIssueId =
          wakeup.payload && typeof wakeup.payload === "object" && typeof wakeup.payload.issueId === "string"
            ? wakeup.payload.issueId
            : issue.id;
        const key = `${agentId}:${wakeIssueId}`;
        const existingWakeup = wakeups.get(key);
        if (existingWakeup && wakeupPriority(existingWakeup.wakeup) > wakeupPriority(wakeup)) {
          return;
        }
        wakeups.set(key, { agentId, wakeup });
      };

      if (executionStageWakeup) {
        addWakeup(executionStageWakeup.agentId, executionStageWakeup.wakeup);
      }

      if (autoRouteOutcome && issue.assigneeAgentId) {
        // AIW-137: treat the auto-route (and explicit) in_review transition
        // as an `execution_review_requested` wake so the reviewer heartbeat
        // picks it up on the same priority tier as the policy-driven path.
        const executionStage = {
          wakeRole: "reviewer" as const,
          stageId: null,
          stageType: null,
          currentParticipant: null,
          returnAssignee: null,
          lastDecisionOutcome: null,
          allowedActions: ["approve", "request_changes"],
          routedBy: autoRouteOutcome.routedBy,
          executorAgentId: autoRouteOutcome.executor?.id ?? null,
        };
        addWakeup(autoRouteOutcome.reviewer.id, {
          source: "assignment",
          triggerDetail: "system",
          reason: "execution_review_requested",
          payload: {
            issueId: issue.id,
            mutation: "update",
            executionStage,
            ...(interruptedRunId ? { interruptedRunId } : {}),
          },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: {
            issueId: issue.id,
            taskId: issue.id,
            wakeReason: "execution_review_requested",
            source: "issue.auto_route",
            executionStage,
            ...(interruptedRunId ? { interruptedRunId } : {}),
          },
        });
      } else if (
        !executionStageWakeup &&
        assigneeChanged &&
        issue.assigneeAgentId &&
        shouldWakeAssignedAgentForIssue({ issue, continuityState })
      ) {
        addWakeup(issue.assigneeAgentId, {
          source: "assignment",
          triggerDetail: "system",
          reason: "issue_assigned",
          payload: {
            issueId: issue.id,
            ...(comment ? { commentId: comment.id } : {}),
            mutation: "update",
            ...(interruptedRunId ? { interruptedRunId } : {}),
          },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: {
            issueId: issue.id,
            ...(comment
              ? {
                  taskId: issue.id,
                  commentId: comment.id,
                  wakeCommentId: comment.id,
                }
              : {}),
            source: "issue.update",
            ...(interruptedRunId ? { interruptedRunId } : {}),
          },
        });
      }

      if (!assigneeChanged && statusChangedFromBacklog && issue.assigneeAgentId && !blockCurrentIssueWakeups) {
        addWakeup(issue.assigneeAgentId, {
          source: "automation",
          triggerDetail: "system",
          reason: "issue_status_changed",
          payload: {
            issueId: issue.id,
            mutation: "update",
            ...(interruptedRunId ? { interruptedRunId } : {}),
          },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: {
            issueId: issue.id,
            source: "issue.status_change",
            ...(interruptedRunId ? { interruptedRunId } : {}),
          },
        });
      }

      if (commentBody && comment) {
        const assigneeId = issue.assigneeAgentId;
        const actorIsAgent = actor.actorType === "agent";
        const selfComment = actorIsAgent && actor.actorId === assigneeId;
        const skipAssigneeCommentWake = selfComment || isClosed;

        if (assigneeId && !assigneeChanged && !skipAssigneeCommentWake && !blockCurrentIssueWakeups) {
          addWakeup(assigneeId, {
            source: "automation",
            triggerDetail: "system",
            reason: reopened ? "issue_reopened_via_comment" : "issue_commented",
            payload: {
              issueId: id,
              commentId: comment.id,
              mutation: "comment",
              ...(reopened ? { reopenedFrom: reopenFromStatus } : {}),
              ...(interruptedRunId ? { interruptedRunId } : {}),
            },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              issueId: id,
              taskId: id,
              commentId: comment.id,
              wakeCommentId: comment.id,
              source: reopened ? "issue.comment.reopen" : "issue.comment",
              wakeReason: reopened ? "issue_reopened_via_comment" : "issue_commented",
              ...(reopened ? { reopenedFrom: reopenFromStatus } : {}),
              ...(interruptedRunId ? { interruptedRunId } : {}),
            },
          });
        }

        let mentionedIds: string[] = [];
        try {
          mentionedIds = (await svc.resolveMentionedAgents(issue.companyId, commentBody)).agentIds;
        } catch (err) {
          logger.warn({ err, issueId: id }, "failed to resolve @-mentions");
        }

        for (const mentionedId of mentionedIds) {
          if (blockCurrentIssueWakeups) continue;
          if (actor.actorType === "agent" && actor.actorId === mentionedId) continue;
          addWakeup(mentionedId, {
            source: "automation",
            triggerDetail: "system",
            reason: "issue_comment_mentioned",
            payload: { issueId: id, commentId: comment.id },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              issueId: id,
              taskId: id,
              commentId: comment.id,
              wakeCommentId: comment.id,
              wakeReason: "issue_comment_mentioned",
              source: "comment.mention",
            },
          });
        }
      }

      const becameDone = existing.status !== "done" && issue.status === "done";
      if (becameDone) {
        const dependents = await svc.listWakeableBlockedDependents(issue.id);
        for (const dependent of dependents) {
          addWakeup(dependent.assigneeAgentId, {
            source: "automation",
            triggerDetail: "system",
            reason: "issue_blockers_resolved",
            payload: {
              issueId: dependent.id,
              resolvedBlockerIssueId: issue.id,
              blockerIssueIds: dependent.blockerIssueIds,
            },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              issueId: dependent.id,
              taskId: dependent.id,
              wakeReason: "issue_blockers_resolved",
              source: "issue.blockers_resolved",
              resolvedBlockerIssueId: issue.id,
              blockerIssueIds: dependent.blockerIssueIds,
            },
          });
        }
      }

      const becameTerminal =
        !["done", "cancelled"].includes(existing.status) && ["done", "cancelled"].includes(issue.status);
      if (becameTerminal && issue.parentId) {
        const parent = await svc.getWakeableParentAfterChildCompletion(issue.parentId);
        if (parent) {
          addWakeup(parent.assigneeAgentId, {
            source: "automation",
            triggerDetail: "system",
            reason: "issue_children_completed",
            payload: {
              issueId: parent.id,
              completedChildIssueId: issue.id,
              childIssueIds: parent.childIssueIds,
            },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              issueId: parent.id,
              taskId: parent.id,
              wakeReason: "issue_children_completed",
              source: "issue.children_completed",
              completedChildIssueId: issue.id,
              childIssueIds: parent.childIssueIds,
            },
          });
        }
      }

      for (const { agentId, wakeup } of wakeups.values()) {
        heartbeat
          .wakeup(agentId, wakeup)
          .catch((err) => logger.warn({ err, issueId: issue.id, agentId }, "failed to wake agent on issue update"));
      }

      const becameUnassigned =
        !issue.assigneeAgentId &&
        !issue.assigneeUserId &&
        (!!existing.assigneeAgentId || !!existing.assigneeUserId);
      const becameBlocked = existing.status !== "blocked" && issue.status === "blocked";
      const becameStale = previousContinuityHealth !== "stale_progress" && continuityHealth === "stale_progress";
      if (becameUnassigned || becameBlocked || becameStale) {
        const reason = becameUnassigned
          ? "issue_needs_routing"
          : becameBlocked
            ? "blocked_issue_detected"
            : "stale_issue_detected";
        void wakeCompanyOfficeOperatorSafely({
          officeCoordination: officeCoordinationSvc,
          heartbeat,
          companyId: issue.companyId,
          reason,
          entityType: "issue",
          entityId: issue.id,
          summary: issue.identifier ?? issue.title,
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          skipIfActorAgentId: actor.agentId ?? null,
          logContext: { issueId: issue.id, officeReason: reason },
        });
      }
    })();

    res.json(withIssueContinuitySummary({ ...issueResponse, comment }));
  });

  router.delete("/issues/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    if (!(await assertAgentIssueMutationAllowed(req, res, existing))) return;
    const attachments = await svc.listAttachments(id);

    const issue = await svc.remove(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }

    for (const attachment of attachments) {
      try {
        await storage.deleteObject(attachment.companyId, attachment.objectKey);
      } catch (err) {
        logger.warn({ err, issueId: id, attachmentId: attachment.id }, "failed to delete attachment object during issue delete");
      }
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.deleted",
      entityType: "issue",
      entityId: issue.id,
    });

    res.json(issue);
  });

  router.post("/issues/:id/checkout", validate(checkoutIssueSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);

    if (issue.projectId) {
      const project = await projectsSvc.getById(issue.projectId);
      if (project?.pausedAt) {
        res.status(409).json({
          error:
            project.pauseReason === "budget"
              ? "Project is paused because its budget hard-stop was reached"
              : "Project is paused",
        });
        return;
      }
    }

    if (req.actor.type === "agent" && req.actor.agentId !== req.body.agentId) {
      res.status(403).json({ error: "Agent can only checkout as itself" });
      return;
    }

    const closedExecutionWorkspace = await getClosedIssueExecutionWorkspace(issue);
    if (closedExecutionWorkspace) {
      respondClosedIssueExecutionWorkspace(res, closedExecutionWorkspace);
      return;
    }

    const preCheckoutContinuity = await continuitySvc.recomputeIssueContinuityState(issue.id);
    const executionBlock = describeExecutionReadinessBlock(preCheckoutContinuity);
    if (executionBlock) {
      res.status(409).json({ error: executionBlock });
      return;
    }

    const checkoutRunId = requireAgentRunId(req, res);
    if (req.actor.type === "agent" && !checkoutRunId) return;
    const updated = await svc.checkout(id, req.body.agentId, req.body.expectedStatuses, checkoutRunId);
    const continuityState = await continuitySvc.recomputeIssueContinuityState(updated.id);
    const actor = getActorInfo(req);

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.checked_out",
      entityType: "issue",
      entityId: issue.id,
      details: { agentId: req.body.agentId },
    });

    if (
      shouldWakeAssigneeOnCheckout({
        actorType: req.actor.type,
        actorAgentId: req.actor.type === "agent" ? req.actor.agentId ?? null : null,
        checkoutAgentId: req.body.agentId,
        checkoutRunId,
      }) &&
      shouldWakeAssignedAgentForIssue({ issue: updated, continuityState })
    ) {
      void heartbeat
        .wakeup(req.body.agentId, {
          source: "assignment",
          triggerDetail: "system",
          reason: "issue_checked_out",
          payload: { issueId: issue.id, mutation: "checkout" },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: { issueId: issue.id, source: "issue.checkout" },
        })
        .catch((err) => logger.warn({ err, issueId: issue.id }, "failed to wake assignee on issue checkout"));
    }

    res.json(updated);
  });

  router.post("/issues/:id/release", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    if (!(await assertAgentIssueMutationAllowed(req, res, existing))) return;
    const actorRunId = requireAgentRunId(req, res);
    if (req.actor.type === "agent" && !actorRunId) return;

    const released = await svc.release(
      id,
      req.actor.type === "agent" ? req.actor.agentId : undefined,
      actorRunId,
    );
    if (!released) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: released.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.released",
      entityType: "issue",
      entityId: released.id,
    });

    res.json(released);
  });

  router.get("/issues/:id/comments", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const afterCommentId =
      typeof req.query.after === "string" && req.query.after.trim().length > 0
        ? req.query.after.trim()
        : typeof req.query.afterCommentId === "string" && req.query.afterCommentId.trim().length > 0
          ? req.query.afterCommentId.trim()
          : null;
    const order =
      typeof req.query.order === "string" && req.query.order.trim().toLowerCase() === "asc"
        ? "asc"
        : "desc";
    const limitRaw =
      typeof req.query.limit === "string" && req.query.limit.trim().length > 0
        ? Number(req.query.limit)
        : null;
    const limit =
      limitRaw && Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.min(Math.floor(limitRaw), MAX_ISSUE_COMMENT_LIMIT)
        : null;
    const comments = await svc.listComments(id, {
      afterCommentId,
      order,
      limit,
    });
    res.json(comments);
  });

  router.get("/issues/:id/comments/:commentId", async (req, res) => {
    const id = req.params.id as string;
    const commentId = req.params.commentId as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const comment = await svc.getComment(commentId);
    if (!comment || comment.issueId !== id) {
      res.status(404).json({ error: "Comment not found" });
      return;
    }
    res.json(comment);
  });

  router.delete("/issues/:id/comments/:commentId", async (req, res) => {
    const id = req.params.id as string;
    const commentId = req.params.commentId as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;

    const comment = await svc.getComment(commentId);
    if (!comment || comment.issueId !== id) {
      res.status(404).json({ error: "Comment not found" });
      return;
    }

    const actor = getActorInfo(req);
    const actorOwnsComment =
      actor.actorType === "agent"
        ? comment.authorAgentId === actor.agentId
        : comment.authorUserId === actor.actorId;
    if (!actorOwnsComment) {
      res.status(403).json({ error: "Only the comment author can cancel queued comments" });
      return;
    }

    const activeRun = await resolveActiveIssueRun(issue);
    if (!activeRun) {
      res.status(409).json({ error: "Queued comment can no longer be canceled" });
      return;
    }

    if (!isQueuedIssueCommentForActiveRun({ comment, activeRun })) {
      res.status(409).json({ error: "Only queued comments can be canceled" });
      return;
    }

    const removed = await svc.removeComment(commentId);
    if (!removed) {
      res.status(404).json({ error: "Comment not found" });
      return;
    }
    await issueReferencesSvc.deleteCommentSource?.(removed.id);

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.comment_cancelled",
      entityType: "issue",
      entityId: issue.id,
      details: {
        commentId: removed.id,
        bodySnippet: removed.body.slice(0, 120),
        identifier: issue.identifier,
        issueTitle: issue.title,
        source: "queue_cancel",
        queueTargetRunId: activeRun.id,
      },
    });

    res.json(removed);
  });

  router.get("/issues/:id/feedback-votes", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Only board users can view feedback votes" });
      return;
    }

    const votes = await feedback.listIssueVotesForUser(id, req.actor.userId ?? "local-board");
    res.json(votes);
  });

  router.get("/issues/:id/feedback-traces", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Only board users can view feedback traces" });
      return;
    }

    const targetTypeRaw = typeof req.query.targetType === "string" ? req.query.targetType : undefined;
    const voteRaw = typeof req.query.vote === "string" ? req.query.vote : undefined;
    const statusRaw = typeof req.query.status === "string" ? req.query.status : undefined;
    const targetType = targetTypeRaw ? feedbackTargetTypeSchema.parse(targetTypeRaw) : undefined;
    const vote = voteRaw ? feedbackVoteValueSchema.parse(voteRaw) : undefined;
    const status = statusRaw ? feedbackTraceStatusSchema.parse(statusRaw) : undefined;

    const traces = await feedback.listFeedbackTraces({
      companyId: issue.companyId,
      issueId: issue.id,
      targetType,
      vote,
      status,
      from: parseDateQuery(req.query.from, "from"),
      to: parseDateQuery(req.query.to, "to"),
      sharedOnly: parseBooleanQuery(req.query.sharedOnly),
      includePayload: parseBooleanQuery(req.query.includePayload),
    });
    res.json(traces);
  });

  router.get("/feedback-traces/:traceId", async (req, res) => {
    const traceId = req.params.traceId as string;
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Only board users can view feedback traces" });
      return;
    }
    const includePayload = parseBooleanQuery(req.query.includePayload) || req.query.includePayload === undefined;
    const trace = await feedback.getFeedbackTraceById(traceId, includePayload);
    if (!trace || !actorCanAccessCompany(req, trace.companyId)) {
      res.status(404).json({ error: "Feedback trace not found" });
      return;
    }
    res.json(trace);
  });

  router.get("/feedback-traces/:traceId/bundle", async (req, res) => {
    const traceId = req.params.traceId as string;
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Only board users can view feedback trace bundles" });
      return;
    }
    const bundle = await feedback.getFeedbackTraceBundle(traceId);
    if (!bundle || !actorCanAccessCompany(req, bundle.companyId)) {
      res.status(404).json({ error: "Feedback trace not found" });
      return;
    }
    res.json(bundle);
  });

  router.post("/issues/:id/comments", validate(addIssueCommentSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;
    const closedExecutionWorkspace = await getClosedIssueExecutionWorkspace(issue);
    if (closedExecutionWorkspace) {
      respondClosedIssueExecutionWorkspace(res, closedExecutionWorkspace);
      return;
    }

    const actor = getActorInfo(req);
    const reopenRequested = req.body.reopen === true;
    const interruptRequested = req.body.interrupt === true;
    const isClosed = isClosedIssueStatus(issue.status);
    const effectiveReopenRequested =
      reopenRequested ||
      shouldImplicitlyReopenCommentForAgent({
        issueStatus: issue.status,
        assigneeAgentId: issue.assigneeAgentId,
        actorType: actor.actorType,
        actorId: actor.actorId,
      });
    let reopened = false;
    let reopenFromStatus: string | null = null;
    let interruptedRunId: string | null = null;
    let currentIssue = issue;
    const commentReferenceSummaryBefore = await issueReferencesSvc.listIssueReferenceSummary(issue.id);
    let mentionedIds: string[] = [];

    try {
      const mentionResolution = await svc.resolveMentionedAgents(issue.companyId, req.body.body);
      if (mentionResolution.ambiguousTokens.length > 0) {
        res.status(422).json({
          error: "Ambiguous @-mentions must be disambiguated with agent:// links",
          details: {
            ambiguousTokens: mentionResolution.ambiguousTokens,
          },
        });
        return;
      }
      mentionedIds = mentionResolution.agentIds;
    } catch (err) {
      logger.warn({ err, issueId: id }, "failed to resolve @-mentions");
    }

    if (effectiveReopenRequested && isClosed) {
      const reopenedIssue = await svc.update(id, { status: "todo" });
      if (!reopenedIssue) {
        res.status(404).json({ error: "Issue not found" });
        return;
      }
      reopened = true;
      reopenFromStatus = issue.status;
      currentIssue = reopenedIssue;

      await logActivity(db, {
        companyId: currentIssue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.updated",
        entityType: "issue",
        entityId: currentIssue.id,
        details: {
          status: "todo",
          reopened: true,
          reopenedFrom: reopenFromStatus,
          source: "comment",
          identifier: currentIssue.identifier,
        },
      });
    }

    if (interruptRequested) {
      if (req.actor.type !== "board") {
        res.status(403).json({ error: "Only board users can interrupt active runs from issue comments" });
        return;
      }

      const runToInterrupt = await resolveActiveIssueRun(currentIssue);
      if (runToInterrupt) {
        const cancelled = await heartbeat.cancelRun(runToInterrupt.id);
        if (cancelled) {
          interruptedRunId = cancelled.id;
          await logActivity(db, {
            companyId: cancelled.companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "heartbeat.cancelled",
            entityType: "heartbeat_run",
            entityId: cancelled.id,
            details: { agentId: cancelled.agentId, source: "issue_comment_interrupt", issueId: currentIssue.id },
          });
        }
      }
    }

    const comment = await svc.addComment(id, req.body.body, {
      agentId: actor.agentId ?? undefined,
      userId: actor.actorType === "user" ? actor.actorId : undefined,
      runId: actor.runId,
    });
    await issueReferencesSvc.syncComment(comment.id);
    const commentReferenceSummaryAfter = await issueReferencesSvc.listIssueReferenceSummary(currentIssue.id);
    const commentReferenceDiff = issueReferencesSvc.diffIssueReferenceSummary(
      commentReferenceSummaryBefore,
      commentReferenceSummaryAfter,
    );

    if (actor.runId) {
      await heartbeat.reportRunActivity(actor.runId).catch((err) =>
        logger.warn({ err, runId: actor.runId }, "failed to clear detached run warning after issue comment"));
    }

    await logActivity(db, {
      companyId: currentIssue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.comment_added",
      entityType: "issue",
      entityId: currentIssue.id,
      details: {
        commentId: comment.id,
        bodySnippet: comment.body.slice(0, 120),
        identifier: currentIssue.identifier,
        issueTitle: currentIssue.title,
        ...(reopened ? { reopened: true, reopenedFrom: reopenFromStatus, source: "comment" } : {}),
        ...(interruptedRunId ? { interruptedRunId } : {}),
        ...summarizeIssueReferenceActivityDetails({
          addedReferencedIssues: commentReferenceDiff.addedReferencedIssues.map(summarizeIssueRelationForActivity),
          removedReferencedIssues: commentReferenceDiff.removedReferencedIssues.map(summarizeIssueRelationForActivity),
          currentReferencedIssues: commentReferenceDiff.currentReferencedIssues.map(summarizeIssueRelationForActivity),
        }),
      },
    });

    // Merge all wakeups from this comment into one enqueue per agent to avoid duplicate runs.
    void (async () => {
      const wakeups = new Map<string, Parameters<typeof heartbeat.wakeup>[1]>();
      const assigneeId = currentIssue.assigneeAgentId;
      const actorIsAgent = actor.actorType === "agent";
      const selfComment = actorIsAgent && actor.actorId === assigneeId;
      const skipWake = selfComment || isClosed;
      if (assigneeId && (reopened || !skipWake)) {
        if (reopened) {
          wakeups.set(assigneeId, {
            source: "automation",
            triggerDetail: "system",
            reason: "issue_reopened_via_comment",
            payload: {
              issueId: currentIssue.id,
              commentId: comment.id,
              reopenedFrom: reopenFromStatus,
              mutation: "comment",
              ...(interruptedRunId ? { interruptedRunId } : {}),
            },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              issueId: currentIssue.id,
              taskId: currentIssue.id,
              commentId: comment.id,
              wakeCommentId: comment.id,
              source: "issue.comment.reopen",
              wakeReason: "issue_reopened_via_comment",
              reopenedFrom: reopenFromStatus,
              ...(interruptedRunId ? { interruptedRunId } : {}),
            },
          });
        } else {
          wakeups.set(assigneeId, {
            source: "automation",
            triggerDetail: "system",
            reason: "issue_commented",
            payload: {
              issueId: currentIssue.id,
              commentId: comment.id,
              mutation: "comment",
              ...(interruptedRunId ? { interruptedRunId } : {}),
            },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              issueId: currentIssue.id,
              taskId: currentIssue.id,
              commentId: comment.id,
              wakeCommentId: comment.id,
              source: "issue.comment",
              wakeReason: "issue_commented",
              ...(interruptedRunId ? { interruptedRunId } : {}),
            },
          });
        }
      }

      for (const mentionedId of mentionedIds) {
        if (isClosed && !reopened) continue;
        if (wakeups.has(mentionedId)) continue;
        if (actorIsAgent && actor.actorId === mentionedId) continue;
        wakeups.set(mentionedId, {
          source: "automation",
          triggerDetail: "system",
          reason: "issue_comment_mentioned",
          payload: { issueId: id, commentId: comment.id },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: {
            issueId: id,
            taskId: id,
            commentId: comment.id,
            wakeCommentId: comment.id,
            wakeReason: "issue_comment_mentioned",
            source: "comment.mention",
          },
        });
      }

      for (const [agentId, wakeup] of wakeups.entries()) {
        heartbeat
          .wakeup(agentId, wakeup)
          .catch((err) => logger.warn({ err, issueId: currentIssue.id, agentId }, "failed to wake agent on issue comment"));
      }
    })();

    res.status(201).json(comment);
  });

  router.post("/issues/:id/feedback-votes", validate(upsertIssueFeedbackVoteSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Only board users can vote on AI feedback" });
      return;
    }

    const actor = getActorInfo(req);
    const result = await feedback.saveIssueVote({
      issueId: id,
      targetType: req.body.targetType,
      targetId: req.body.targetId,
      vote: req.body.vote,
      reason: req.body.reason,
      authorUserId: req.actor.userId ?? "local-board",
      allowSharing: req.body.allowSharing === true,
    });

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.feedback_vote_saved",
      entityType: "issue",
      entityId: issue.id,
      details: {
        identifier: issue.identifier,
        targetType: result.vote.targetType,
        targetId: result.vote.targetId,
        vote: result.vote.vote,
        hasReason: Boolean(result.vote.reason),
        sharingEnabled: result.sharingEnabled,
      },
    });

    if (result.consentEnabledNow) {
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.feedback_data_sharing_updated",
        entityType: "company",
        entityId: issue.companyId,
        details: {
          feedbackDataSharingEnabled: true,
          source: "issue_feedback_vote",
        },
      });
    }

    if (result.persistedSharingPreference) {
      const settings = await instanceSettings.get();
      const companyIds = await instanceSettings.listCompanyIds();
      await Promise.all(
        companyIds.map((companyId) =>
          logActivity(db, {
            companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "instance.settings.general_updated",
            entityType: "instance_settings",
            entityId: settings.id,
            details: {
              general: settings.general,
              changedKeys: ["feedbackDataSharingPreference"],
              source: "issue_feedback_vote",
            },
          }),
        ),
      );
    }

    if (result.sharingEnabled && result.traceId && feedbackExportService) {
      try {
        await feedbackExportService.flushPendingFeedbackTraces({
          companyId: issue.companyId,
          traceId: result.traceId,
          limit: 1,
        });
      } catch (err) {
        logger.warn({ err, issueId: issue.id, traceId: result.traceId }, "failed to flush shared feedback trace immediately");
      }
    }

    res.status(201).json(result.vote);
  });

  router.get("/issues/:id/attachments", async (req, res) => {
    const issueId = req.params.id as string;
    const issue = await svc.getById(issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const attachments = await svc.listAttachments(issueId);
    res.json(attachments.map(withContentPath));
  });

  router.post("/companies/:companyId/issues/:issueId/attachments", async (req, res) => {
    const companyId = req.params.companyId as string;
    const issueId = req.params.issueId as string;
    assertCompanyAccess(req, companyId);
    const issue = await svc.getById(issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (issue.companyId !== companyId) {
      res.status(422).json({ error: "Issue does not belong to company" });
      return;
    }
    if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;

    try {
      await runSingleFileUpload(req, res);
    } catch (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          res.status(422).json({ error: `Attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes` });
          return;
        }
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }

    const file = (req as Request & { file?: { mimetype: string; buffer: Buffer; originalname: string } }).file;
    if (!file) {
      res.status(400).json({ error: "Missing file field 'file'" });
      return;
    }
    const contentType = normalizeContentType(file.mimetype);
    if (file.buffer.length <= 0) {
      res.status(422).json({ error: "Attachment is empty" });
      return;
    }

    const parsedMeta = createIssueAttachmentMetadataSchema.safeParse(req.body ?? {});
    if (!parsedMeta.success) {
      res.status(400).json({ error: "Invalid attachment metadata", details: parsedMeta.error.issues });
      return;
    }

    const actor = getActorInfo(req);
    const stored = await storage.putFile({
      companyId,
      namespace: `issues/${issueId}`,
      originalFilename: file.originalname || null,
      contentType,
      body: file.buffer,
    });

    const attachment = await svc.createAttachment({
      issueId,
      issueCommentId: parsedMeta.data.issueCommentId ?? null,
      provider: stored.provider,
      objectKey: stored.objectKey,
      contentType: stored.contentType,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      originalFilename: stored.originalFilename,
      createdByAgentId: actor.agentId,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      ...(await buildIssueAttachmentGovernance()),
    });

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.attachment_added",
      entityType: "issue",
      entityId: issueId,
      details: {
        attachmentId: attachment.id,
        originalFilename: attachment.originalFilename,
        contentType: attachment.contentType,
        byteSize: attachment.byteSize,
      },
    });

    res.status(201).json(withContentPath(attachment));
  });

  router.get("/attachments/:attachmentId/content", async (req, res, next) => {
    const attachmentId = req.params.attachmentId as string;
    const attachment = await svc.getAttachmentById(attachmentId);
    if (!attachment) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }
    assertCompanyAccess(req, attachment.companyId);
    const issue = await svc.getById(attachment.issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (attachment.deletedAt) {
      res.status(410).json({ error: "Attachment has been deleted" });
      return;
    }
    if (attachment.scanStatus !== "clean") {
      res.status(423).json({ error: `Attachment is not available while scan status is ${attachment.scanStatus}` });
      return;
    }

    const object = await storage.getObject(attachment.companyId, attachment.objectKey);
    const responseContentType = normalizeContentType(attachment.contentType || object.contentType);
    res.setHeader("Content-Type", responseContentType);
    res.setHeader("Content-Length", String(attachment.byteSize || object.contentLength || 0));
    res.setHeader("Cache-Control", "private, max-age=60");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (responseContentType === SVG_CONTENT_TYPE) {
      res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'");
    }
    const filename = attachment.originalFilename ?? "attachment";
    const disposition = isInlineAttachmentContentType(responseContentType) ? "inline" : "attachment";
    res.setHeader("Content-Disposition", `${disposition}; filename=\"${filename.replaceAll("\"", "")}\"`);

    object.stream.on("error", (err) => {
      next(err);
    });
    object.stream.pipe(res);
  });

  router.delete("/attachments/:attachmentId", async (req, res) => {
    const attachmentId = req.params.attachmentId as string;
    const attachment = await svc.getAttachmentById(attachmentId);
    if (!attachment) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }
    assertCompanyAccess(req, attachment.companyId);
    const issue = await svc.getById(attachment.issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;

    try {
      await storage.deleteObject(attachment.companyId, attachment.objectKey);
    } catch (err) {
      logger.warn({ err, attachmentId }, "storage delete failed while removing attachment");
    }

    const removed = await svc.removeAttachment(attachmentId);
    if (!removed) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: removed.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.attachment_removed",
      entityType: "issue",
      entityId: removed.issueId,
      details: {
        attachmentId: removed.id,
      },
    });

    res.json({ ok: true });
  });

  return router;
}
