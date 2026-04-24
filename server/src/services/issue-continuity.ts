import { createHash } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  companySkills,
  assets,
  executionWorkspaces,
  issueAttachments,
  issueComments,
  issueDecisionQuestions,
  issueExecutionDecisions,
  issues,
  sharedSkillProposals,
} from "@paperclipai/db";
import {
  ISSUE_BRANCH_CHARTER_DOCUMENT_KEY,
  ISSUE_BRANCH_CHARTER_KIND,
  ISSUE_BRANCH_RETURN_DOCUMENT_KIND,
  ISSUE_HANDOFF_DOCUMENT_KIND,
  ISSUE_PROGRESS_DOCUMENT_KIND,
  ISSUE_REVIEW_FINDINGS_DOCUMENT_KIND,
  buildIssueDocumentTemplate,
  createIssueContinuityBranchSchema,
  getIssueContinuityTierRequirements,
  handoffIssueContinuitySchema,
  handoffCancelIssueContinuitySchema,
  handoffRepairIssueContinuitySchema,
  issueDecisionQuestionSchema,
  issuePlanApprovalSummarySchema,
  issueContinuityBundleSchema,
  issueContinuityRemediationSchema,
  issueContinuityStateSchema,
  mergeIssueContinuityBranchSchema,
  parseIssueBranchReturnMarkdown,
  parseIssueHandoffMarkdown,
  parseIssueProgressMarkdown,
  parseIssueReviewFindingsMarkdown,
  progressCheckpointIssueContinuitySchema,
  promoteIssueReviewFindingSkillSchema,
  prepareIssueContinuitySchema,
  requestIssueSpecThawSchema,
  requestIssueContinuityDocUnfreezeSchema,
  reviewResubmitIssueContinuitySchema,
  reviewReturnIssueContinuitySchema,
  returnIssueContinuityBranchSchema,
  issueBranchMergePreviewSchema,
  type HandoffCancelIssueContinuity,
  type HandoffIssueContinuity,
  type HandoffRepairIssueContinuity,
  type IssueBranchMergePreview,
  type IssueBranchStatus,
  type IssueContinuityBundle,
  type IssueContinuityDocumentSnapshot,
  type IssueContinuityHealth,
  type IssuePlanApprovalPayload,
  type IssueContinuityRemediationAction,
  type IssueContinuityRemediation,
  type IssueDecisionQuestion,
  type IssueContinuityState,
  type IssueContinuityStatus,
  type IssueContinuityTier,
  type ProgressCheckpointIssueContinuity,
  type PromoteIssueReviewFindingSkill,
  type PrepareIssueContinuity,
  type RequestIssueSpecThaw,
  type RequestIssueContinuityDocUnfreeze,
  type IssueDocFreezeException,
  type ReviewResubmitIssueContinuity,
  type ReviewReturnIssueContinuity,
  type ReturnIssueContinuityBranch,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import {
  applyIssueExecutionPolicyTransition,
  normalizeIssueExecutionPolicy,
  parseIssueExecutionState,
} from "./issue-execution-policy.js";
import { approvalService } from "./approvals.js";
import { agentService } from "./agents.js";
import { companySkillService } from "./company-skills.js";
import { documentService } from "./documents.js";
import { normalizeBundledOpenDecisionQuestions } from "./issue-decision-question-bundles.js";
import { issueApprovalService } from "./issue-approvals.js";
import { issueService } from "./issues.js";
import { buildSkillHardeningScaffolds, SKILL_HARDENING_FINDING_ORIGIN_KIND } from "./skill-reliability-lib.js";

const CONTINUITY_STALE_PROGRESS_MS = 24 * 60 * 60 * 1000;
const ACTIVE_CONTINUITY_STATUSES = new Set(["in_progress", "in_review", "blocked"]);

function toIsoString(value: Date | string | null | undefined) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function timestampMs(value: Date | string | null | undefined) {
  const iso = toIsoString(value);
  return iso ? new Date(iso).getTime() : null;
}

function isContinuityExecuting(issue: {
  status: string;
  startedAt?: Date | string | null;
  executionState?: unknown;
}) {
  const executionState = parseIssueExecutionState(issue.executionState ?? null);
  return (
    issue.startedAt != null ||
    ACTIVE_CONTINUITY_STATUSES.has(issue.status) ||
    executionState?.status === "pending" ||
    executionState?.status === "changes_requested"
  );
}

// Checkout flips a todo task to in_progress and sets startedAt before any plan
// approval has been requested, so isContinuityExecuting cannot tell "just
// checked out, still planning" apart from "really executing." This predicate
// ignores status/startedAt and reports true only when execution-policy signals
// confirm the planning stage has ended.
export function hasPlanningStageEnded(issue: { executionState?: unknown }): boolean {
  const executionState = parseIssueExecutionState(issue.executionState ?? null);
  if (!executionState) return false;
  if (executionState.status === "pending" || executionState.status === "changes_requested") {
    return true;
  }
  return executionState.lastDecisionOutcome != null;
}

function continuityDocumentSnapshot(
  doc:
    | {
        key: string;
        title: string | null;
        body?: string | undefined;
        latestRevisionId: string | null;
        latestRevisionNumber: number;
        updatedAt: Date | string;
      }
    | null,
): IssueContinuityDocumentSnapshot | null {
  if (!doc || typeof doc.body !== "string") return null;
  return {
    key: doc.key,
    title: doc.title,
    body: doc.body,
    latestRevisionId: doc.latestRevisionId ?? null,
    latestRevisionNumber: doc.latestRevisionNumber,
    updatedAt: toIsoString(doc.updatedAt) ?? new Date(0).toISOString(),
  };
}

function yamlScalar(value: unknown) {
  if (value == null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(String(value));
}

function appendYamlValue(lines: string[], value: unknown, indent: number, key?: string) {
  const prefix = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (key) {
      if (value.length === 0) {
        lines.push(`${prefix}${key}: []`);
        return;
      }
      lines.push(`${prefix}${key}:`);
    }
    for (const entry of value) {
      if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
        lines.push(`${" ".repeat(indent + (key ? 2 : 0))}- ${Array.isArray(entry) ? "[]" : yamlScalar(entry)}`);
        continue;
      }
      lines.push(`${" ".repeat(indent + (key ? 2 : 0))}-`);
      for (const [nestedKey, nestedValue] of Object.entries(entry)) {
        appendYamlValue(lines, nestedValue, indent + (key ? 4 : 2), nestedKey);
      }
    }
    return;
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (key) {
      if (entries.length === 0) {
        lines.push(`${prefix}${key}: {}`);
        return;
      }
      lines.push(`${prefix}${key}:`);
    }
    for (const [nestedKey, nestedValue] of entries) {
      appendYamlValue(lines, nestedValue, indent + (key ? 2 : 0), nestedKey);
    }
    return;
  }

  if (!key) {
    lines.push(`${prefix}${yamlScalar(value)}`);
    return;
  }
  lines.push(`${prefix}${key}: ${yamlScalar(value)}`);
}

function buildStructuredFrontmatter(kind: string, fields: Record<string, unknown>, note?: string) {
  const lines = ["---", `kind: ${kind}`];
  for (const [key, rawValue] of Object.entries(fields)) {
    if (rawValue === undefined) continue;
    appendYamlValue(lines, rawValue, 0, key);
  }
  lines.push("---");
  if (note) lines.push("", note);
  return lines.join("\n");
}

function buildReviewFindingId(
  issueId: string,
  reviewStage: string,
  finding: ReviewReturnIssueContinuity["findings"][number],
  index: number,
) {
  return createHash("sha256")
    .update(JSON.stringify({
      issueId,
      reviewStage,
      index,
      severity: finding.severity,
      category: finding.category.trim().toLowerCase(),
      title: finding.title.trim().toLowerCase(),
      detail: finding.detail.trim().toLowerCase(),
      requiredAction: finding.requiredAction.trim().toLowerCase(),
      evidence: [...(finding.evidence ?? [])].map((value) => value.trim()).sort(),
    }))
    .digest("hex")
    .slice(0, 16);
}

function actorLabel(actor: { agentId?: string | null; userId?: string | null }) {
  if (actor.agentId) return `agent:${actor.agentId}`;
  if (actor.userId) return `user:${actor.userId}`;
  return "unknown";
}

function currentAssigneeTarget(issue: { assigneeAgentId: string | null; assigneeUserId?: string | null }) {
  if (issue.assigneeAgentId) return `agent:${issue.assigneeAgentId}`;
  if (issue.assigneeUserId) return `user:${issue.assigneeUserId}`;
  return null;
}

function chooseContinuityTier(input: {
  issue: { parentId: string | null; status: string; startedAt?: Date | string | null; executionState?: unknown };
  existingState: IssueContinuityState | null;
  documentKeys: Set<string>;
  unresolvedBranchIssueIds: string[];
  preparedTier?: IssueContinuityTier | null;
}) {
  if (input.preparedTier) return input.preparedTier;
  if (input.existingState?.tier) return input.existingState.tier;
  if (
    input.documentKeys.has("runbook") ||
    input.documentKeys.has("handoff") ||
    input.unresolvedBranchIssueIds.length > 0
  ) {
    return "long_running";
  }
  if (
    input.issue.parentId ||
    input.documentKeys.has("plan") ||
    input.documentKeys.has("test-plan") ||
    isContinuityExecuting(input.issue)
  ) {
    return "normal";
  }
  return "tiny";
}

function existingStateFromIssue(issue: { continuityState?: unknown }): IssueContinuityState | null {
  const parsed = issueContinuityStateSchema.safeParse(issue.continuityState ?? null);
  return parsed.success ? parsed.data : null;
}

type ContinuityIssueRecord = NonNullable<Awaited<ReturnType<ReturnType<typeof issueService>["getById"]>>>;
type ContinuityDocumentRow = {
  key: string;
  title: string | null;
  body?: string | undefined;
  latestRevisionId: string | null;
  latestRevisionNumber: number;
  updatedAt: Date | string;
};
type LinkedApprovalSummary = {
  id: string;
  status: string;
  type: string;
  payload: Record<string, unknown>;
  decisionNote?: string | null;
  createdAt?: Date | string | null;
  decidedAt?: Date | string | null;
};

type LinkedPlanApprovalSummary = {
  approval: LinkedApprovalSummary;
  payload: IssuePlanApprovalPayload;
};

type PlanApprovalRequestResult = {
  approvalId: string | null;
  approvalStatus: string | null;
  continuityState: IssueContinuityState;
  continuityBundle: IssueContinuityBundle;
};

