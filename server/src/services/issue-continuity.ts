import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueExecutionDecisions, issues } from "@paperclipai/db";
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
  issueContinuityBundleSchema,
  issueContinuityRemediationSchema,
  issueContinuityStateSchema,
  mergeIssueContinuityBranchSchema,
  parseIssueBranchReturnMarkdown,
  parseIssueHandoffMarkdown,
  parseIssueProgressMarkdown,
  parseIssueReviewFindingsMarkdown,
  progressCheckpointIssueContinuitySchema,
  prepareIssueContinuitySchema,
  requestIssueSpecThawSchema,
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
  type IssueContinuityRemediationAction,
  type IssueContinuityRemediation,
  type IssueContinuityState,
  type IssueContinuityStatus,
  type IssueContinuityTier,
  type ProgressCheckpointIssueContinuity,
  type PrepareIssueContinuity,
  type RequestIssueSpecThaw,
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
import { documentService } from "./documents.js";
import { issueApprovalService } from "./issue-approvals.js";
import { issueService } from "./issues.js";

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
};

export function issueContinuityService(db: Db) {
  const docsSvc = documentService(db);
  const issuesSvc = issueService(db);
  const issueApprovalsSvc = issueApprovalService(db);
  const approvalsSvc = approvalService(db);

  async function getIssueOrThrow(issueId: string) {
    const issue = await issuesSvc.getById(issueId);
    if (!issue) throw notFound("Issue not found");
    return issue;
  }

  async function getChildBranchRows(issue: ContinuityIssueRecord) {
    return db
      .select({
        id: issues.id,
        status: issues.status,
        continuityState: issues.continuityState,
      })
      .from(issues)
      .where(and(eq(issues.companyId, issue.companyId), eq(issues.parentId, issue.id), isNull(issues.hiddenAt)));
  }

  async function getContinuityMaterial(issueId: string) {
    const issue = await getIssueOrThrow(issueId);
    const [issueDocs, projectContext, projectRunbook, linkedApprovals, childRows] = await Promise.all([
      docsSvc.listIssueDocuments(issue.id),
      issue.projectId ? docsSvc.getProjectDocumentByKey(issue.projectId, "context") : Promise.resolve(null),
      issue.projectId ? docsSvc.getProjectDocumentByKey(issue.projectId, "runbook") : Promise.resolve(null),
      issueApprovalsSvc.listApprovalsForIssue(issue.id),
      getChildBranchRows(issue),
    ]);
    return {
      issue,
      issueDocs,
      issueDocsByKey: new Map(issueDocs.map((doc) => [doc.key, doc])),
      projectContext,
      projectRunbook,
      linkedApprovals,
      childRows,
    };
  }

  function computeContinuityState(input: {
    issue: ContinuityIssueRecord;
    issueDocsByKey: Map<string, ContinuityDocumentRow>;
    linkedApprovals: LinkedApprovalSummary[];
    childRows: Array<{ id: string; status: string; continuityState: Record<string, unknown> | null }>;
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
    const progressAfterHandoff =
      (timestampMs(progressDoc?.updatedAt) ?? 0) > (timestampMs(handoffDoc?.updatedAt) ?? Number.POSITIVE_INFINITY);
    const handoffTargetMatchesOwner =
      !parsedHandoff?.document.transferTarget || parsedHandoff.document.transferTarget === currentAssigneeTarget(input.issue);
    const openReviewFindingsRevisionId =
      parsedReviewFindings && parsedReviewFindings.document.resolutionState === "open"
        ? reviewFindingsDoc?.latestRevisionId ?? null
        : null;

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
    } else if (missingDocumentKeys.length > 0) {
      status = "blocked_missing_docs";
    } else if (existingState?.status === "handoff_pending" && parsedHandoff && handoffTargetMatchesOwner && !progressAfterHandoff) {
      status = "handoff_pending";
    } else if (isContinuityExecuting(input.issue)) {
      status = "active";
    } else if ((input.lastPreparedAt ?? existingState?.lastPreparedAt) && missingDocumentKeys.length === 0) {
      status = "ready";
    } else {
      status = "draft";
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
      lastProgressAt,
      lastHandoffAt,
      lastReviewFindingsAt,
      lastReviewReturnAt,
      lastBranchReturnAt,
      lastPreparedAt: input.lastPreparedAt ?? existingState?.lastPreparedAt ?? null,
      lastBundleHash: existingState?.lastBundleHash ?? null,
    });
  }

  async function persistContinuityState(issueId: string, nextState: IssueContinuityState) {
    await db.update(issues).set({ continuityState: nextState as unknown as Record<string, unknown> }).where(eq(issues.id, issueId));
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
    const material = await getContinuityMaterial(issueId);
    const nextState = computeContinuityState({
      issue: material.issue,
      issueDocsByKey: material.issueDocsByKey,
      linkedApprovals: material.linkedApprovals,
      childRows: material.childRows,
      preparedTier: overrides?.tier ?? null,
      lastPreparedAt: overrides?.lastPreparedAt ?? null,
      forceBranchStatus: overrides?.forceBranchStatus ?? null,
      forceStatus: overrides?.forceStatus ?? null,
      forceSpecState: overrides?.forceSpecState ?? null,
    });
    await persistContinuityState(issueId, nextState);
    return nextState;
  }

  async function buildContinuityBundle(issueId: string) {
    const material = await getContinuityMaterial(issueId);
    let continuityState = computeContinuityState({
      issue: material.issue,
      issueDocsByKey: material.issueDocsByKey,
      linkedApprovals: material.linkedApprovals,
      childRows: material.childRows,
    });

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
      issueDocuments,
      projectDocuments,
      referencedRevisionIds,
    };
    const bundleHash = createHash("sha256")
      .update(JSON.stringify({
        continuityState,
        executionState: bundleInput.executionState,
        issueDocuments,
        projectDocuments,
        referencedRevisionIds,
      }))
      .digest("hex");
    continuityState = issueContinuityStateSchema.parse({
      ...continuityState,
      lastBundleHash: bundleHash,
    });
    if (material.issue.continuityState == null || (material.issue.continuityState as Record<string, unknown>).lastBundleHash !== bundleHash) {
      await persistContinuityState(issueId, continuityState);
    }
    return issueContinuityBundleSchema.parse({
      ...bundleInput,
      bundleHash,
      continuityState,
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
    id: "prepare_execution" | "progress_checkpoint" | "handoff_repair" | "handoff_cancel" | "review_resubmit" | "branch_merge";
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
      for (const key of initialState.missingDocumentKeys) {
        const body = buildIssueDocumentTemplate(key, {
          title: issue.title,
          description: issue.description ?? null,
          tier: parsed.tier ?? initialState.tier,
        });
        if (!body) continue;
        await upsertScaffoldedIssueDocument({
          issueId,
          key,
          body,
          createdByAgentId: actor.agentId ?? null,
          createdByUserId: actor.userId ?? null,
          createdByRunId: actor.runId ?? null,
        });
      }
      const continuityState = await recomputeIssueContinuityState(issueId, {
        tier: parsed.tier ?? initialState.tier,
        lastPreparedAt: new Date().toISOString(),
        forceSpecState: isContinuityExecuting(issue) ? "frozen" : null,
      });
      const continuityBundle = await buildContinuityBundle(issueId);
      return { continuityState, continuityBundle };
    },

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
          findings: parsed.findings,
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