function parseIssuePlanApprovalPayload(payload: Record<string, unknown> | null | undefined): IssuePlanApprovalPayload | null {
  if (!payload || payload.kind !== "issue_plan_approval") return null;
  if (
    typeof payload.title !== "string" ||
    typeof payload.summary !== "string" ||
    typeof payload.issueId !== "string" ||
    typeof payload.issueTitle !== "string" ||
    typeof payload.planRevisionId !== "string"
  ) {
    return null;
  }

  return {
    kind: "issue_plan_approval",
    title: payload.title,
    summary: payload.summary,
    issueId: payload.issueId,
    issueTitle: payload.issueTitle,
    planRevisionId: payload.planRevisionId,
    decisionTier: "board",
    ...(typeof payload.identifier === "string" ? { identifier: payload.identifier } : {}),
    ...(typeof payload.specRevisionId === "string" ? { specRevisionId: payload.specRevisionId } : {}),
    ...(typeof payload.testPlanRevisionId === "string" ? { testPlanRevisionId: payload.testPlanRevisionId } : {}),
    ...(typeof payload.recommendedAction === "string" ? { recommendedAction: payload.recommendedAction } : {}),
    ...(typeof payload.nextActionOnApproval === "string" ? { nextActionOnApproval: payload.nextActionOnApproval } : {}),
    ...(Array.isArray(payload.risks) ? { risks: payload.risks.filter((entry): entry is string => typeof entry === "string") } : {}),
    ...(typeof payload.proposedComment === "string" ? { proposedComment: payload.proposedComment } : {}),
  };
}

function buildIssuePlanApprovalState(input: {
  linkedApprovals: LinkedApprovalSummary[];
  currentPlanRevisionId: string | null;
  specRevisionId: string | null;
  testPlanRevisionId: string | null;
  requirePlanApproval: boolean;
}) {
  const linkedPlanApprovals: LinkedPlanApprovalSummary[] = input.linkedApprovals
    .filter((approval) => approval.type === "request_board_approval")
    .map((approval) => {
      const payload = parseIssuePlanApprovalPayload(approval.payload);
      return payload ? { approval, payload } : null;
    })
    .filter((value): value is LinkedPlanApprovalSummary => Boolean(value));

  const latestPlanApproval = linkedPlanApprovals[0] ?? null;
  const latestCurrentRevisionPlanApproval =
    input.currentPlanRevisionId == null
      ? null
      : linkedPlanApprovals.find((entry) => entry.payload.planRevisionId === input.currentPlanRevisionId) ?? null;
  const latestApprovedPlanApproval = linkedPlanApprovals.find((entry) => entry.approval.status === "approved") ?? null;
  const currentRevisionApproved = latestCurrentRevisionPlanApproval?.approval.status === "approved";
  const latestRequestedRevisionId = latestPlanApproval?.payload.planRevisionId ?? null;
  const approvedPlanRevisionId = latestApprovedPlanApproval?.payload.planRevisionId ?? null;
  const latestStatus = latestPlanApproval?.approval.status ?? null;
  const approvedRevisionIsStale = Boolean(
    input.currentPlanRevisionId &&
    approvedPlanRevisionId &&
    approvedPlanRevisionId !== input.currentPlanRevisionId,
  );
  const requiresResubmission =
    input.requirePlanApproval &&
    Boolean(
      latestStatus === "revision_requested" ||
      approvedRevisionIsStale,
    );

  const summary = issuePlanApprovalSummarySchema.parse({
    approvalId: latestPlanApproval?.approval.id ?? null,
    status: latestStatus,
    currentPlanRevisionId: input.currentPlanRevisionId,
    requestedPlanRevisionId: latestRequestedRevisionId,
    approvedPlanRevisionId,
    specRevisionId: input.specRevisionId,
    testPlanRevisionId: input.testPlanRevisionId,
    decisionNote:
      typeof latestPlanApproval?.approval.decisionNote === "string" && latestPlanApproval.approval.decisionNote.trim().length > 0
        ? latestPlanApproval.approval.decisionNote
        : null,
    lastRequestedAt: toIsoString(latestPlanApproval?.approval.createdAt ?? null),
    lastDecidedAt: toIsoString(latestPlanApproval?.approval.decidedAt ?? null),
    currentRevisionApproved,
    requiresApproval: Boolean(input.requirePlanApproval && input.currentPlanRevisionId && !currentRevisionApproved),
    requiresResubmission,
  });

  return {
    summary,
    latestPlanApproval,
    latestApprovedPlanApproval,
  };
}

export function issueContinuityService(db: Db) {
  const docsSvc = documentService(db);
  const issuesSvc = issueService(db);
  const agentSvc = agentService(db);
  const companySkillsSvc = companySkillService(db);
  const issueApprovalsSvc = issueApprovalService(db);
  const approvalsSvc = approvalService(db);

  function resolveScopedServices(dbOrTx: Db) {
    return {
      docsSvc: documentService(dbOrTx),
      issuesSvc: issueService(dbOrTx),
      issueApprovalsSvc: issueApprovalService(dbOrTx),
      approvalsSvc: approvalService(dbOrTx),
    };
  }

  async function withLockedIssueRow<T>(issueId: string, fn: (dbOrTx: Db) => Promise<T>) {
    return db.transaction(async (tx) => {
      await tx.execute(
        sql`select ${issues.id} from ${issues} where ${issues.id} = ${issueId} for update`,
      );
      const lockedDb = tx as unknown as Db;
      const lockedIssue = await lockedDb
        .select({ id: issues.id })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      if (!lockedIssue) throw notFound("Issue not found");
      return fn(lockedDb);
    });
  }

  async function getIssueOrThrow(issueId: string, dbOrTx: Db = db) {
    const issue = await resolveScopedServices(dbOrTx).issuesSvc.getById(issueId);
    if (!issue) throw notFound("Issue not found");
    return issue;
  }

  async function getChildBranchRows(issue: ContinuityIssueRecord, dbOrTx: Db = db) {
    return dbOrTx
      .select({
        id: issues.id,
        status: issues.status,
        continuityState: issues.continuityState,
      })
      .from(issues)
      .where(and(eq(issues.companyId, issue.companyId), eq(issues.parentId, issue.id), isNull(issues.hiddenAt)));
  }

  async function getContinuityMaterial(issueId: string, dbOrTx: Db = db) {
    const scopedServices = resolveScopedServices(dbOrTx);
    const issue = await getIssueOrThrow(issueId, dbOrTx);
    await normalizeBundledOpenDecisionQuestions(dbOrTx, { issueId: issue.id, companyId: issue.companyId });
    const [issueDocs, projectContext, projectRunbook, linkedApprovals, childRows, questionRows] = await Promise.all([
      scopedServices.docsSvc.listIssueDocuments(issue.id),
      issue.projectId ? scopedServices.docsSvc.getProjectDocumentByKey(issue.projectId, "context") : Promise.resolve(null),
      issue.projectId ? scopedServices.docsSvc.getProjectDocumentByKey(issue.projectId, "runbook") : Promise.resolve(null),
      scopedServices.issueApprovalsSvc.listApprovalsForIssue(issue.id),
      getChildBranchRows(issue, dbOrTx),
      dbOrTx
        .select()
        .from(issueDecisionQuestions)
        .where(and(eq(issueDecisionQuestions.companyId, issue.companyId), eq(issueDecisionQuestions.issueId, issue.id))),
    ]);
    return {
      issue,
      issueDocs,
      issueDocsByKey: new Map(issueDocs.map((doc) => [doc.key, doc])),
      projectContext,
      projectRunbook,
      linkedApprovals,
      childRows,
      decisionQuestions: questionRows.map((row) => issueDecisionQuestionSchema.parse({
        ...row,
        recommendedOptions: Array.isArray(row.recommendedOptions) ? row.recommendedOptions : [],
        answer: row.answer ?? null,
      })),
    };
  }

  function computeContinuityState(input: {
    issue: ContinuityIssueRecord;
    issueDocsByKey: Map<string, ContinuityDocumentRow>;
    linkedApprovals: LinkedApprovalSummary[];
    childRows: Array<{ id: string; status: string; continuityState: Record<string, unknown> | null }>;
    decisionQuestions: IssueDecisionQuestion[];
    preparedTier?: IssueContinuityTier | null;
    lastPreparedAt?: string | null;
    forceBranchStatus?: IssueBranchStatus | null;
    forceStatus?: IssueContinuityStatus | null;
    forceSpecState?: IssueContinuityState["specState"] | null;
  }): IssueContinuityState {
    const existingState = issueContinuityStateSchema.safeParse(input.issue.continuityState ?? null).success
      ? issueContinuityStateSchema.parse(input.issue.continuityState)
      : null;
    const documentKeys = new Set(input.issueDocsByKey.keys());
    const branchRoleFromDocs =
      input.issue.parentId &&
      (documentKeys.has(ISSUE_BRANCH_CHARTER_DOCUMENT_KEY) || existingState?.branchRole === "branch")
        ? "branch"
        : "none";
    const childStates = input.childRows.map((row) => {
      const parsed = issueContinuityStateSchema.safeParse(row.continuityState ?? null);
      return {
        id: row.id,
        status: row.status,
        continuityState: parsed.success ? parsed.data : null,
      };
    });
    const unresolvedBranchIssueIds = childStates
      .filter((row) => row.continuityState?.branchRole === "branch" && !["merged", "expired"].includes(row.continuityState.branchStatus))
      .map((row) => row.id);
    const returnedBranchIssueIds = childStates
      .filter((row) => row.continuityState?.branchRole === "branch" && row.continuityState.branchStatus === "returned")
      .map((row) => row.id);
    const openDecisionQuestions = input.decisionQuestions.filter((question) => question.status === "open");
    const blockingDecisionQuestions = openDecisionQuestions.filter((question) => question.blocking);
    const tier = chooseContinuityTier({
      issue: input.issue,
      existingState,
      documentKeys,
      unresolvedBranchIssueIds,
      preparedTier: input.preparedTier ?? null,
    });
    const requiredDocumentKeys = getIssueContinuityTierRequirements(tier);
    const missingDocumentKeys = requiredDocumentKeys.filter((key) => !documentKeys.has(key));
    const handoffDoc = input.issueDocsByKey.get("handoff");
    const progressDoc = input.issueDocsByKey.get("progress");
    const reviewFindingsDoc = input.issueDocsByKey.get("review-findings");
    const branchReturnDoc = input.issueDocsByKey.get("branch-return");
    const parsedHandoff =
      handoffDoc && typeof handoffDoc.body === "string" ? parseIssueHandoffMarkdown(handoffDoc.body) : null;
    const parsedReviewFindings =
      reviewFindingsDoc && typeof reviewFindingsDoc.body === "string"
        ? parseIssueReviewFindingsMarkdown(reviewFindingsDoc.body)
        : null;
    const parsedBranchReturn =
      branchReturnDoc && typeof branchReturnDoc.body === "string"
        ? parseIssueBranchReturnMarkdown(branchReturnDoc.body)
        : null;
    const specThawApproval =
      input.linkedApprovals.find((approval: LinkedApprovalSummary) =>
        approval.type === "request_board_approval" &&
        approval.payload?.kind === "issue_spec_thaw"
      ) ?? null;
    const lastHandoffAt = toIsoString(handoffDoc?.updatedAt) ?? existingState?.lastHandoffAt ?? null;
    const lastProgressAt = toIsoString(progressDoc?.updatedAt) ?? existingState?.lastProgressAt ?? null;
    const lastReviewFindingsAt = toIsoString(reviewFindingsDoc?.updatedAt) ?? existingState?.lastReviewFindingsAt ?? null;
    const lastReviewReturnAt = parsedReviewFindings?.document.resolutionState === "open"
      ? toIsoString(reviewFindingsDoc?.updatedAt) ?? existingState?.lastReviewReturnAt ?? null
      : existingState?.lastReviewReturnAt ?? null;
    const lastBranchReturnAt = (
      parsedBranchReturn
        ? toIsoString(branchReturnDoc?.updatedAt)
        : childStates
            .map((row) => row.continuityState?.lastBranchReturnAt ?? null)
            .filter((value): value is string => Boolean(value))
            .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null
    ) ?? existingState?.lastBranchReturnAt ?? null;
    const lastDecisionQuestionAt = input.decisionQuestions
      .map((question) => toIsoString(question.createdAt))
      .filter((value): value is string => Boolean(value))
      .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? existingState?.lastDecisionQuestionAt ?? null;
    const lastDecisionAnswerAt = input.decisionQuestions
      .map((question) => toIsoString(question.answeredAt))
      .filter((value): value is string => Boolean(value))
      .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? existingState?.lastDecisionAnswerAt ?? null;
    const progressAfterHandoff =
      (timestampMs(progressDoc?.updatedAt) ?? 0) > (timestampMs(handoffDoc?.updatedAt) ?? Number.POSITIVE_INFINITY);
    const handoffTargetMatchesOwner =
      !parsedHandoff?.document.transferTarget || parsedHandoff.document.transferTarget === currentAssigneeTarget(input.issue);
    const openReviewFindingsRevisionId =
      parsedReviewFindings && parsedReviewFindings.document.resolutionState === "open"
        ? reviewFindingsDoc?.latestRevisionId ?? null
        : null;
    const currentPlanRevisionId = input.issueDocsByKey.get("plan")?.latestRevisionId ?? null;
    const currentSpecRevisionId = input.issueDocsByKey.get("spec")?.latestRevisionId ?? null;
    const currentTestPlanRevisionId = input.issueDocsByKey.get("test-plan")?.latestRevisionId ?? null;

    let specState: IssueContinuityState["specState"] = input.forceSpecState
      ?? existingState?.specState
      ?? "editable";
    if (input.forceSpecState) {
      specState = input.forceSpecState;
    } else if (specThawApproval?.status === "approved") {
      specState = "thawed";
    } else if (specThawApproval?.status === "pending" || specThawApproval?.status === "revision_requested") {
      specState = "thaw_requested";
    } else {
      specState = isContinuityExecuting(input.issue) ? "frozen" : "editable";
    }

    const branchRole =
      unresolvedBranchIssueIds.length > 0
        ? "parent"
        : branchRoleFromDocs === "branch"
          ? "branch"
          : "none";
    let branchStatus: IssueBranchStatus = input.forceBranchStatus ?? existingState?.branchStatus ?? "none";
    if (!input.forceBranchStatus) {
      if (branchRole === "parent") {
        branchStatus = unresolvedBranchIssueIds.length > 0 ? "open" : "none";
      } else if (branchRole === "branch") {
        if (branchStatus === "merged" || branchStatus === "expired") {
          // Preserve explicit closeout states.
        } else if (parsedBranchReturn) {
          branchStatus = "returned";
        } else if (input.issue.status === "cancelled") {
          branchStatus = "expired";
        } else {
          branchStatus = "open";
        }
      } else {
        branchStatus = "none";
      }
    }

    const requirePlanApproval =
      tier === "normal"
      && !isContinuityExecuting(input.issue)
      && branchRole === "none"
      && openReviewFindingsRevisionId == null
      && !(existingState?.status === "handoff_pending" && parsedHandoff && handoffTargetMatchesOwner && !progressAfterHandoff);
    const planApproval = buildIssuePlanApprovalState({
      linkedApprovals: input.linkedApprovals,
      currentPlanRevisionId,
      specRevisionId: currentSpecRevisionId,
      testPlanRevisionId: currentTestPlanRevisionId,
      requirePlanApproval,
    }).summary;

    let health: IssueContinuityHealth = "healthy";
    let healthReason: string | null = null;
    let healthDetails: string[] = [];
    if (missingDocumentKeys.length > 0) {
      health = "missing_required_docs";
      healthReason = "missing_required_docs";
      healthDetails = [`Missing required docs: ${missingDocumentKeys.join(", ")}`];
    } else if (existingState?.status === "handoff_pending" && (!parsedHandoff || !handoffTargetMatchesOwner)) {
      health = "invalid_handoff";
      healthReason = !parsedHandoff ? "handoff_document_invalid" : "handoff_target_mismatch";
      healthDetails = !parsedHandoff
        ? ["Pending handoff does not have a valid typed handoff artifact."]
        : [`Pending handoff target does not match the current owner (${currentAssigneeTarget(input.issue) ?? "unassigned"}).`];
    } else if (
      isContinuityExecuting(input.issue) &&
      lastProgressAt &&
      Date.now() - new Date(lastProgressAt).getTime() > CONTINUITY_STALE_PROGRESS_MS
    ) {
      health = "stale_progress";
      healthReason = "progress_checkpoint_stale";
      healthDetails = [`Last progress checkpoint was recorded at ${lastProgressAt}.`];
    }

    let status: IssueContinuityStatus = input.forceStatus ?? existingState?.status ?? "draft";
    if (input.forceStatus) {
      status = input.forceStatus;
    } else if (existingState?.status === "handoff_pending" && parsedHandoff && handoffTargetMatchesOwner && !progressAfterHandoff) {
      status = "handoff_pending";
    } else if (blockingDecisionQuestions.length > 0) {
      status = "awaiting_decision";
    } else if (isContinuityExecuting(input.issue)) {
      status = "active";
    } else if (missingDocumentKeys.length > 0) {
      status = "planning";
    } else if (requirePlanApproval && !planApproval.currentRevisionApproved) {
      status =
        planApproval.status === "pending" || planApproval.status === "revision_requested"
          ? "awaiting_decision"
          : "planning";
    } else if (
      (input.lastPreparedAt ?? existingState?.lastPreparedAt)
      || input.issueDocsByKey.has("spec")
      || input.issueDocsByKey.has("plan")
    ) {
      status = "ready";
    } else {
      status = "planning";
    }

    return issueContinuityStateSchema.parse({
      tier,
      status,
      health,
      healthReason,
      healthDetails,
      requiredDocumentKeys,
      missingDocumentKeys,
      specState,
      branchRole,
      branchStatus,
      unresolvedBranchIssueIds,
      returnedBranchIssueIds,
      openReviewFindingsRevisionId,
      openDecisionQuestionCount: openDecisionQuestions.length,
      blockingDecisionQuestionCount: blockingDecisionQuestions.length,
      lastDecisionQuestionAt,
      lastDecisionAnswerAt,
      lastProgressAt,
      lastHandoffAt,
      lastReviewFindingsAt,
      lastReviewReturnAt,
      lastBranchReturnAt,
      lastPreparedAt: input.lastPreparedAt ?? existingState?.lastPreparedAt ?? null,
      lastBundleHash: existingState?.lastBundleHash ?? null,
      planApproval,
      docFreezeExceptions: existingState?.docFreezeExceptions ?? [],
    });
  }

  async function persistContinuityState(
    issueId: string,
    nextState: IssueContinuityState,
    dbOrTx?: Db,
  ): Promise<IssueContinuityState> {
    if (!dbOrTx) {
      return withLockedIssueRow(issueId, async (lockedDb) => persistContinuityState(issueId, nextState, lockedDb));
    }
    await dbOrTx
      .update(issues)
      .set({ continuityState: nextState as unknown as Record<string, unknown> })
      .where(eq(issues.id, issueId));
    return nextState;
  }

  async function recomputeIssueContinuityState(
    issueId: string,
    overrides?: {
      tier?: IssueContinuityTier | null;
      lastPreparedAt?: string | null;
      forceBranchStatus?: IssueBranchStatus | null;
      forceStatus?: IssueContinuityStatus | null;
      forceSpecState?: IssueContinuityState["specState"] | null;
    },
  ) {
    return withLockedIssueRow(issueId, async (lockedDb) => {
      const material = await getContinuityMaterial(issueId, lockedDb);
      const nextState = computeContinuityState({
        issue: material.issue,
        issueDocsByKey: material.issueDocsByKey,
        linkedApprovals: material.linkedApprovals,
        childRows: material.childRows,
        decisionQuestions: material.decisionQuestions,
        preparedTier: overrides?.tier ?? null,
        lastPreparedAt: overrides?.lastPreparedAt ?? null,
        forceBranchStatus: overrides?.forceBranchStatus ?? null,
        forceStatus: overrides?.forceStatus ?? null,
        forceSpecState: overrides?.forceSpecState ?? null,
      });
      await persistContinuityState(issueId, nextState, lockedDb);
      return nextState;
    });
  }

  async function buildContinuityBundle(issueId: string) {
    return withLockedIssueRow(issueId, async (lockedDb) => {
      const material = await getContinuityMaterial(issueId, lockedDb);
      let continuityState = computeContinuityState({
        issue: material.issue,
        issueDocsByKey: material.issueDocsByKey,
        linkedApprovals: material.linkedApprovals,
        childRows: material.childRows,
        decisionQuestions: material.decisionQuestions,
      });

      const decisionQuestions = material.decisionQuestions;
      const issueDocuments = {
        spec: continuityDocumentSnapshot(material.issueDocsByKey.get("spec") ?? null),
        plan: continuityDocumentSnapshot(material.issueDocsByKey.get("plan") ?? null),
        runbook: continuityDocumentSnapshot(material.issueDocsByKey.get("runbook") ?? null),
        progress: continuityDocumentSnapshot(material.issueDocsByKey.get("progress") ?? null),
        "test-plan": continuityDocumentSnapshot(material.issueDocsByKey.get("test-plan") ?? null),
        handoff: continuityDocumentSnapshot(material.issueDocsByKey.get("handoff") ?? null),
        "review-findings": continuityDocumentSnapshot(material.issueDocsByKey.get("review-findings") ?? null),
        "branch-return": continuityDocumentSnapshot(material.issueDocsByKey.get("branch-return") ?? null),
      } as const;
      const projectDocuments = {
        context: continuityDocumentSnapshot(material.projectContext),
        runbook: continuityDocumentSnapshot(material.projectRunbook),
      } as const;
      const [attachmentRows, commentRows, executionWorkspace] = await Promise.all([
        lockedDb
          .select({
            attachmentId: issueAttachments.id,
            assetId: assets.id,
            issueCommentId: issueAttachments.issueCommentId,
            originalFilename: assets.originalFilename,
            contentType: assets.contentType,
            sha256: assets.sha256,
            scanStatus: assets.scanStatus,
            contentPath: assets.objectKey,
            createdAt: assets.createdAt,
          })
          .from(issueAttachments)
          .innerJoin(assets, eq(issueAttachments.assetId, assets.id))
          .where(and(eq(issueAttachments.issueId, issueId), isNull(assets.deletedAt)))
          .orderBy(sql`${assets.createdAt} desc`),
        lockedDb
          .select({
            commentId: issueComments.id,
            authorAgentId: issueComments.authorAgentId,
            authorUserId: issueComments.authorUserId,
            createdAt: issueComments.createdAt,
            body: issueComments.body,
          })
          .from(issueComments)
          .where(eq(issueComments.issueId, issueId))
          .orderBy(sql`${issueComments.createdAt} desc`)
          .limit(10),
        material.issue.executionWorkspaceId
          ? lockedDb
              .select({
                id: executionWorkspaces.id,
                status: executionWorkspaces.status,
                cwd: executionWorkspaces.cwd,
                branchName: executionWorkspaces.branchName,
                cleanupState: executionWorkspaces.cleanupState,
                reconcileState: executionWorkspaces.reconcileState,
                lastReconciledAt: executionWorkspaces.lastReconciledAt,
              })
              .from(executionWorkspaces)
              .where(eq(executionWorkspaces.id, material.issue.executionWorkspaceId))
              .then((rows) => rows[0] ?? null)
          : null,
      ]);
      const evidenceManifest = {
        attachments: attachmentRows.map((row) => ({
          attachmentId: row.attachmentId,
          assetId: row.assetId,
          issueCommentId: row.issueCommentId ?? null,
          originalFilename: row.originalFilename ?? null,
          contentType: row.contentType,
          sha256: row.sha256,
          scanStatus: row.scanStatus as "pending_scan" | "clean" | "quarantined" | "scan_failed",
          contentPath: row.contentPath,
          createdAt: row.createdAt.toISOString(),
        })),
        recentComments: [...commentRows]
          .reverse()
          .map((row) => ({
            commentId: row.commentId,
            authorAgentId: row.authorAgentId ?? null,
            authorUserId: row.authorUserId ?? null,
            createdAt: row.createdAt.toISOString(),
            bodyExcerpt: row.body.slice(0, 280),
          })),
        executionWorkspace: executionWorkspace
          ? {
              id: executionWorkspace.id,
              status: executionWorkspace.status,
              cwd: executionWorkspace.cwd ?? null,
              branchName: executionWorkspace.branchName ?? null,
              cleanupState: executionWorkspace.cleanupState ?? null,
              reconcileState: executionWorkspace.reconcileState ?? null,
              lastReconciledAt: toIsoString(executionWorkspace.lastReconciledAt),
            }
          : null,
      } as const;
      const referencedRevisionIds: Record<string, string | null> = {
        spec: issueDocuments.spec?.latestRevisionId ?? null,
        plan: issueDocuments.plan?.latestRevisionId ?? null,
        runbook: issueDocuments.runbook?.latestRevisionId ?? null,
        progress: issueDocuments.progress?.latestRevisionId ?? null,
        "test-plan": issueDocuments["test-plan"]?.latestRevisionId ?? null,
        handoff: issueDocuments.handoff?.latestRevisionId ?? null,
        "review-findings": issueDocuments["review-findings"]?.latestRevisionId ?? null,
        "branch-return": issueDocuments["branch-return"]?.latestRevisionId ?? null,
        "project:context": projectDocuments.context?.latestRevisionId ?? null,
        "project:runbook": projectDocuments.runbook?.latestRevisionId ?? null,
      };
      const generatedAt = new Date().toISOString();
      const bundleInput = {
        issueId: material.issue.id,
        generatedAt,
        bundleHash: "",
        continuityState,
        executionState: parseIssueExecutionState(material.issue.executionState ?? null),
        decisionQuestions,
        planApproval: continuityState.planApproval,
        issueDocuments,
        projectDocuments,
        evidenceManifest,
        referencedRevisionIds,
      };
      const bundleHash = createHash("sha256")
        .update(JSON.stringify({
          continuityState,
          executionState: bundleInput.executionState,
          decisionQuestions,
          planApproval: bundleInput.planApproval,
          issueDocuments,
          projectDocuments,
          evidenceManifest,
          referencedRevisionIds,
        }))
        .digest("hex");
      continuityState = issueContinuityStateSchema.parse({
        ...continuityState,
        lastBundleHash: bundleHash,
      });
      if (
        material.issue.continuityState == null ||
        (material.issue.continuityState as Record<string, unknown>).lastBundleHash !== bundleHash
      ) {
        await persistContinuityState(issueId, continuityState, lockedDb);
      }
      return issueContinuityBundleSchema.parse({
        ...bundleInput,
        bundleHash,
        continuityState,
      });
    });
  }

  async function upsertScaffoldedIssueDocument(input: {
    issueId: string;
    key: string;
    body: string;
    createdByAgentId?: string | null;
    createdByUserId?: string | null;
    createdByRunId?: string | null;
    title?: string | null;
  }) {
    const existing = await docsSvc.getIssueDocumentByKey(input.issueId, input.key);
    return docsSvc.upsertIssueDocument({
      issueId: input.issueId,
      key: input.key,
      title: input.title ?? null,
      format: "markdown",
      body: input.body,
      changeSummary: existing ? "Update continuity document" : "Create continuity document",
      baseRevisionId: existing?.latestRevisionId ?? null,
      createdByAgentId: input.createdByAgentId ?? null,
      createdByUserId: input.createdByUserId ?? null,
      createdByRunId: input.createdByRunId ?? null,
    });
  }

  async function appendProgressCheckpoint(
    issueId: string,
    input: ProgressCheckpointIssueContinuity,
    actor: { agentId?: string | null; userId?: string | null; runId?: string | null } = {},
  ) {
    const parsed = progressCheckpointIssueContinuitySchema.parse(input);
    const existing = await docsSvc.getIssueDocumentByKey(issueId, "progress");
    const parsedExisting = existing?.body ? parseIssueProgressMarkdown(existing.body) : null;
    if (existing && !parsedExisting) {
      throw unprocessable("Progress document must be a valid typed continuity artifact before appending checkpoints");
    }

    const checkpointAt = new Date().toISOString();
    const checkpoint = {
      at: checkpointAt,
      completed: parsed.completed ?? [],
      currentState: parsed.currentState,
      knownPitfalls: parsed.knownPitfalls ?? [],
      nextAction: parsed.nextAction,
      openQuestions: parsed.openQuestions ?? [],
      evidence: parsed.evidence ?? [],
    };
    const body = buildStructuredFrontmatter(
      ISSUE_PROGRESS_DOCUMENT_KIND,
      {
        summary: parsed.summary ?? parsedExisting?.document.summary ?? parsed.currentState,
        currentState: parsed.currentState,
        knownPitfalls: parsed.knownPitfalls ?? [],
        nextAction: parsed.nextAction,
        openQuestions: parsed.openQuestions ?? [],
        evidence: parsed.evidence ?? [],
        checkpoints: [...(parsedExisting?.document.checkpoints ?? []), checkpoint],
      },
      parsedExisting?.body || "Continuity progress log.",
    );
    await upsertScaffoldedIssueDocument({
      issueId,
      key: "progress",
      body,
      createdByAgentId: actor.agentId ?? null,
      createdByUserId: actor.userId ?? null,
      createdByRunId: actor.runId ?? null,
    });
    return checkpointAt;
  }

  async function recordExecutionDecision(input: {
    issueId: string;
    decision: { stageId: string; stageType: "review" | "approval"; outcome: "approved" | "changes_requested"; body: string };
    actor: { agentId?: string | null; userId?: string | null; runId?: string | null };
  }) {
    const issue = await getIssueOrThrow(input.issueId);
    await db.insert(issueExecutionDecisions).values({
      companyId: issue.companyId,
      issueId: input.issueId,
      stageId: input.decision.stageId,
      stageType: input.decision.stageType,
      actorAgentId: input.actor.agentId ?? null,
      actorUserId: input.actor.userId ?? null,
      outcome: input.decision.outcome,
      body: input.decision.body,
      createdByRunId: input.actor.runId ?? null,
    });
  }

  async function buildBranchMergePreview(parentIssueId: string, branchIssueId: string): Promise<IssueBranchMergePreview> {
    const parentIssue = await getIssueOrThrow(parentIssueId);
    const branchIssue = await getIssueOrThrow(branchIssueId);
    if (branchIssue.parentId !== parentIssue.id) {
      throw unprocessable("Branch issue does not belong to this parent issue");
    }
    const branchContinuityState = await recomputeIssueContinuityState(branchIssue.id);
    const branchReturnDoc = await docsSvc.getIssueDocumentByKey(branchIssue.id, "branch-return");
    const parsedBranchReturn = branchReturnDoc?.body ? parseIssueBranchReturnMarkdown(branchReturnDoc.body) : null;
    const canMerge = branchContinuityState.branchStatus === "returned" && parsedBranchReturn != null;
    const blockedReason =
      parsedBranchReturn == null
        ? "Branch return requires a valid typed branch-return document."
        : branchContinuityState.branchStatus !== "returned"
          ? `Branch status must be returned before merge preview (current: ${branchContinuityState.branchStatus}).`
          : null;
    const proposedUpdates = await Promise.all((parsedBranchReturn?.document.proposedParentUpdates ?? []).map(async (update) => {
      const existingParentDoc = await docsSvc.getIssueDocumentByKey(parentIssue.id, update.documentKey);
      return {
        documentKey: update.documentKey,
        action: update.action,
        summary: update.summary,
        content: update.content,
        title: update.title ?? null,
        existingParentRevisionId: existingParentDoc?.latestRevisionId ?? null,
      };
    }));
    return issueBranchMergePreviewSchema.parse({
      branchIssueId: branchIssue.id,
      parentIssueId: parentIssue.id,
      canMerge,
      blockedReason,
      branchStatus: branchContinuityState.branchStatus,
      proposedUpdates,
      mergeChecklist: parsedBranchReturn?.document.mergeChecklist ?? [],
      unresolvedRisks: parsedBranchReturn?.document.unresolvedRisks ?? [],
      openQuestions: parsedBranchReturn?.document.openQuestions ?? [],
      evidence: parsedBranchReturn?.document.evidence ?? [],
      returnedArtifacts: parsedBranchReturn?.document.returnedArtifacts ?? [],
    });
  }

  async function mergeBranchInternal(
    parentIssueId: string,
    branchIssueId: string,
    input: { selectedDocumentKeys?: string[] } = {},
    actor: { agentId?: string | null; userId?: string | null; runId?: string | null } = {},
  ) {
    const parsed = mergeIssueContinuityBranchSchema.parse(input);
    const parentIssue = await getIssueOrThrow(parentIssueId);
    const preview = await buildBranchMergePreview(parentIssueId, branchIssueId);
    if (!preview.canMerge) {
      throw unprocessable(preview.blockedReason ?? "Branch cannot be merged yet");
    }
    const selectedDocumentKeys =
      parsed.selectedDocumentKeys.length > 0
        ? new Set(parsed.selectedDocumentKeys)
        : new Set(preview.proposedUpdates.map((update) => update.documentKey));
    const appliedDocumentKeys: string[] = [];
    const deferredDocumentKeys: string[] = [];

    for (const update of preview.proposedUpdates) {
      if (!selectedDocumentKeys.has(update.documentKey)) {
        deferredDocumentKeys.push(update.documentKey);
        continue;
      }
      const existingParentDoc = await docsSvc.getIssueDocumentByKey(parentIssue.id, update.documentKey);
      const nextBody = update.action === "append"
        ? [existingParentDoc?.body?.trim(), update.content.trim()].filter(Boolean).join("\n\n")
        : update.content;
      await upsertScaffoldedIssueDocument({
        issueId: parentIssue.id,
        key: update.documentKey,
        body: nextBody,
        title: update.title ?? existingParentDoc?.title ?? null,
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.userId ?? null,
        createdByRunId: actor.runId ?? null,
      });
      appliedDocumentKeys.push(update.documentKey);
    }

    await appendProgressCheckpoint(parentIssue.id, {
      summary: `Merged branch ${branchIssueId}`,
      currentState: appliedDocumentKeys.length > 0
        ? `Accepted branch updates into ${appliedDocumentKeys.join(", ")}.`
        : "Reviewed branch return and deferred all proposed parent updates.",
      nextAction: deferredDocumentKeys.length > 0
        ? `Resolve deferred updates for ${deferredDocumentKeys.join(", ")}.`
        : "Continue parent execution with the merged branch output.",
      completed: [`Reviewed branch return ${branchIssueId}`],
      evidence: [branchIssueId, ...preview.evidence],
      openQuestions: preview.openQuestions,
    }, actor);

    await recomputeIssueContinuityState(branchIssueId, { forceBranchStatus: "merged" });
    const continuityState = await recomputeIssueContinuityState(parentIssue.id);
    const continuityBundle = await buildContinuityBundle(parentIssue.id);
    return {
      branchIssueId,
      appliedDocumentKeys,
      deferredDocumentKeys,
      continuityState,
      continuityBundle,
    };
  }

  function remediationAction(input: {
    id:
      | "prepare_execution"
      | "request_plan_approval"
      | "resubmit_plan_approval"
      | "progress_checkpoint"
      | "handoff_repair"
      | "handoff_cancel"
      | "review_resubmit"
      | "branch_merge";
    label: string;
    description: string;
    actor: "continuity_owner" | "active_gate_participant" | "branch_owner" | "board";
    eligible: boolean;
    blockedReason?: string | null;
    targetIssueIds?: string[];
  }) {
    return {
      id: input.id,
      label: input.label,
      description: input.description,
      actor: input.actor,
      eligible: input.eligible,
      blockedReason: input.blockedReason ?? null,
      targetIssueIds: input.targetIssueIds,
    };
  }

  function buildContinuityRemediation(input: {
    issue: ContinuityIssueRecord;
    continuityState: IssueContinuityState;
    activeGateParticipant: { type: "agent" | "user"; agentId?: string | null; userId?: string | null } | null;
    actor?: { agentId?: string | null; userId?: string | null; isBoard?: boolean } | null;
  }): IssueContinuityRemediation {
    const actor = input.actor ?? null;
    const ownerEligible = Boolean(actor?.isBoard || (actor?.agentId && actor.agentId === input.issue.assigneeAgentId) || (actor?.userId && actor.userId === input.issue.assigneeUserId));
    const gateEligible =
      Boolean(actor?.isBoard)
      || (
        input.activeGateParticipant?.type === "agent"
          ? input.activeGateParticipant.agentId != null && input.activeGateParticipant.agentId === actor?.agentId
          : input.activeGateParticipant?.userId != null && input.activeGateParticipant.userId === actor?.userId
      );

    const suggestedActions: IssueContinuityRemediationAction[] = [];
    const blockedActions: IssueContinuityRemediationAction[] = [];
    const push = (action: ReturnType<typeof remediationAction>) => {
      if (action.eligible) suggestedActions.push(action);
      else blockedActions.push(action);
    };

    if (input.continuityState.missingDocumentKeys.length > 0) {
      push(remediationAction({
        id: "prepare_execution",
        label: "Prepare execution",
        description: `Scaffold missing continuity docs: ${input.continuityState.missingDocumentKeys.join(", ")}.`,
        actor: "continuity_owner",
        eligible: ownerEligible,
        blockedReason: ownerEligible ? null : "Only the continuity owner or board can prepare execution.",
      }));
    }

    if (
      input.continuityState.missingDocumentKeys.length === 0 &&
      input.continuityState.planApproval.requiresApproval
    ) {
      if (input.continuityState.planApproval.status === "revision_requested") {
        push(remediationAction({
          id: "resubmit_plan_approval",
          label: "Revise plan and resubmit",
          description: "Update the current plan revision, then resubmit it for board approval.",
          actor: "continuity_owner",
          eligible: ownerEligible,
          blockedReason: ownerEligible ? null : "Only the continuity owner or board can resubmit plan approval.",
        }));
      } else if (
        input.continuityState.planApproval.status !== "pending" &&
        !input.continuityState.planApproval.currentRevisionApproved
      ) {
        push(remediationAction({
          id: "request_plan_approval",
          label: "Request plan approval",
          description: "Create a board approval request for the current plan revision before execution begins.",
          actor: "continuity_owner",
          eligible: ownerEligible,
          blockedReason: ownerEligible ? null : "Only the continuity owner or board can request plan approval.",
        }));
      }
    }

    if (input.continuityState.health === "stale_progress") {
      push(remediationAction({
        id: "progress_checkpoint",
        label: "Add progress checkpoint",
        description: "Append a new checkpoint and refresh the current snapshot.",
        actor: "continuity_owner",
        eligible: ownerEligible,
        blockedReason: ownerEligible ? null : "Only the continuity owner or board can refresh stale progress.",
      }));
    }

    if (input.continuityState.health === "invalid_handoff" || input.continuityState.status === "handoff_pending") {
      push(remediationAction({
        id: "handoff_repair",
        label: "Repair handoff",
        description: "Rewrite the pending handoff artifact so continuity can resume safely.",
        actor: "continuity_owner",
        eligible: ownerEligible,
        blockedReason: ownerEligible ? null : "Only the continuity owner or board can repair a pending handoff.",
      }));
      push(remediationAction({
        id: "handoff_cancel",
        label: "Cancel pending handoff",
        description: "Explicitly clear the pending handoff without changing ownership.",
        actor: "continuity_owner",
        eligible: ownerEligible,
        blockedReason: ownerEligible ? null : "Only the continuity owner or board can cancel a pending handoff.",
      }));
    }

    if (input.continuityState.openReviewFindingsRevisionId) {
      push(remediationAction({
        id: "review_resubmit",
        label: "Address findings and resubmit",
        description: "Mark the active findings addressed and reopen the same review gate.",
        actor: "continuity_owner",
        eligible: ownerEligible,
        blockedReason: ownerEligible ? null : "Only the continuity owner or board can resubmit after findings.",
      }));
    }

    if (input.continuityState.returnedBranchIssueIds?.length) {
      push(remediationAction({
        id: "branch_merge",
        label: "Review returned branches",
        description: "Preview returned branch artifacts and explicitly choose which parent updates to merge.",
        actor: "continuity_owner",
        eligible: ownerEligible,
        blockedReason: ownerEligible ? null : "Only the parent continuity owner or board can merge branch returns.",
        targetIssueIds: input.continuityState.returnedBranchIssueIds,
      }));
    }

    if (input.activeGateParticipant && !gateEligible) {
      push(remediationAction({
        id: "review_resubmit",
        label: "Review gate is active",
        description: "This issue is waiting on the active reviewer or approver.",
        actor: "active_gate_participant",
        eligible: gateEligible,
        blockedReason: "Only the active gate participant can return or approve this stage.",
      }));
    }

    return issueContinuityRemediationSchema.parse({ suggestedActions, blockedActions });
  }

  function buildIssuePlanApprovalPayload(input: {
    issue: ContinuityIssueRecord;
    currentPlanRevisionId: string;
    currentSpecRevisionId: string | null;
    currentTestPlanRevisionId: string | null;
  }): IssuePlanApprovalPayload {
    const issueLabel = input.issue.identifier ?? input.issue.id;
    return {
      kind: "issue_plan_approval",
      title: `Approve plan for ${issueLabel}`,
      summary: `Review the current plan revision for ${issueLabel} before execution begins.`,
      issueId: input.issue.id,
      issueTitle: input.issue.title,
      planRevisionId: input.currentPlanRevisionId,
      decisionTier: "board",
      recommendedAction: "Approve the current plan revision and allow execution to begin.",
      nextActionOnApproval: `Continue ${issueLabel} from planning into execution against the approved plan revision.`,
      ...(input.issue.identifier ? { identifier: input.issue.identifier } : {}),
      ...(input.currentSpecRevisionId ? { specRevisionId: input.currentSpecRevisionId } : {}),
      ...(input.currentTestPlanRevisionId ? { testPlanRevisionId: input.currentTestPlanRevisionId } : {}),
    };
  }

  async function requestPlanApprovalForIssue(
    issueId: string,
    actor: { agentId?: string | null; userId?: string | null } = {},
  ): Promise<PlanApprovalRequestResult> {
    const material = await getContinuityMaterial(issueId);
    const currentState = await recomputeIssueContinuityState(issueId);
    if (hasPlanningStageEnded(material.issue)) {
      throw unprocessable("Plan approval is only available before execution begins");
    }
    if (currentState.branchRole === "branch") {
      throw unprocessable("Branch issues do not request a fresh plan approval");
    }
    if (currentState.tier !== "normal") {
      throw unprocessable("Plan approval only applies to normal planning issues");
    }
    if (currentState.missingDocumentKeys.length > 0) {
      throw unprocessable("Plan approval requires all required planning docs");
    }

    const currentPlanRevisionId = material.issueDocsByKey.get("plan")?.latestRevisionId ?? null;
    if (!currentPlanRevisionId) {
      throw unprocessable("Plan approval requires a current plan document revision");
    }
    const currentSpecRevisionId = material.issueDocsByKey.get("spec")?.latestRevisionId ?? null;
    const currentTestPlanRevisionId = material.issueDocsByKey.get("test-plan")?.latestRevisionId ?? null;
    const planApprovalState = buildIssuePlanApprovalState({
      linkedApprovals: material.linkedApprovals,
      currentPlanRevisionId,
      specRevisionId: currentSpecRevisionId,
      testPlanRevisionId: currentTestPlanRevisionId,
      requirePlanApproval: true,
    });
    const payload = buildIssuePlanApprovalPayload({
      issue: material.issue,
      currentPlanRevisionId,
      currentSpecRevisionId,
      currentTestPlanRevisionId,
    });

    let approvalId = planApprovalState.latestPlanApproval?.approval.id ?? null;
    let approvalStatus = planApprovalState.latestPlanApproval?.approval.status ?? null;

    if (planApprovalState.summary.currentRevisionApproved && approvalId) {
      const continuityState = await recomputeIssueContinuityState(issueId);
      const continuityBundle = await buildContinuityBundle(issueId);
      return { approvalId, approvalStatus, continuityState, continuityBundle };
    }

    if (
      planApprovalState.latestPlanApproval &&
      planApprovalState.latestPlanApproval.approval.status === "revision_requested"
    ) {
      const resubmitted = await approvalsSvc.resubmit(
        planApprovalState.latestPlanApproval.approval.id,
        payload as unknown as Record<string, unknown>,
      );
      approvalId = resubmitted.id;
      approvalStatus = resubmitted.status;
    } else if (
      planApprovalState.latestPlanApproval &&
      planApprovalState.latestPlanApproval.payload.planRevisionId === currentPlanRevisionId &&
      planApprovalState.latestPlanApproval.approval.status === "pending"
    ) {
      approvalId = planApprovalState.latestPlanApproval.approval.id;
      approvalStatus = planApprovalState.latestPlanApproval.approval.status;
    } else {
      const approval = await approvalsSvc.create(material.issue.companyId, {
        type: "request_board_approval",
        requestedByAgentId: actor.agentId ?? null,
        requestedByUserId: actor.userId ?? null,
        status: "pending",
        payload: payload as unknown as Record<string, unknown>,
        decisionNote: null,
        decidedByUserId: null,
        decidedAt: null,
        updatedAt: new Date(),
      });
      approvalId = approval.id;
      approvalStatus = approval.status;
      await issueApprovalsSvc.link(issueId, approval.id, {
        agentId: actor.agentId ?? null,
        userId: actor.userId ?? null,
      });
    }

    const continuityState = await recomputeIssueContinuityState(issueId);
    const continuityBundle = await buildContinuityBundle(issueId);
    return { approvalId, approvalStatus, continuityState, continuityBundle };
  }

  async function grantDocFreezeExceptions(
    issueId: string,
    input: { documentKeys: string[]; decisionNote: string; reason: "executive_thaw" },
    actor: { agentId?: string | null; userId?: string | null } = {},
  ) {
    const now = new Date().toISOString();
    return withLockedIssueRow(issueId, async (lockedDb) => {
      const material = await getContinuityMaterial(issueId, lockedDb);
      const existing = issueContinuityStateSchema.safeParse(material.issue.continuityState ?? null).success
        ? issueContinuityStateSchema.parse(material.issue.continuityState)
        : null;
      const currentExceptions: IssueDocFreezeException[] = existing?.docFreezeExceptions ?? [];
      const currentKeys = new Set(currentExceptions.map((exception) => exception.key));
      const newExceptions: IssueDocFreezeException[] = input.documentKeys
        .filter((key) => !currentKeys.has(key))
        .map((key) => ({
          key,
          reason: input.reason,
          decisionNote: input.decisionNote,
          grantedAt: now,
          grantedByAgentId: actor.agentId ?? null,
          grantedByUserId: actor.userId ?? null,
        }));
      const nextExceptions = [...currentExceptions, ...newExceptions];
      const baseState = computeContinuityState({
        issue: material.issue,
        issueDocsByKey: material.issueDocsByKey,
        linkedApprovals: material.linkedApprovals,
        childRows: material.childRows,
        decisionQuestions: material.decisionQuestions,
      });
      const nextState = issueContinuityStateSchema.parse({
        ...baseState,
        docFreezeExceptions: nextExceptions,
      });
      await persistContinuityState(issueId, nextState, lockedDb);
      return { continuityState: nextState, grantedKeys: newExceptions.map((exception) => exception.key) };
    });
  }

  async function consumeDocFreezeException(issueId: string, key: string) {
    return withLockedIssueRow(issueId, async (lockedDb) => {
      const material = await getContinuityMaterial(issueId, lockedDb);
      const existing = issueContinuityStateSchema.safeParse(material.issue.continuityState ?? null).success
        ? issueContinuityStateSchema.parse(material.issue.continuityState)
        : null;
      const currentExceptions = existing?.docFreezeExceptions ?? [];
      const matched = currentExceptions.find((exception) => exception.key === key) ?? null;
      if (!matched) return null;
      const remaining = currentExceptions.filter((exception) => exception.key !== key);
      const baseState = computeContinuityState({
        issue: material.issue,
        issueDocsByKey: material.issueDocsByKey,
        linkedApprovals: material.linkedApprovals,
        childRows: material.childRows,
        decisionQuestions: material.decisionQuestions,
      });
      const nextState = issueContinuityStateSchema.parse({
        ...baseState,
        docFreezeExceptions: remaining,
      });
      await persistContinuityState(issueId, nextState, lockedDb);
      return matched;
    });
  }

  return {
    recomputeIssueContinuityState,

    getIssueContinuity: async (
      issueId: string,
      actor?: { agentId?: string | null; userId?: string | null; isBoard?: boolean } | null,
    ) => {
      const issue = await getIssueOrThrow(issueId);
      const continuityState = await recomputeIssueContinuityState(issueId);
      const continuityBundle = await buildContinuityBundle(issueId);
      const activeGateParticipant = parseIssueExecutionState(issue.executionState ?? null)?.currentParticipant ?? null;
      return {
        issueId: issue.id,
        continuityState,
        continuityBundle,
        continuityOwner: {
          assigneeAgentId: issue.assigneeAgentId,
          assigneeUserId: issue.assigneeUserId ?? null,
        },
        activeGateParticipant,
        remediation: buildContinuityRemediation({
          issue,
          continuityState,
          activeGateParticipant,
          actor,
        }),
      };
    },

    buildIssueContinuityBundle: buildContinuityBundle,

    prepare: async (
      issueId: string,
      input: PrepareIssueContinuity,
      actor: { agentId?: string | null; userId?: string | null; runId?: string | null } = {},
    ) => {
      const parsed = prepareIssueContinuitySchema.parse(input);
      const issue = await getIssueOrThrow(issueId);
      const initialState = await recomputeIssueContinuityState(issueId, { tier: parsed.tier ?? null });
      const overrides = (parsed.docs ?? {}) as Record<string, { title?: string | null; body: string } | undefined>;
      if (overrides.progress && !parseIssueProgressMarkdown(overrides.progress.body)) {
        throw unprocessable("docs.progress must include valid paperclip/issue-progress.v1 frontmatter");
      }
      if (overrides.handoff && !parseIssueHandoffMarkdown(overrides.handoff.body)) {
        throw unprocessable("docs.handoff must include valid paperclip/issue-handoff.v1 frontmatter");
      }
      const scaffoldedKeys: string[] = [];
      const overriddenKeys: string[] = [];

      const seedKeys = new Set<string>([
        ...initialState.missingDocumentKeys,
        ...Object.keys(overrides),
      ]);
      for (const key of seedKeys) {
        const override = overrides[key];
        const body = override
          ? override.body
          : buildIssueDocumentTemplate(key, {
              title: issue.title,
              description: issue.description ?? null,
              tier: parsed.tier ?? initialState.tier,
            });
        if (!body) continue;
        await upsertScaffoldedIssueDocument({
          issueId,
          key,
          body,
          title: override?.title ?? null,
          createdByAgentId: actor.agentId ?? null,
          createdByUserId: actor.userId ?? null,
          createdByRunId: actor.runId ?? null,
        });
        if (override) {
          overriddenKeys.push(key);
        } else {
          scaffoldedKeys.push(key);
        }
      }
      let continuityState = await recomputeIssueContinuityState(issueId, {
        tier: parsed.tier ?? initialState.tier,
        lastPreparedAt: new Date().toISOString(),
        forceSpecState: isContinuityExecuting(issue) ? "frozen" : null,
      });
      let continuityBundle: IssueContinuityBundle = await buildContinuityBundle(issueId);
      let planApprovalRequest: { approvalId: string | null; approvalStatus: string | null } | null = null;
      if (
        continuityState.health === "healthy" &&
        continuityState.planApproval.requiresApproval &&
        continuityState.planApproval.status !== "pending"
      ) {
        const approvalResult = await requestPlanApprovalForIssue(issueId, {
          agentId: actor.agentId ?? null,
          userId: actor.userId ?? null,
        });
        continuityState = approvalResult.continuityState;
        continuityBundle = approvalResult.continuityBundle;
        planApprovalRequest = {
          approvalId: approvalResult.approvalId,
          approvalStatus: approvalResult.approvalStatus,
        };
      }
      return {
        continuityState,
        continuityBundle,
        scaffoldedKeys,
        overriddenKeys,
        planApprovalRequest,
      };
    },

    requestPlanApproval: requestPlanApprovalForIssue,

    handoff: async (
      issueId: string,
      input: HandoffIssueContinuity,
      actor: { agentId?: string | null; userId?: string | null; runId?: string | null } = {},
    ) => {
      const parsed = handoffIssueContinuitySchema.parse(input);
      const issue = await getIssueOrThrow(issueId);
      const transferTarget =
        parsed.assigneeAgentId ? `agent:${parsed.assigneeAgentId}` : parsed.assigneeUserId ? `user:${parsed.assigneeUserId}` : null;
      if (!transferTarget) {
        throw unprocessable("Handoff requires a transfer target");
      }
      if (transferTarget === currentAssigneeTarget(issue)) {
        throw conflict("Handoff target must differ from the current continuity owner");
      }
      const handoffBody = buildStructuredFrontmatter(
        ISSUE_HANDOFF_DOCUMENT_KIND,
        {
          reasonCode: parsed.reasonCode,
          timestamp: new Date().toISOString(),
          transferTarget,
          exactNextAction: parsed.exactNextAction,
          unresolvedBranches: parsed.unresolvedBranches ?? [],
          openQuestions: parsed.openQuestions ?? [],
          evidence: parsed.evidence ?? [],
        },
        "Execution handoff prepared by the current continuity owner.",
      );
      await upsertScaffoldedIssueDocument({
        issueId,
        key: "handoff",
        body: handoffBody,
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.userId ?? null,
        createdByRunId: actor.runId ?? null,
      });
      await persistContinuityState(issueId, issueContinuityStateSchema.parse({
        ...(await recomputeIssueContinuityState(issueId, { forceStatus: "handoff_pending" })),
        status: "handoff_pending",
      }));
      const updated = await issuesSvc.update(issueId, {
        assigneeAgentId: parsed.assigneeAgentId ?? null,
        assigneeUserId: parsed.assigneeUserId ?? null,
        actorAgentId: actor.agentId ?? null,
        actorUserId: actor.userId ?? null,
      });
      if (!updated) throw notFound("Issue not found");
      const continuityState = await recomputeIssueContinuityState(issueId, { forceStatus: "handoff_pending" });
      const continuityBundle = await buildContinuityBundle(issueId);
      return { issue: updated, continuityState, continuityBundle };
    },

    progressCheckpoint: async (
      issueId: string,
      input: ProgressCheckpointIssueContinuity,
      actor: { agentId?: string | null; userId?: string | null; runId?: string | null } = {},
    ) => {
      await getIssueOrThrow(issueId);
      await appendProgressCheckpoint(issueId, input, actor);
      const continuityState = await recomputeIssueContinuityState(issueId);
      const continuityBundle = await buildContinuityBundle(issueId);
      return { continuityState, continuityBundle };
    },

    reviewReturn: async (
      issueId: string,
      input: ReviewReturnIssueContinuity,
      actor: { agentId?: string | null; userId?: string | null; runId?: string | null } = {},
    ) => {
      const parsed = reviewReturnIssueContinuitySchema.parse(input);
      const issue = await getIssueOrThrow(issueId);
      const executionState = parseIssueExecutionState(issue.executionState ?? null);
      const gateParticipant = executionState?.currentParticipant;
      if (!gateParticipant || !executionState?.currentStageType) {
        throw unprocessable("Review return requires an active review or approval gate");
      }

      const reviewer =
        actor.agentId != null ? `agent:${actor.agentId}` : actor.userId != null ? `user:${actor.userId}` : "unknown";
      const gateParticipantKey =
        gateParticipant.type === "agent"
          ? `agent:${gateParticipant.agentId}`
          : `user:${gateParticipant.userId}`;
      const findingsBody = buildStructuredFrontmatter(
        ISSUE_REVIEW_FINDINGS_DOCUMENT_KIND,
        {
          reviewer,
          gateParticipant: gateParticipantKey,
          reviewStage: executionState.currentStageType,
          decisionContext: parsed.decisionContext ?? executionState.currentStageId ?? null,
          outcome: parsed.outcome,
          resolutionState: "open",
          ownerNextAction: parsed.ownerNextAction,
          findings: parsed.findings.map((finding, index) => ({
            ...finding,
            findingId: buildReviewFindingId(issue.id, executionState.currentStageType ?? "review", finding, index),
          })),
        },
        "Structured reviewer findings returned to the continuity owner.",
      );
      await upsertScaffoldedIssueDocument({
        issueId,
        key: "review-findings",
        body: findingsBody,
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.userId ?? null,
        createdByRunId: actor.runId ?? null,
      });

      const transition = applyIssueExecutionPolicyTransition({
        issue,
        policy: normalizeIssueExecutionPolicy(issue.executionPolicy),
        requestedStatus: "blocked",
        requestedAssigneePatch: {},
        actor: {
          agentId: actor.agentId ?? null,
          userId: actor.userId ?? null,
        },
        commentBody: parsed.ownerNextAction,
      });
      const updated = await issuesSvc.update(issueId, {
        ...transition.patch,
        actorAgentId: actor.agentId ?? null,
        actorUserId: actor.userId ?? null,
      });
      if (!updated) throw notFound("Issue not found");
      if (transition.decision) {
        await recordExecutionDecision({
          issueId,
          decision: transition.decision,
          actor,
        });
      }
      const continuityState = await recomputeIssueContinuityState(issueId);
      const continuityBundle = await buildContinuityBundle(issueId);
      return { issue: updated, continuityState, continuityBundle };
    },

    reviewResubmit: async (
      issueId: string,
      input: ReviewResubmitIssueContinuity,
      actor: { agentId?: string | null; userId?: string | null; runId?: string | null } = {},
    ) => {
      const parsed = reviewResubmitIssueContinuitySchema.parse(input);
      const issue = await getIssueOrThrow(issueId);
      const findingsDocument = await docsSvc.getIssueDocumentByKey(issueId, "review-findings");
      const parsedFindings = findingsDocument?.body ? parseIssueReviewFindingsMarkdown(findingsDocument.body) : null;
      if (!findingsDocument || !parsedFindings || parsedFindings.document.resolutionState !== "open") {
        throw unprocessable("Review resubmit requires open typed review findings");
      }

      if (parsed.progressCheckpoint) {
        await appendProgressCheckpoint(issueId, parsed.progressCheckpoint, actor);
      }

      const findingsBody = buildStructuredFrontmatter(
        ISSUE_REVIEW_FINDINGS_DOCUMENT_KIND,
        {
          ...parsedFindings.document,
          resolutionState: "addressed",
          ownerResponseNote: parsed.responseNote ?? null,
          addressedAt: new Date().toISOString(),
        },
        parsedFindings.body || "Reviewer findings addressed by the continuity owner.",
      );
      await upsertScaffoldedIssueDocument({
        issueId,
        key: "review-findings",
        body: findingsBody,
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.userId ?? null,
        createdByRunId: actor.runId ?? null,
      });

      const transition = applyIssueExecutionPolicyTransition({
        issue,
        policy: normalizeIssueExecutionPolicy(issue.executionPolicy),
        requestedStatus: "in_review",
        requestedAssigneePatch: {},
        actor: {
          agentId: actor.agentId ?? null,
          userId: actor.userId ?? null,
        },
      });
      const updated = await issuesSvc.update(issueId, {
        ...transition.patch,
        actorAgentId: actor.agentId ?? null,
        actorUserId: actor.userId ?? null,
      });
      if (!updated) throw notFound("Issue not found");
      const continuityState = await recomputeIssueContinuityState(issueId);
      const continuityBundle = await buildContinuityBundle(issueId);
      return { issue: updated, continuityState, continuityBundle };
    },

    promoteReviewFindingSkill: async (
      issueId: string,
      findingId: string,
      input: PromoteIssueReviewFindingSkill,
      actor: { agentId?: string | null; userId?: string | null; runId?: string | null } = {},
    ) => {
      const parsed = promoteIssueReviewFindingSkillSchema.parse(input);
      const issue = await getIssueOrThrow(issueId);
      const findingsDocument = await docsSvc.getIssueDocumentByKey(issueId, "review-findings");
      const parsedFindings = findingsDocument?.body ? parseIssueReviewFindingsMarkdown(findingsDocument.body) : null;
      if (!findingsDocument || !parsedFindings || parsedFindings.document.resolutionState !== "open") {
        throw unprocessable("Skill promotion requires open typed review findings");
      }

      const findingIndex = parsedFindings.document.findings.findIndex((finding) => finding.findingId === findingId);
      if (findingIndex < 0) {
        throw notFound("Review finding not found");
      }
      const finding = parsedFindings.document.findings[findingIndex]!;

      let targetSkill = parsed.companySkillId
        ? await companySkillsSvc.getById(issue.companyId, parsed.companySkillId)
        : null;
      if (targetSkill && targetSkill.companyId !== issue.companyId) {
        throw notFound("Skill not found");
      }
      if (!targetSkill && parsed.sharedSkillId) {
        targetSkill = await db
          .select()
          .from(companySkills)
          .where(and(eq(companySkills.companyId, issue.companyId), eq(companySkills.sharedSkillId, parsed.sharedSkillId)))
          .then((rows) => rows[0] ? companySkillsSvc.getById(issue.companyId, rows[0].id) : null);
      }
      if (!targetSkill) {
        throw notFound("Skill not found");
      }

      const failureFingerprint = createHash("sha256")
        .update(JSON.stringify([issue.id, findingId, targetSkill.key]))
        .digest("hex");
      const assigneeAgentId = (await agentSvc.list(issue.companyId))
        .filter((candidate) => candidate.status !== "terminated" && candidate.archetypeKey === "qa_evals_continuity_owner")
        .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())[0]?.id
        ?? issue.assigneeAgentId
        ?? null;

      const existingIssueId = finding.skillPromotion?.hardeningIssueId ?? null;
      let hardeningIssue: ContinuityIssueRecord | null = existingIssueId ? await issuesSvc.getById(existingIssueId) : null;
      if (!hardeningIssue) {
        const existingHardeningId = await db
          .select({ id: issues.id })
          .from(issues)
          .where(
            and(
              eq(issues.companyId, issue.companyId),
              eq(issues.originKind, SKILL_HARDENING_FINDING_ORIGIN_KIND),
              eq(issues.originId, targetSkill.key),
              eq(issues.originFingerprint, failureFingerprint),
            ),
          )
          .orderBy(desc(issues.updatedAt))
          .then((rows) => rows[0]?.id ?? null);
        hardeningIssue = existingHardeningId ? await getIssueOrThrow(existingHardeningId) : null;
      }

      const title = `Skill hardening: ${targetSkill.name}`;
      const reproductionSummary = parsed.reproductionSummary ?? finding.detail;
      const scaffolds = buildSkillHardeningScaffolds({
        title,
        skillName: targetSkill.name,
        skillKey: targetSkill.key,
        sourceIssueIdentifier: issue.identifier ?? issue.id,
        sourceFindingTitle: finding.title,
        failureFingerprint,
        reproductionSummary,
      });

      if (hardeningIssue) {
        if (["done", "cancelled"].includes(hardeningIssue.status)) {
          await issuesSvc.update(hardeningIssue.id, {
            status: "todo",
            assigneeAgentId,
            actorAgentId: actor.agentId ?? null,
            actorUserId: actor.userId ?? null,
          });
          hardeningIssue = await getIssueOrThrow(hardeningIssue.id);
        }
      } else {
        const created = await issuesSvc.create(issue.companyId, {
          parentId: issue.id,
          projectId: issue.projectId,
          projectWorkspaceId: issue.projectWorkspaceId,
          goalId: issue.goalId,
          title,
          description: reproductionSummary,
          status: "todo",
          priority: finding.severity === "critical" ? "critical" : finding.severity === "high" ? "high" : issue.priority,
          assigneeAgentId,
          assigneeUserId: null,
          inheritExecutionWorkspaceFromIssueId: issue.id,
          originKind: SKILL_HARDENING_FINDING_ORIGIN_KIND,
          originId: targetSkill.key,
          originFingerprint: failureFingerprint,
          createdByAgentId: actor.agentId ?? null,
          createdByUserId: actor.userId ?? null,
        });
        hardeningIssue = await getIssueOrThrow(created.id);
      }

      if (!hardeningIssue) {
        throw conflict("Failed to create or load the skill hardening issue.");
      }

      await upsertScaffoldedIssueDocument({
        issueId: hardeningIssue.id,
        key: "spec",
        body: scaffolds.spec,
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.userId ?? null,
        createdByRunId: actor.runId ?? null,
      });
      await upsertScaffoldedIssueDocument({
        issueId: hardeningIssue.id,
        key: "plan",
        body: scaffolds.plan,
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.userId ?? null,
        createdByRunId: actor.runId ?? null,
      });
      await upsertScaffoldedIssueDocument({
        issueId: hardeningIssue.id,
        key: "progress",
        body: scaffolds.progress,
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.userId ?? null,
        createdByRunId: actor.runId ?? null,
      });
      await upsertScaffoldedIssueDocument({
        issueId: hardeningIssue.id,
        key: "test-plan",
        body: scaffolds.testPlan,
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.userId ?? null,
        createdByRunId: actor.runId ?? null,
      });

      const linkedProposal = targetSkill.sharedSkillId
        ? await db
          .select({
            id: sharedSkillProposals.id,
            status: sharedSkillProposals.status,
          })
          .from(sharedSkillProposals)
          .where(and(eq(sharedSkillProposals.sharedSkillId, targetSkill.sharedSkillId), eq(sharedSkillProposals.companyId, issue.companyId)))
          .orderBy(desc(sharedSkillProposals.createdAt))
          .then((rows) => rows[0] ?? null)
        : null;

      const nextFindings = parsedFindings.document.findings.map((entry, index) =>
        index !== findingIndex
          ? entry
          : {
            ...entry,
            skillPromotion: {
              hardeningIssueId: hardeningIssue.id,
              hardeningIssueIdentifier: hardeningIssue.identifier ?? null,
              companySkillId: targetSkill.id,
              companySkillKey: targetSkill.key,
              sharedSkillId: targetSkill.sharedSkillId ?? null,
              sharedSkillProposalId: linkedProposal?.id ?? null,
              sharedSkillProposalStatus: linkedProposal?.status ?? null,
              sourceRunId: parsed.sourceRunId ?? actor.runId ?? null,
              failureFingerprint,
              promotedAt: new Date().toISOString(),
              promotedBy: actorLabel(actor),
            },
          },
      );
      const findingsBody = buildStructuredFrontmatter(
        ISSUE_REVIEW_FINDINGS_DOCUMENT_KIND,
        {
          ...parsedFindings.document,
          findings: nextFindings,
        },
        parsedFindings.body || "Structured reviewer findings returned to the continuity owner.",
      );
      await upsertScaffoldedIssueDocument({
        issueId,
        key: "review-findings",
        body: findingsBody,
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.userId ?? null,
        createdByRunId: actor.runId ?? null,
      });

      const continuityState = await recomputeIssueContinuityState(issueId);
      const continuityBundle = await buildContinuityBundle(issueId);
      return {
        hardeningIssue,
        continuityState,
        continuityBundle,
      };
    },

    handoffRepair: async (
      issueId: string,
      input: HandoffRepairIssueContinuity,
      actor: { agentId?: string | null; userId?: string | null; runId?: string | null } = {},
    ) => {
      const parsed = handoffRepairIssueContinuitySchema.parse(input);
      const issue = await getIssueOrThrow(issueId);
      const transferTarget = currentAssigneeTarget(issue);
      if (!transferTarget) {
        throw unprocessable("Handoff repair requires a current continuity owner");
      }
      const handoffBody = buildStructuredFrontmatter(
        ISSUE_HANDOFF_DOCUMENT_KIND,
        {
          reasonCode: parsed.reasonCode,
          timestamp: new Date().toISOString(),
          transferTarget,
          exactNextAction: parsed.exactNextAction,
          unresolvedBranches: parsed.unresolvedBranches ?? [],
          openQuestions: parsed.openQuestions ?? [],
          evidence: parsed.evidence ?? [],
        },
        "Pending handoff repaired in place.",
      );
      await upsertScaffoldedIssueDocument({
        issueId,
        key: "handoff",
        body: handoffBody,
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.userId ?? null,
        createdByRunId: actor.runId ?? null,
      });
      const continuityState = await recomputeIssueContinuityState(issueId, { forceStatus: "handoff_pending" });
      const continuityBundle = await buildContinuityBundle(issueId);
      return { continuityState, continuityBundle };
    },

    handoffCancel: async (
      issueId: string,
      input: HandoffCancelIssueContinuity,
      _actor: { agentId?: string | null; userId?: string | null; runId?: string | null } = {},
    ) => {
      handoffCancelIssueContinuitySchema.parse(input);
      const issue = await getIssueOrThrow(issueId);
      const nextStatus =
        isContinuityExecuting(issue)
          ? "active"
          : existingStateFromIssue(issue)?.lastPreparedAt
            ? "ready"
            : "draft";
      const continuityState = await recomputeIssueContinuityState(issueId, { forceStatus: nextStatus });
      const continuityBundle = await buildContinuityBundle(issueId);
      return { continuityState, continuityBundle };
    },

    grantDocFreezeExceptions: async (
      issueId: string,
      input: RequestIssueContinuityDocUnfreeze & { reason?: "executive_thaw" },
      actor: { agentId?: string | null; userId?: string | null } = {},
    ) => {
      const parsed = requestIssueContinuityDocUnfreezeSchema.parse(input);
      const documentKeys = parsed.documentKeys ?? [...["spec", "plan", "test-plan", "handoff"]];
      return grantDocFreezeExceptions(
        issueId,
        {
          documentKeys,
          decisionNote: parsed.decisionNote,
          reason: input.reason ?? "executive_thaw",
        },
        actor,
      );
    },

    consumeDocFreezeException,

    requestSpecThaw: async (
      issueId: string,
      input: RequestIssueSpecThaw,
      actor: { agentId?: string | null; userId?: string | null } = {},
    ) => {
      const parsed = requestIssueSpecThawSchema.parse(input);
      const issue = await getIssueOrThrow(issueId);
      let approvalId = parsed.approvalId ?? null;
      if (!approvalId) {
        const approval = await approvalsSvc.create(issue.companyId, {
          type: "request_board_approval",
          requestedByAgentId: actor.agentId ?? null,
          requestedByUserId: actor.userId ?? null,
          status: "pending",
          payload: {
            kind: "issue_spec_thaw",
            issueId: issue.id,
            identifier: issue.identifier,
            title: issue.title,
            reason: parsed.reason ?? null,
          },
        });
        approvalId = approval.id;
      }
      await issueApprovalsSvc.link(issueId, approvalId, {
        agentId: actor.agentId ?? null,
        userId: actor.userId ?? null,
      });
      const approvals = await issueApprovalsSvc.listApprovalsForIssue(issueId);
      const linkedApproval = approvals.find((approval) => approval.id === approvalId) ?? null;
      const forceSpecState = linkedApproval?.status === "approved" ? "thawed" : "thaw_requested";
      const continuityState = await recomputeIssueContinuityState(issueId, { forceSpecState });
      const continuityBundle = await buildContinuityBundle(issueId);
      return { approvalId, continuityState, continuityBundle };
    },

    returnBranch: async (
      parentIssueId: string,
      branchIssueId: string,
      input: ReturnIssueContinuityBranch,
      actor: { agentId?: string | null; userId?: string | null; runId?: string | null } = {},
    ) => {
      const parsed = returnIssueContinuityBranchSchema.parse(input);
      const parentIssue = await getIssueOrThrow(parentIssueId);
      const branchIssue = await getIssueOrThrow(branchIssueId);
      if (branchIssue.parentId !== parentIssue.id) {
        throw unprocessable("Branch issue does not belong to this parent issue");
      }
      const body = buildStructuredFrontmatter(
        ISSUE_BRANCH_RETURN_DOCUMENT_KIND,
        parsed,
        "Structured branch return prepared for the parent continuity owner.",
      );
      await upsertScaffoldedIssueDocument({
        issueId: branchIssue.id,
        key: "branch-return",
        body,
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.userId ?? null,
        createdByRunId: actor.runId ?? null,
      });
      let updatedBranch = branchIssue;
      if (!["done", "cancelled"].includes(branchIssue.status)) {
        const next = await issuesSvc.update(branchIssue.id, {
          status: "done",
          actorAgentId: actor.agentId ?? null,
          actorUserId: actor.userId ?? null,
        });
        if (next) updatedBranch = next;
      }
      await recomputeIssueContinuityState(branchIssue.id, { forceBranchStatus: "returned" });
      const continuityState = await recomputeIssueContinuityState(parentIssue.id);
      const continuityBundle = await buildContinuityBundle(parentIssue.id);
      return { branchIssue: updatedBranch, continuityState, continuityBundle };
    },

    getBranchMergePreview: async (parentIssueId: string, branchIssueId: string) => {
      return buildBranchMergePreview(parentIssueId, branchIssueId);
    },

    mergeBranch: async (
      parentIssueId: string,
      branchIssueId: string,
      input: { selectedDocumentKeys?: string[] } = {},
      actor: { agentId?: string | null; userId?: string | null; runId?: string | null } = {},
    ) => mergeBranchInternal(parentIssueId, branchIssueId, input, actor),

    mutateBranch: async (
      issueId: string,
      input: ReturnType<typeof createIssueContinuityBranchSchema.parse>,
      actor: { agentId?: string | null; userId?: string | null; runId?: string | null } = {},
    ) => {
      const parsed = createIssueContinuityBranchSchema.parse(input);
      const parentIssue = await getIssueOrThrow(issueId);

      if (parsed.action === "merge") {
        return mergeBranchInternal(parentIssue.id, parsed.branchIssueId, {}, actor);
      }

      const childIssue = await issuesSvc.create(parentIssue.companyId, {
        parentId: parentIssue.id,
        projectId: parentIssue.projectId,
        projectWorkspaceId: parentIssue.projectWorkspaceId,
        goalId: parentIssue.goalId,
        title: parsed.title,
        description: parsed.description ?? null,
        status: "todo",
        priority: parsed.priority ?? parentIssue.priority,
        assigneeAgentId: parsed.assigneeAgentId ?? null,
        assigneeUserId: parsed.assigneeUserId ?? null,
        inheritExecutionWorkspaceFromIssueId: parentIssue.id,
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.userId ?? null,
      });
      const charterBody = buildStructuredFrontmatter(
        ISSUE_BRANCH_CHARTER_KIND,
        {
          purpose: parsed.purpose,
          scope: parsed.scope,
          budget: parsed.budget,
          expectedReturnArtifact: parsed.expectedReturnArtifact,
          mergeCriteria: parsed.mergeCriteria ?? [],
          expiration: parsed.expiration ?? null,
          timeout: parsed.timeout ?? null,
        },
        "Branch exploration charter for bounded sub-work.",
      );
      await upsertScaffoldedIssueDocument({
        issueId: childIssue.id,
        key: ISSUE_BRANCH_CHARTER_DOCUMENT_KEY,
        body: charterBody,
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.userId ?? null,
        createdByRunId: actor.runId ?? null,
      });
      await recomputeIssueContinuityState(childIssue.id, { forceBranchStatus: "open" });
      const continuityState = await recomputeIssueContinuityState(parentIssue.id);
      const continuityBundle = await buildContinuityBundle(parentIssue.id);
      return { branchIssue: childIssue, continuityState, continuityBundle };
    },

    recomputeAll: async (companyId?: string | null) => {
      const baseQuery = db.select({ id: issues.id }).from(issues);
      const rows = companyId ? await baseQuery.where(eq(issues.companyId, companyId)) : await baseQuery;
      for (const row of rows) {
        await recomputeIssueContinuityState(row.id);
      }
      return rows.length;
    },
  };
}
