import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Agent, Issue, IssueBranchMergePreview } from "@paperclipai/shared";
import {
  buildIssueDocumentTemplate,
  getReservedIssueDocumentDescriptor,
  ISSUE_QA_MODE_LABELS,
  ISSUE_QA_RISK_TIER_LABELS,
  parseIssueBranchReturnMarkdown,
  parseIssueHandoffMarkdown,
  parseIssueQaPolicyMarkdown,
  parseIssueProgressMarkdown,
  parseIssueReviewFindingsMarkdown,
  suggestIssueQaPolicy,
} from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { companySkillsApi } from "../api/companySkills";
import { issuesApi } from "../api/issues";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { cn, relativeTime } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

type ContinuityTier = "tiny" | "normal" | "long_running";
type PlanningDocStatus = "missing" | "not_started" | "started";

function actorLabel(input: {
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  agentsById: Map<string, Agent>;
}) {
  if (input.assigneeAgentId) {
    return input.agentsById.get(input.assigneeAgentId)?.name ?? input.assigneeAgentId.slice(0, 8);
  }
  if (input.assigneeUserId) {
    return input.assigneeUserId;
  }
  return "Unassigned";
}

function gateLabel(
  participant: { type: "agent" | "user"; agentId?: string | null; userId?: string | null } | null | undefined,
  agentsById: Map<string, Agent>,
) {
  if (!participant) return "None";
  if (participant.type === "agent" && participant.agentId) {
    return agentsById.get(participant.agentId)?.name ?? participant.agentId.slice(0, 8);
  }
  if (participant.type === "user" && participant.userId) {
    return participant.userId;
  }
  return "None";
}

function tierLabel(tier: string) {
  switch (tier) {
    case "long_running":
      return "Long-running";
    case "normal":
      return "Normal";
    default:
      return "Tiny";
  }
}

function qaRiskTone(riskTier: string): "default" | "info" | "warn" | "danger" | "success" {
  switch (riskTier) {
    case "low":
      return "success";
    case "high":
      return "warn";
    case "critical":
      return "danger";
    default:
      return "info";
  }
}

function toneClass(kind: "healthy" | "warn" | "danger") {
  switch (kind) {
    case "danger":
      return "border-red-500/30 bg-red-500/5 text-red-700 dark:text-red-300";
    case "warn":
      return "border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-300";
    default:
      return "border-border bg-muted/20 text-foreground";
  }
}

function chipClass(kind: "default" | "info" | "warn" | "danger" | "success") {
  switch (kind) {
    case "info":
      return "border-blue-500/25 bg-blue-500/10 text-blue-700 dark:text-blue-300";
    case "warn":
      return "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    case "danger":
      return "border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-300";
    case "success":
      return "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    default:
      return "border-border bg-background/80 text-foreground";
  }
}

function docStatusLabel(status: PlanningDocStatus) {
  switch (status) {
    case "missing":
      return "Missing";
    case "not_started":
      return "Not started";
    default:
      return "Started";
  }
}

function docStatusTone(status: PlanningDocStatus): "default" | "warn" | "success" {
  switch (status) {
    case "missing":
      return "warn";
    case "not_started":
      return "default";
    default:
      return "success";
  }
}

function planApprovalStatusLabel(input: {
  status: string | null;
  currentRevisionApproved: boolean;
  requiresResubmission: boolean;
  requiresApproval: boolean;
}) {
  if (input.currentRevisionApproved) return "Approved";
  if (input.status === "revision_requested" || input.requiresResubmission) return "Revision requested";
  if (input.status === "pending") return "Pending";
  if (input.requiresApproval) return "Approval needed";
  return "Not requested";
}

function planApprovalStatusTone(input: {
  status: string | null;
  currentRevisionApproved: boolean;
  requiresResubmission: boolean;
  requiresApproval: boolean;
}): "default" | "warn" | "success" {
  if (input.currentRevisionApproved) return "success";
  if (input.status === "revision_requested" || input.requiresResubmission || input.requiresApproval) return "warn";
  return "default";
}

function lifecycleMeta(input: {
  hasPlanningScaffolds: boolean;
  hasMissingDocs: boolean;
  hasActiveReview: boolean;
  hasPendingHandoff: boolean;
  hasBranchWork: boolean;
}) {
  if (input.hasPendingHandoff) {
    return { label: "Handoff pending", tone: "info" as const };
  }
  if (input.hasActiveReview) {
    return { label: "In review", tone: "info" as const };
  }
  if (input.hasBranchWork) {
    return { label: "Branch work", tone: "info" as const };
  }
  if (input.hasMissingDocs || input.hasPlanningScaffolds) {
    return { label: "Planning setup", tone: input.hasMissingDocs ? "warn" as const : "default" as const };
  }
  return { label: "Execution ready", tone: "success" as const };
}

function splitLines(value: string) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseDecisionOptions(value: string) {
  return splitLines(value).map((line, index) => {
    const [labelPart, descriptionPart] = line.split("::");
    const label = labelPart.trim();
    return {
      key: `option_${index + 1}`,
      label,
      description: descriptionPart?.trim() || null,
    };
  });
}

function SectionCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-border/70 bg-background/70 p-3 space-y-2">
      <div>
        <div className="text-xs font-medium text-foreground">{title}</div>
        {subtitle ? <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p> : null}
      </div>
      {children}
    </div>
  );
}

function ActionRow({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-border/70 bg-background/80 p-3 space-y-2">
      <div>
        <div className="text-xs font-medium text-foreground">{title}</div>
        {description ? <p className="mt-1 text-xs text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </div>
  );
}

export function IssueContinuityPanel({
  issue,
  agents,
  childIssues,
  onOpenArtifacts,
}: {
  issue: Issue;
  agents: Agent[];
  childIssues: Issue[];
  onOpenArtifacts?: (documentKey?: string) => void;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const agentsById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const childIssuesById = useMemo(() => new Map(childIssues.map((child) => [child.id, child])), [childIssues]);
  const [prepareTier, setPrepareTier] = useState<ContinuityTier>((issue.continuityState?.tier ?? "normal") as ContinuityTier);
  const [specThawReason, setSpecThawReason] = useState("");
  const [showBranchForm, setShowBranchForm] = useState(false);
  const [branchTitle, setBranchTitle] = useState("");
  const [branchPurpose, setBranchPurpose] = useState("");
  const [branchScope, setBranchScope] = useState("");
  const [branchBudget, setBranchBudget] = useState("1 focused branch");
  const [branchReturnArtifact, setBranchReturnArtifact] = useState("Patch or findings");
  const [showHandoffForm, setShowHandoffForm] = useState(false);
  const [handoffAgentId, setHandoffAgentId] = useState("");
  const [handoffUserId, setHandoffUserId] = useState("");
  const [handoffReason, setHandoffReason] = useState("ownership_change");
  const [handoffNextAction, setHandoffNextAction] = useState("");
  const [showCheckpointForm, setShowCheckpointForm] = useState(false);
  const [checkpointSummary, setCheckpointSummary] = useState("");
  const [checkpointCompleted, setCheckpointCompleted] = useState("");
  const [checkpointCurrentState, setCheckpointCurrentState] = useState("");
  const [checkpointKnownPitfalls, setCheckpointKnownPitfalls] = useState("");
  const [checkpointNextAction, setCheckpointNextAction] = useState("");
  const [checkpointOpenQuestions, setCheckpointOpenQuestions] = useState("");
  const [checkpointEvidence, setCheckpointEvidence] = useState("");
  const [showReviewReturnForm, setShowReviewReturnForm] = useState(false);
  const [reviewOutcome, setReviewOutcome] = useState<"changes_requested" | "approved_with_notes" | "blocked">("changes_requested");
  const [reviewContext, setReviewContext] = useState("");
  const [reviewSeverity, setReviewSeverity] = useState<"critical" | "high" | "medium" | "low">("medium");
  const [reviewCategory, setReviewCategory] = useState("correctness");
  const [reviewTitle, setReviewTitle] = useState("");
  const [reviewDetail, setReviewDetail] = useState("");
  const [reviewRequiredAction, setReviewRequiredAction] = useState("");
  const [reviewEvidence, setReviewEvidence] = useState("");
  const [reviewOwnerNextAction, setReviewOwnerNextAction] = useState("");
  const [showResubmitForm, setShowResubmitForm] = useState(false);
  const [resubmitResponseNote, setResubmitResponseNote] = useState("");
  const [showRepairForm, setShowRepairForm] = useState(false);
  const [repairReasonCode, setRepairReasonCode] = useState("handoff_repair");
  const [repairNextAction, setRepairNextAction] = useState("");
  const [repairOpenQuestions, setRepairOpenQuestions] = useState("");
  const [repairEvidence, setRepairEvidence] = useState("");
  const [cancelReason, setCancelReason] = useState("");
  const [showBranchReturnForm, setShowBranchReturnForm] = useState(false);
  const [branchReturnPurposeScopeRecap, setBranchReturnPurposeScopeRecap] = useState("");
  const [branchReturnResultSummary, setBranchReturnResultSummary] = useState("");
  const [branchReturnDocKey, setBranchReturnDocKey] = useState("plan");
  const [branchReturnDocAction, setBranchReturnDocAction] = useState<"replace" | "append">("append");
  const [branchReturnDocSummary, setBranchReturnDocSummary] = useState("");
  const [branchReturnDocContent, setBranchReturnDocContent] = useState("");
  const [branchReturnChecklist, setBranchReturnChecklist] = useState("");
  const [branchReturnRisks, setBranchReturnRisks] = useState("");
  const [branchReturnQuestions, setBranchReturnQuestions] = useState("");
  const [branchReturnEvidence, setBranchReturnEvidence] = useState("");
  const [branchReturnArtifacts, setBranchReturnArtifacts] = useState("");
  const [showQuestionForm, setShowQuestionForm] = useState(false);
  const [showAdvancedActions, setShowAdvancedActions] = useState(false);
  const [advancedActionsTouched, setAdvancedActionsTouched] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [showSpecThawForm, setShowSpecThawForm] = useState(false);
  const [promotionFindingId, setPromotionFindingId] = useState<string | null>(null);
  const [promotionSkillId, setPromotionSkillId] = useState("");
  const [promotionSummary, setPromotionSummary] = useState("");
  const [questionTitle, setQuestionTitle] = useState("");
  const [questionBody, setQuestionBody] = useState("");
  const [questionWhyBlocked, setQuestionWhyBlocked] = useState("");
  const [questionOptions, setQuestionOptions] = useState("");
  const [questionSuggestedDefault, setQuestionSuggestedDefault] = useState("");
  const [questionBlocking, setQuestionBlocking] = useState(true);
  const [activeQuestionId, setActiveQuestionId] = useState<string | null>(null);
  const [questionAnswer, setQuestionAnswer] = useState("");
  const [questionAnswerOptionKey, setQuestionAnswerOptionKey] = useState("");
  const [selectedMergeBranchId, setSelectedMergeBranchId] = useState<string | null>(null);
  const [selectedMergeKeys, setSelectedMergeKeys] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const { data: continuity } = useQuery({
    queryKey: queryKeys.issues.continuity(issue.id),
    queryFn: () => issuesApi.getContinuity(issue.id),
  });

  const mergePreviewQuery = useQuery({
    queryKey: ["issues", "continuity", issue.id, "merge-preview", selectedMergeBranchId],
    queryFn: () => issuesApi.getBranchMergePreview(issue.id, selectedMergeBranchId!),
    enabled: Boolean(selectedMergeBranchId),
  });

  const skillsQuery = useQuery({
    queryKey: queryKeys.companySkills.list(issue.companyId),
    queryFn: () => companySkillsApi.list(issue.companyId),
  });

  useEffect(() => {
    const preview = mergePreviewQuery.data;
    if (!preview) return;
    setSelectedMergeKeys(preview.proposedUpdates.map((update) => update.documentKey));
  }, [mergePreviewQuery.data]);

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issue.id) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.documents(issue.id) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.continuity(issue.id) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.questions(issue.id) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.openQuestions(issue.companyId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(issue.companyId) }),
      issue.parentId
        ? queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issue.parentId) })
        : Promise.resolve(),
      issue.parentId
        ? queryClient.invalidateQueries({ queryKey: queryKeys.issues.continuity(issue.parentId) })
        : Promise.resolve(),
      issue.parentId
        ? queryClient.invalidateQueries({ queryKey: queryKeys.issues.listByParent(issue.companyId, issue.parentId) })
        : Promise.resolve(),
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listByParent(issue.companyId, issue.id) }),
    ]);
  };

  const resetDecisionQuestionComposer = () => {
    setActiveQuestionId(null);
    setQuestionAnswer("");
    setQuestionAnswerOptionKey("");
  };

  const prepareMutation = useMutation({
    mutationFn: () => issuesApi.prepareContinuity(issue.id, { tier: prepareTier }),
    onSuccess: async () => {
      setError(null);
      await invalidate();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Failed to prepare execution"),
  });

  const specThawMutation = useMutation({
    mutationFn: () => issuesApi.requestSpecThaw(issue.id, { reason: specThawReason.trim() || null }),
    onSuccess: async () => {
      setError(null);
      setSpecThawReason("");
      await invalidate();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Failed to request spec thaw"),
  });

  const handoffMutation = useMutation({
    mutationFn: () =>
      issuesApi.handoffContinuity(issue.id, {
        assigneeAgentId: handoffAgentId || null,
        assigneeUserId: handoffUserId.trim() || null,
        reasonCode: handoffReason.trim(),
        exactNextAction: handoffNextAction.trim(),
      }),
    onSuccess: async () => {
      setError(null);
      setShowHandoffForm(false);
      setHandoffAgentId("");
      setHandoffUserId("");
      setHandoffNextAction("");
      await invalidate();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Failed to hand off continuity"),
  });

  const checkpointMutation = useMutation({
    mutationFn: () =>
      issuesApi.addProgressCheckpoint(issue.id, {
        summary: checkpointSummary.trim() || null,
        completed: splitLines(checkpointCompleted),
        currentState: checkpointCurrentState.trim(),
        knownPitfalls: splitLines(checkpointKnownPitfalls),
        nextAction: checkpointNextAction.trim(),
        openQuestions: splitLines(checkpointOpenQuestions),
        evidence: splitLines(checkpointEvidence),
      }),
    onSuccess: async () => {
      setError(null);
      setShowCheckpointForm(false);
      setCheckpointSummary("");
      setCheckpointCompleted("");
      setCheckpointCurrentState("");
      setCheckpointKnownPitfalls("");
      setCheckpointNextAction("");
      setCheckpointOpenQuestions("");
      setCheckpointEvidence("");
      await invalidate();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Failed to append progress checkpoint"),
  });

  const reviewReturnMutation = useMutation({
    mutationFn: () =>
      issuesApi.reviewReturn(issue.id, {
        decisionContext: reviewContext.trim() || null,
        outcome: reviewOutcome,
        findings: [
          {
            severity: reviewSeverity,
            category: reviewCategory.trim(),
            title: reviewTitle.trim(),
            detail: reviewDetail.trim(),
            requiredAction: reviewRequiredAction.trim(),
            evidence: splitLines(reviewEvidence),
          },
        ],
        ownerNextAction: reviewOwnerNextAction.trim(),
      }),
    onSuccess: async () => {
      setError(null);
      setShowReviewReturnForm(false);
      setReviewContext("");
      setReviewTitle("");
      setReviewDetail("");
      setReviewRequiredAction("");
      setReviewEvidence("");
      setReviewOwnerNextAction("");
      await invalidate();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Failed to return review findings"),
  });

  const reviewResubmitMutation = useMutation({
    mutationFn: () =>
      issuesApi.reviewResubmit(issue.id, {
        responseNote: resubmitResponseNote.trim() || null,
        progressCheckpoint:
          checkpointCurrentState.trim() && checkpointNextAction.trim()
            ? {
                summary: checkpointSummary.trim() || null,
                completed: splitLines(checkpointCompleted),
                currentState: checkpointCurrentState.trim(),
                knownPitfalls: splitLines(checkpointKnownPitfalls),
                nextAction: checkpointNextAction.trim(),
                openQuestions: splitLines(checkpointOpenQuestions),
                evidence: splitLines(checkpointEvidence),
              }
            : null,
      }),
    onSuccess: async () => {
      setError(null);
      setShowResubmitForm(false);
      setResubmitResponseNote("");
      setCheckpointSummary("");
      setCheckpointCompleted("");
      setCheckpointCurrentState("");
      setCheckpointKnownPitfalls("");
      setCheckpointNextAction("");
      setCheckpointOpenQuestions("");
      setCheckpointEvidence("");
      await invalidate();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Failed to resubmit review"),
  });

  const promoteSkillMutation = useMutation({
    mutationFn: () =>
      issuesApi.promoteReviewFindingSkill(issue.id, promotionFindingId!, {
        companySkillId: promotionSkillId,
        reproductionSummary: promotionSummary.trim() || null,
      }),
    onSuccess: async () => {
      setError(null);
      setPromotionFindingId(null);
      setPromotionSkillId("");
      setPromotionSummary("");
      await Promise.all([
        invalidate(),
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.reliabilityAudit(issue.companyId) }),
      ]);
      pushToast({
        tone: "success",
        title: "Finding promoted",
        body: "The review finding is now linked to a skill hardening issue.",
      });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Failed to promote finding into skill hardening work"),
  });

  const repairHandoffMutation = useMutation({
    mutationFn: () =>
      issuesApi.repairHandoff(issue.id, {
        reasonCode: repairReasonCode.trim(),
        exactNextAction: repairNextAction.trim(),
        openQuestions: splitLines(repairOpenQuestions),
        evidence: splitLines(repairEvidence),
      }),
    onSuccess: async () => {
      setError(null);
      setShowRepairForm(false);
      setRepairReasonCode("handoff_repair");
      setRepairNextAction("");
      setRepairOpenQuestions("");
      setRepairEvidence("");
      await invalidate();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Failed to repair handoff"),
  });

  const cancelHandoffMutation = useMutation({
    mutationFn: () => issuesApi.cancelHandoff(issue.id, { reason: cancelReason.trim() }),
    onSuccess: async () => {
      setError(null);
      setCancelReason("");
      await invalidate();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Failed to cancel handoff"),
  });

  const branchMutation = useMutation({
    mutationFn: () =>
      issuesApi.mutateContinuityBranch(issue.id, {
        action: "create",
        title: branchTitle.trim(),
        purpose: branchPurpose.trim(),
        scope: branchScope.trim(),
        budget: branchBudget.trim(),
        expectedReturnArtifact: branchReturnArtifact.trim(),
      }),
    onSuccess: async () => {
      setError(null);
      setShowBranchForm(false);
      setBranchTitle("");
      setBranchPurpose("");
      setBranchScope("");
      setBranchBudget("1 focused branch");
      setBranchReturnArtifact("Patch or findings");
      await invalidate();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Failed to create branch issue"),
  });

  const branchReturnMutation = useMutation({
    mutationFn: () =>
      issuesApi.returnContinuityBranch(issue.parentId!, issue.id, {
        kind: "paperclip/issue-branch-return.v1",
        purposeScopeRecap: branchReturnPurposeScopeRecap.trim(),
        resultSummary: branchReturnResultSummary.trim(),
        proposedParentUpdates: branchReturnDocContent.trim()
          ? [{
              documentKey: branchReturnDocKey,
              action: branchReturnDocAction,
              summary: branchReturnDocSummary.trim(),
              content: branchReturnDocContent,
              title: null,
            }]
          : [],
        mergeChecklist: splitLines(branchReturnChecklist),
        unresolvedRisks: splitLines(branchReturnRisks),
        openQuestions: splitLines(branchReturnQuestions),
        evidence: splitLines(branchReturnEvidence),
        returnedArtifacts: splitLines(branchReturnArtifacts),
      }),
    onSuccess: async () => {
      setError(null);
      setShowBranchReturnForm(false);
      setBranchReturnPurposeScopeRecap("");
      setBranchReturnResultSummary("");
      setBranchReturnDocSummary("");
      setBranchReturnDocContent("");
      setBranchReturnChecklist("");
      setBranchReturnRisks("");
      setBranchReturnQuestions("");
      setBranchReturnEvidence("");
      setBranchReturnArtifacts("");
      await invalidate();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Failed to return branch work"),
  });

  const mergeBranchMutation = useMutation({
    mutationFn: (preview: IssueBranchMergePreview) =>
      issuesApi.mergeContinuityBranch(issue.id, preview.branchIssueId, {
        selectedDocumentKeys: selectedMergeKeys,
      }),
    onSuccess: async () => {
      setError(null);
      setSelectedMergeBranchId(null);
      setSelectedMergeKeys([]);
      await invalidate();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Failed to merge branch return"),
  });

  const requestPlanApprovalMutation = useMutation({
    mutationFn: () => issuesApi.requestPlanApproval(issue.id),
    onSuccess: async (result) => {
      setError(null);
      if (result.approvalId) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.approvals.detail(result.approvalId) });
      }
      await invalidate();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Failed to request plan approval"),
  });

  const createQuestionMutation = useMutation({
    mutationFn: () =>
      issuesApi.createQuestion(issue.id, {
        title: questionTitle.trim(),
        question: questionBody.trim(),
        whyBlocked: questionWhyBlocked.trim() || null,
        blocking: questionBlocking,
        recommendedOptions: parseDecisionOptions(questionOptions),
        suggestedDefault: questionSuggestedDefault.trim() || null,
      }),
    onSuccess: async () => {
      setError(null);
      setShowQuestionForm(false);
      setQuestionTitle("");
      setQuestionBody("");
      setQuestionWhyBlocked("");
      setQuestionOptions("");
      setQuestionSuggestedDefault("");
      setQuestionBlocking(true);
      await invalidate();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Failed to create decision question"),
  });

  const answerQuestionMutation = useMutation({
    mutationFn: (questionId: string) => {
      const trimmedAnswer = questionAnswer.trim();
      if (questionAnswerOptionKey) {
        return issuesApi.answerQuestion(questionId, {
          selectedOptionKey: questionAnswerOptionKey,
        });
      }
      return issuesApi.answerQuestion(questionId, {
        answer: trimmedAnswer,
      });
    },
    onSuccess: async () => {
      setError(null);
      resetDecisionQuestionComposer();
      await invalidate();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Failed to answer decision question"),
  });

  const dismissQuestionMutation = useMutation({
    mutationFn: (questionId: string) => issuesApi.dismissQuestion(questionId, {}),
    onSuccess: async () => {
      setError(null);
      resetDecisionQuestionComposer();
      await invalidate();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Failed to dismiss decision question"),
  });

  const escalateQuestionMutation = useMutation({
    mutationFn: (questionId: string) => issuesApi.escalateQuestionApproval(questionId, {}),
    onSuccess: async () => {
      setError(null);
      resetDecisionQuestionComposer();
      await invalidate();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Failed to escalate decision question"),
  });

  const state = continuity?.continuityState ?? issue.continuityState ?? null;
  const bundle = continuity?.continuityBundle ?? null;
  const remediation = continuity?.remediation ?? null;
  const planApproval = state?.planApproval ?? {
    approvalId: null,
    status: null,
    currentPlanRevisionId: null,
    requestedPlanRevisionId: null,
    approvedPlanRevisionId: null,
    specRevisionId: null,
    testPlanRevisionId: null,
    decisionNote: null,
    lastRequestedAt: null,
    lastDecidedAt: null,
    currentRevisionApproved: false,
    requiresApproval: false,
    requiresResubmission: false,
  };
  const progressDoc = bundle?.issueDocuments.progress?.body
    ? parseIssueProgressMarkdown(bundle.issueDocuments.progress.body)
    : null;
  const handoffDoc = bundle?.issueDocuments.handoff?.body
    ? parseIssueHandoffMarkdown(bundle.issueDocuments.handoff.body)
    : null;
  const reviewFindingsDoc = bundle?.issueDocuments["review-findings"]?.body
    ? parseIssueReviewFindingsMarkdown(bundle.issueDocuments["review-findings"].body)
    : null;
  const testPlanBody = bundle?.issueDocuments["test-plan"]?.body ?? null;
  const parsedQaPolicy = testPlanBody ? parseIssueQaPolicyMarkdown(testPlanBody) : null;
  const suggestedQaPolicy = useMemo(() => suggestIssueQaPolicy({
    title: issue.title,
    description: issue.description,
    priority: issue.priority,
    originKind: issue.originKind ?? null,
    labels: issue.labels?.map((label) => label.name) ?? [],
  }), [issue.description, issue.labels, issue.originKind, issue.priority, issue.title]);
  const qaPolicy = parsedQaPolicy
    ? { ...parsedQaPolicy, reasons: [] as string[], source: "test-plan" as const }
    : { ...suggestedQaPolicy, source: "suggested" as const };
  const branchReturnDoc = bundle?.issueDocuments["branch-return"]?.body
    ? parseIssueBranchReturnMarkdown(bundle.issueDocuments["branch-return"].body)
    : null;
  const decisionQuestions = bundle?.decisionQuestions ?? [];
  const openDecisionQuestions = decisionQuestions.filter((question) => question.status === "open");
  const answeredDecisionQuestions = decisionQuestions.filter((question) => question.status === "answered");
  const activeDecisionQuestion = activeQuestionId
    ? decisionQuestions.find((question) => question.id === activeQuestionId) ?? null
    : null;
  const returnedBranches = (state?.returnedBranchIssueIds ?? [])
    .map((branchId) => childIssuesById.get(branchId))
    .filter((branch): branch is Issue => Boolean(branch));
  const planningDocuments = useMemo(() => {
    if (!state || !bundle) return [];
    return state.requiredDocumentKeys.map((key) => {
      const snapshot = bundle.issueDocuments[key as keyof typeof bundle.issueDocuments] ?? null;
      const template = buildIssueDocumentTemplate(key, {
        title: issue.title,
        description: issue.description ?? null,
        tier: state.tier,
      });
      const status: PlanningDocStatus = !snapshot
        ? "missing"
        : template && snapshot.body.trim() === template.trim()
          ? "not_started"
          : "started";
      return {
        key,
        label: getReservedIssueDocumentDescriptor(key)?.label ?? key,
        status,
        snapshot,
      };
    });
  }, [bundle, issue.description, issue.title, state]);
  const startedPlanningDocCount = planningDocuments.filter((doc) => doc.status === "started").length;
  const missingPlanningDocCount = planningDocuments.filter((doc) => doc.status === "missing").length;
  const hasPlanningScaffolds =
    planningDocuments.length > 0
    && missingPlanningDocCount === 0
    && startedPlanningDocCount === 0
    && planningDocuments.some((doc) => doc.status === "not_started");
  const progressDocStatus = planningDocuments.find((doc) => doc.key === "progress")?.status ?? "missing";
  const progressMeaningfullyStarted = progressDocStatus === "started";
  const hasPendingHandoff = state?.status === "handoff_pending" || state?.health === "invalid_handoff";
  const hasActiveReview =
    Boolean(continuity?.activeGateParticipant)
    || Boolean(reviewFindingsDoc && reviewFindingsDoc.document.resolutionState === "open");
  const hasBranchWork =
    Boolean(state?.branchRole === "branch")
    || Boolean(returnedBranches.length > 0)
    || Boolean((state?.unresolvedBranchIssueIds.length ?? 0) > 0);
  const lifecycle = state
    ? lifecycleMeta({
        hasPlanningScaffolds,
        hasMissingDocs: missingPlanningDocCount > 0,
        hasActiveReview,
        hasPendingHandoff,
        hasBranchWork,
      })
    : { label: "Planning setup", tone: "default" as const };
  const readyToExecute =
    state?.status === "ready" &&
    state.health === "healthy" &&
    (state.blockingDecisionQuestionCount ?? 0) === 0 &&
    state.missingDocumentKeys.length === 0 &&
    startedPlanningDocCount === planningDocuments.length;
  const showCheckpointShortcut = state?.status === "active" || progressMeaningfullyStarted;
  const showPlanApprovalCard = Boolean(
    planApproval.approvalId
    || planApproval.requiresApproval
    || planApproval.requiresResubmission
    || planApproval.currentRevisionApproved
    || planApproval.status === "pending"
    || planApproval.status === "revision_requested",
  );
  const planApprovalActionLabel =
    planApproval.currentRevisionApproved
      ? null
      : planApproval.status === "revision_requested" || planApproval.requiresResubmission
        ? "Revise plan and resubmit"
        : planApproval.requiresApproval
          ? "Request plan approval"
          : null;
  const shouldAutoExpandAdvanced = Boolean(
    state
    && (
      hasPendingHandoff
      || Boolean(reviewFindingsDoc && reviewFindingsDoc.document.resolutionState === "open")
      || returnedBranches.length > 0
      || Boolean(continuity?.activeGateParticipant)
      || state.branchRole === "branch"
    ),
  );

  useEffect(() => {
    if (!advancedActionsTouched && shouldAutoExpandAdvanced) {
      setShowAdvancedActions(true);
    }
  }, [advancedActionsTouched, shouldAutoExpandAdvanced]);

  const topSuggestedAction = remediation?.suggestedActions[0] ?? null;

  if (!state) {
    return (
      <div className="rounded-lg border border-border p-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-medium">Continuity</h3>
            <p className="text-xs text-muted-foreground">Server continuity state has not been prepared yet.</p>
          </div>
          <Button size="sm" onClick={() => prepareMutation.mutate()} disabled={prepareMutation.isPending}>
            {prepareMutation.isPending ? "Preparing…" : "Prepare planning docs"}
          </Button>
        </div>
      </div>
    );
  }

  const healthTone =
    state.health === "invalid_handoff"
      ? "danger"
      : state.health === "missing_required_docs" || state.health === "stale_progress"
        ? "warn"
        : "healthy";
  const primaryPlanningActionLabel = missingPlanningDocCount > 0 ? "Prepare planning docs" : "Open planning docs";
  const openArtifacts = (documentKey = "plan") => {
    onOpenArtifacts?.(documentKey);
  };
  const nextStepActionLabel = topSuggestedAction?.id === "prepare_execution" ? "Prepare planning docs" : topSuggestedAction?.label ?? null;
  const nextStepAction = topSuggestedAction
    ? () => {
        switch (topSuggestedAction.id) {
          case "prepare_execution":
            prepareMutation.mutate();
            break;
          case "request_plan_approval":
          case "resubmit_plan_approval":
            requestPlanApprovalMutation.mutate();
            break;
          case "progress_checkpoint":
            setShowCheckpointForm(true);
            break;
          case "handoff_repair":
          case "handoff_cancel":
            setAdvancedActionsTouched(true);
            setShowAdvancedActions(true);
            setShowRepairForm(true);
            break;
          case "review_resubmit":
            setAdvancedActionsTouched(true);
            setShowAdvancedActions(true);
            setShowResubmitForm(true);
            break;
          case "branch_merge":
            setAdvancedActionsTouched(true);
            setShowAdvancedActions(true);
            setSelectedMergeBranchId((current) => current ?? returnedBranches[0]?.id ?? null);
            break;
        }
      }
    : null;
  const detailedRemediationActions = [...(remediation?.suggestedActions ?? []), ...(remediation?.blockedActions ?? [])];

  return (
    <div className={cn("space-y-3 rounded-lg border p-3", toneClass(healthTone))}>
      <div data-testid="continuity-summary" className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium">Continuity</h3>
            <span className={cn("rounded-full border px-2 py-0.5 text-[11px]", chipClass("default"))}>
              {tierLabel(state.tier)}
            </span>
            <span className={cn("rounded-full border px-2 py-0.5 text-[11px]", chipClass(lifecycle.tone))}>
              {lifecycle.label}
            </span>
            <span
              data-testid="continuity-qa-risk-chip"
              className={cn("rounded-full border px-2 py-0.5 text-[11px]", chipClass(qaRiskTone(qaPolicy.riskTier)))}
              title={qaPolicy.source === "test-plan" ? "From test-plan Risk and QA Mode" : "Suggested from issue metadata"}
            >
              QA: {ISSUE_QA_RISK_TIER_LABELS[qaPolicy.riskTier]} / {ISSUE_QA_MODE_LABELS[qaPolicy.mode]}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            Owner: {actorLabel({ assigneeAgentId: issue.assigneeAgentId, assigneeUserId: issue.assigneeUserId, agentsById })}
          </p>
          {continuity?.activeGateParticipant ? (
            <p className="text-xs text-muted-foreground">
              Gate: {gateLabel(continuity.activeGateParticipant, agentsById)}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            onClick={() => {
              if (missingPlanningDocCount > 0) {
                prepareMutation.mutate();
                return;
              }
              openArtifacts("plan");
            }}
            disabled={prepareMutation.isPending}
          >
            {prepareMutation.isPending ? "Preparing…" : primaryPlanningActionLabel}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setShowQuestionForm((value) => !value)}>
            Ask decision
          </Button>
          {showCheckpointShortcut ? (
            <Button size="sm" variant="outline" onClick={() => setShowCheckpointForm((value) => !value)}>
              Add checkpoint
            </Button>
          ) : null}
        </div>
      </div>

      {topSuggestedAction && nextStepActionLabel && nextStepAction ? (
        <SectionCard title="Next step" subtitle={topSuggestedAction.description}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs text-muted-foreground">
              {topSuggestedAction.actor.replaceAll("_", " ")}
            </div>
            <Button size="sm" variant="outline" onClick={nextStepAction}>
              {nextStepActionLabel}
            </Button>
          </div>
        </SectionCard>
      ) : null}

      <SectionCard
        title="Planning checklist"
        subtitle={`Planning docs started ${startedPlanningDocCount}/${planningDocuments.length}`}
      >
        <div data-testid="continuity-planning-checklist" className="space-y-2">
          {planningDocuments.map((doc) => (
            <div
              key={doc.key}
              data-testid={`continuity-planning-doc-${doc.key}`}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/70 bg-background/80 px-3 py-2"
            >
              <div className="min-w-0 space-y-1">
                <div className="text-xs font-medium text-foreground">{doc.label}</div>
                <div className="text-xs text-muted-foreground">
                  {doc.status === "missing"
                    ? "This document has not been scaffolded yet."
                    : doc.status === "not_started"
                      ? "Scaffolded and waiting for the first real edit."
                      : doc.snapshot?.updatedAt
                        ? `Updated ${relativeTime(doc.snapshot.updatedAt)}`
                        : "In progress."}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className={cn("rounded-full border px-2 py-0.5 text-[11px]", chipClass(docStatusTone(doc.status)))}>
                  {docStatusLabel(doc.status)}
                </span>
                <Button size="sm" variant="outline" onClick={() => openArtifacts(doc.key)}>
                  Open
                </Button>
              </div>
            </div>
          ))}
        </div>
      </SectionCard>

      {showPlanApprovalCard ? (
        <SectionCard
          title="Plan approval"
          subtitle={
            planApproval.currentRevisionApproved
              ? "The current plan revision is approved for execution."
              : planApproval.status === "pending"
                ? "Board review is pending before execution can start."
                : planApproval.status === "revision_requested"
                  ? "Board requested revisions on the current plan approval."
                  : planApproval.requiresResubmission
                    ? "The approved revision is stale. Resubmit the current plan before execution."
                    : "Execution starts only after the current plan revision is approved."
          }
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={cn(
                  "rounded-full border px-2 py-0.5 text-[11px]",
                  chipClass(planApprovalStatusTone(planApproval)),
                )}
              >
                {planApprovalStatusLabel(planApproval)}
              </span>
              {planApproval.approvalId ? (
                <span className="text-xs text-muted-foreground">
                  Approval {planApproval.approvalId.slice(0, 8)}
                </span>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => openArtifacts("plan")}>
                Open plan
              </Button>
              {planApproval.approvalId ? (
                <Link
                  to={`/approvals/${planApproval.approvalId}`}
                  className="inline-flex h-8 items-center justify-center rounded-md border border-input bg-background px-3 text-xs font-medium text-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                >
                  Open plan approval
                </Link>
              ) : null}
              {planApprovalActionLabel ? (
                <Button
                  size="sm"
                  onClick={() => requestPlanApprovalMutation.mutate()}
                  disabled={requestPlanApprovalMutation.isPending}
                >
                  {requestPlanApprovalMutation.isPending ? "Submitting…" : planApprovalActionLabel}
                </Button>
              ) : null}
            </div>
          </div>

          <div className="grid gap-2 text-xs text-muted-foreground md:grid-cols-2">
            <div>
              <span className="font-medium text-foreground">Current plan revision:</span>{" "}
              {planApproval.currentPlanRevisionId?.slice(0, 8) ?? "none"}
            </div>
            <div>
              <span className="font-medium text-foreground">Requested revision:</span>{" "}
              {planApproval.requestedPlanRevisionId?.slice(0, 8) ?? "none"}
            </div>
            <div>
              <span className="font-medium text-foreground">Approved revision:</span>{" "}
              {planApproval.approvedPlanRevisionId?.slice(0, 8) ?? "none"}
            </div>
            <div>
              <span className="font-medium text-foreground">Last board decision:</span>{" "}
              {planApproval.lastDecidedAt ? relativeTime(planApproval.lastDecidedAt) : "none"}
            </div>
          </div>

          {planApproval.decisionNote ? (
            <div className="rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-foreground">
              <span className="font-medium">Board note:</span> {planApproval.decisionNote}
            </div>
          ) : null}
        </SectionCard>
      ) : null}

      {showQuestionForm ? (
        <SectionCard title="Ask a decision question" subtitle="Use a typed question artifact when the board needs to unblock planning or execution.">
          <div className="grid gap-2 md:grid-cols-2">
            <Input value={questionTitle} onChange={(event) => setQuestionTitle(event.target.value)} placeholder="Question title" className="md:col-span-2" />
            <Textarea value={questionBody} onChange={(event) => setQuestionBody(event.target.value)} placeholder="Question for the board" className="md:col-span-2" />
            <Textarea value={questionWhyBlocked} onChange={(event) => setQuestionWhyBlocked(event.target.value)} placeholder="Why this blocks progress" className="md:col-span-2" />
            <Textarea value={questionOptions} onChange={(event) => setQuestionOptions(event.target.value)} placeholder={"Recommended options, one per line\nOption A::When to choose it"} className="md:col-span-2" />
            <Input value={questionSuggestedDefault} onChange={(event) => setQuestionSuggestedDefault(event.target.value)} placeholder="Suggested default recommendation" className="md:col-span-2" />
            <Label className="md:col-span-2 flex items-center gap-2 text-xs">
              <Checkbox checked={questionBlocking} onCheckedChange={(value) => setQuestionBlocking(Boolean(value))} />
              Block progress until answered
            </Label>
            <div className="md:col-span-2 flex gap-2">
              <Button
                size="sm"
                onClick={() => createQuestionMutation.mutate()}
                disabled={createQuestionMutation.isPending || !questionTitle.trim() || !questionBody.trim()}
              >
                {createQuestionMutation.isPending ? "Asking…" : "Create question"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setShowQuestionForm(false)}>Cancel</Button>
            </div>
          </div>
        </SectionCard>
      ) : null}

      {openDecisionQuestions.length > 0 ? (
        <SectionCard title="Open decision questions" subtitle="Blocking questions pause work until the board answers or dismisses them.">
          <div className="space-y-2">
            {openDecisionQuestions.map((question) => {
              const hasSelectedOption = questionAnswerOptionKey.length > 0;
              const hasCustomComment = questionAnswer.trim().length > 0;
              const canAnswerQuestion = hasSelectedOption !== hasCustomComment;

              return (
                <div key={question.id} className="rounded-md border border-border/70 bg-background/80 p-3 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="text-xs font-medium text-foreground">{question.title}</div>
                    <span className="rounded-full border border-border px-2 py-0.5 text-[10px] uppercase">
                      {question.blocking ? "blocking" : "non-blocking"}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">{question.question}</p>
                  {question.whyBlocked ? (
                    <p className="text-xs">
                      <span className="font-medium text-foreground">Why blocked:</span> {question.whyBlocked}
                    </p>
                  ) : null}
                  {question.recommendedOptions.length > 0 ? (
                    <ul className="space-y-1 text-xs text-muted-foreground">
                      {question.recommendedOptions.map((option) => (
                        <li key={option.key}>
                          <span className="font-medium text-foreground">{option.label}</span>
                          {option.description ? ` — ${option.description}` : ""}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => {
                      setActiveQuestionId(question.id);
                      setQuestionAnswer("");
                      setQuestionAnswerOptionKey("");
                    }}>
                      Answer / dismiss
                    </Button>
                  </div>
                  {activeDecisionQuestion?.id === question.id ? (
                    <div className="grid gap-2 md:grid-cols-2">
                      {question.recommendedOptions.length > 0 ? (
                        <div className="space-y-2 md:col-span-2" role="radiogroup" aria-label="Recommended options">
                          {question.recommendedOptions.map((option) => {
                            const selected = questionAnswerOptionKey === option.key;

                            return (
                              <button
                                key={option.key}
                                type="button"
                                className={cn(
                                  "w-full rounded-md border px-3 py-2 text-left transition-colors",
                                  selected
                                    ? "border-primary bg-primary/10 text-foreground"
                                    : "border-border/70 bg-background hover:border-border",
                                )}
                                aria-pressed={selected}
                                onClick={() => {
                                  setQuestionAnswerOptionKey(selected ? "" : option.key);
                                  setQuestionAnswer("");
                                }}
                              >
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <span className="text-sm font-medium text-foreground">{option.label}</span>
                                  {question.suggestedDefault === option.key ? (
                                    <span className="rounded-full border border-border px-2 py-0.5 text-[10px] uppercase text-muted-foreground">
                                      Suggested
                                    </span>
                                  ) : null}
                                </div>
                                {option.description ? (
                                  <div className="mt-1 text-xs text-muted-foreground">{option.description}</div>
                                ) : null}
                              </button>
                            );
                          })}
                        </div>
                      ) : null}
                      <Textarea
                        value={questionAnswer}
                        onChange={(event) => {
                          setQuestionAnswer(event.target.value);
                          if (event.target.value.trim().length > 0) {
                            setQuestionAnswerOptionKey("");
                          }
                        }}
                        placeholder={question.recommendedOptions.length > 0 ? "Add your own comment" : "Answer"}
                        className="md:col-span-2"
                      />
                      <div className="md:col-span-2 flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          onClick={() => answerQuestionMutation.mutate(question.id)}
                          disabled={answerQuestionMutation.isPending || !canAnswerQuestion}
                        >
                          {answerQuestionMutation.isPending ? "Saving…" : "Answer"}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => dismissQuestionMutation.mutate(question.id)}
                          disabled={dismissQuestionMutation.isPending}
                        >
                          {dismissQuestionMutation.isPending ? "Dismissing…" : "Dismiss"}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => escalateQuestionMutation.mutate(question.id)}
                          disabled={escalateQuestionMutation.isPending}
                        >
                          {escalateQuestionMutation.isPending ? "Escalating…" : "Escalate to approval"}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={resetDecisionQuestionComposer}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </SectionCard>
      ) : null}

      {answeredDecisionQuestions.length > 0 ? (
        <SectionCard title="Answered decisions" subtitle="Recent board answers persisted as decision artifacts.">
          <div className="space-y-2 text-xs">
            {answeredDecisionQuestions.map((question) => {
              const selectedOption = question.answer?.selectedOptionKey
                ? question.recommendedOptions.find((option) => option.key === question.answer?.selectedOptionKey) ?? null
                : null;

              return (
                <div key={question.id} className="rounded-md border border-border/70 bg-background/80 p-3 space-y-1">
                  <div className="font-medium text-foreground">{question.title}</div>
                  <p className="text-muted-foreground">{question.question}</p>
                  <p>
                    <span className="font-medium text-foreground">
                      {selectedOption ? "Selected option:" : "Answer:"}
                    </span>{" "}
                    {selectedOption?.label ?? question.answer?.answer ?? "none"}
                  </p>
                  <p className="text-muted-foreground">
                    {question.answeredAt ? `Answered ${relativeTime(question.answeredAt)}` : "Answered"}
                  </p>
                </div>
              );
            })}
          </div>
        </SectionCard>
      ) : null}

      {progressDoc && progressMeaningfullyStarted ? (
        <SectionCard title="Current checkpoint" subtitle="Top snapshot from the continuity progress document.">
          <p className="text-xs text-muted-foreground">{progressDoc.document.currentState}</p>
          <p className="text-xs">
            <span className="font-medium text-foreground">Next:</span> {progressDoc.document.nextAction}
          </p>
        </SectionCard>
      ) : null}

      {showCheckpointForm ? (
        <SectionCard title="Progress checkpoint" subtitle="Append-only checkpoint plus a refreshed top snapshot.">
          <div className="grid gap-2 md:grid-cols-2">
            <Input value={checkpointSummary} onChange={(event) => setCheckpointSummary(event.target.value)} placeholder="Summary" />
            <Input value={checkpointCompleted} onChange={(event) => setCheckpointCompleted(event.target.value)} placeholder="Completed items (one per line or comma-separated later)" />
            <Textarea value={checkpointCurrentState} onChange={(event) => setCheckpointCurrentState(event.target.value)} placeholder="Current state" className="md:col-span-2" />
            <Textarea value={checkpointKnownPitfalls} onChange={(event) => setCheckpointKnownPitfalls(event.target.value)} placeholder="Known pitfalls (one per line)" className="md:col-span-2" />
            <Textarea value={checkpointNextAction} onChange={(event) => setCheckpointNextAction(event.target.value)} placeholder="Exact next action" className="md:col-span-2" />
            <Textarea value={checkpointOpenQuestions} onChange={(event) => setCheckpointOpenQuestions(event.target.value)} placeholder="Open questions (one per line)" className="md:col-span-2" />
            <Textarea value={checkpointEvidence} onChange={(event) => setCheckpointEvidence(event.target.value)} placeholder="Evidence links (one per line)" className="md:col-span-2" />
            <div className="md:col-span-2 flex gap-2">
              <Button
                size="sm"
                onClick={() => checkpointMutation.mutate()}
                disabled={checkpointMutation.isPending || !checkpointCurrentState.trim() || !checkpointNextAction.trim()}
              >
                {checkpointMutation.isPending ? "Saving…" : "Append checkpoint"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setShowCheckpointForm(false)}>Cancel</Button>
            </div>
          </div>
        </SectionCard>
      ) : null}

      <SectionCard
        title="Advanced continuity actions"
        subtitle="Handoff, review, branch, and thaw workflows stay available here when needed."
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs text-muted-foreground">
            Hidden by default until the issue enters a review, handoff, or branch workflow.
          </div>
          <Button
            size="sm"
            variant="outline"
            data-testid="continuity-advanced-toggle"
            onClick={() => {
              setAdvancedActionsTouched(true);
              setShowAdvancedActions((value) => !value);
            }}
          >
            {showAdvancedActions ? "Hide advanced" : "Show advanced"}
          </Button>
        </div>

        {showAdvancedActions ? (
          <div data-testid="continuity-advanced-panel" className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => setShowHandoffForm((value) => !value)}>
                Start handoff
              </Button>
              <Button size="sm" variant="outline" onClick={() => setShowBranchForm((value) => !value)}>
                Create branch issue
              </Button>
              <Button size="sm" variant="outline" onClick={() => setShowSpecThawForm((value) => !value)}>
                Request spec thaw
              </Button>
              {continuity?.activeGateParticipant ? (
                <Button size="sm" variant="outline" onClick={() => setShowReviewReturnForm((value) => !value)}>
                  Return findings
                </Button>
              ) : null}
              {reviewFindingsDoc && reviewFindingsDoc.document.resolutionState === "open" ? (
                <Button size="sm" variant="outline" onClick={() => setShowResubmitForm((value) => !value)}>
                  Resubmit for review
                </Button>
              ) : null}
              {state.status === "handoff_pending" || state.health === "invalid_handoff" ? (
                <Button size="sm" variant="outline" onClick={() => setShowRepairForm((value) => !value)}>
                  Repair handoff
                </Button>
              ) : null}
              {state.branchRole === "branch" ? (
                <Button size="sm" variant="outline" onClick={() => setShowBranchReturnForm((value) => !value)}>
                  Return branch work
                </Button>
              ) : null}
              {returnedBranches.length > 0 ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setSelectedMergeBranchId((current) => current ?? returnedBranches[0]?.id ?? null)}
                >
                  Review returned branches
                </Button>
              ) : null}
            </div>

            {showSpecThawForm ? (
              <ActionRow
                title="Request spec thaw"
                description="Use this only when the spec must be edited after execution has already started."
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    value={specThawReason}
                    onChange={(event) => setSpecThawReason(event.target.value)}
                    placeholder="Optional spec thaw reason"
                    className="max-w-sm"
                  />
                  <Button size="sm" onClick={() => specThawMutation.mutate()} disabled={specThawMutation.isPending}>
                    {specThawMutation.isPending ? "Requesting…" : "Request thaw"}
                  </Button>
                </div>
              </ActionRow>
            ) : null}

            {reviewFindingsDoc && reviewFindingsDoc.document.resolutionState === "open" ? (
              <SectionCard
                title="Active review findings"
                subtitle={`${reviewFindingsDoc.document.outcome.replaceAll("_", " ")} · ${reviewFindingsDoc.document.reviewStage}`}
              >
                <div className="space-y-2 text-xs">
                  <p className="text-muted-foreground">{reviewFindingsDoc.document.ownerNextAction}</p>
                  <ul className="space-y-2">
                    {reviewFindingsDoc.document.findings.map((finding, index) => (
                      <li key={finding.findingId ?? `${finding.title}-${index}`} className="rounded border border-border/60 px-2 py-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-foreground">{finding.title}</span>
                          <span className="rounded-full border border-border px-2 py-0.5 text-[10px] uppercase">
                            {finding.severity}
                          </span>
                          <span className="rounded-full border border-border px-2 py-0.5 text-[10px]">
                            {finding.category}
                          </span>
                        </div>
                        <p className="mt-1 text-muted-foreground">{finding.detail}</p>
                        <p className="mt-1">
                          <span className="font-medium text-foreground">Required action:</span> {finding.requiredAction}
                        </p>
                        {finding.skillPromotion?.hardeningIssueId ? (
                          <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                            <span className="rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-sky-700 dark:text-sky-200">
                              promoted
                            </span>
                            <Link
                              to={`/issues/${finding.skillPromotion.hardeningIssueIdentifier ?? finding.skillPromotion.hardeningIssueId}`}
                              className="text-foreground no-underline hover:underline"
                            >
                              {finding.skillPromotion.hardeningIssueIdentifier ?? finding.skillPromotion.hardeningIssueId.slice(0, 8)}
                            </Link>
                            {finding.skillPromotion.sharedSkillProposalStatus ? (
                              <span>proposal {finding.skillPromotion.sharedSkillProposalStatus.replaceAll("_", " ")}</span>
                            ) : null}
                          </div>
                        ) : null}
                        {finding.findingId ? (
                          <div className="mt-3 rounded border border-dashed border-border/60 px-3 py-3">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                                Promote to skill hardening
                              </div>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  if (promotionFindingId === finding.findingId) {
                                    setPromotionFindingId(null);
                                    setPromotionSkillId("");
                                    setPromotionSummary("");
                                    return;
                                  }
                                  setPromotionFindingId(finding.findingId ?? null);
                                  setPromotionSkillId((current) => current || skillsQuery.data?.[0]?.id || "");
                                  setPromotionSummary(finding.detail);
                                }}
                              >
                                {promotionFindingId === finding.findingId ? "Cancel" : "Promote"}
                              </Button>
                            </div>
                            {promotionFindingId === finding.findingId ? (
                              <div className="mt-3 space-y-2">
                                <select
                                  value={promotionSkillId}
                                  onChange={(event) => setPromotionSkillId(event.target.value)}
                                  className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
                                >
                                  <option value="">Select target skill</option>
                                  {(skillsQuery.data ?? []).map((skill) => (
                                    <option key={skill.id} value={skill.id}>
                                      {skill.name}
                                    </option>
                                  ))}
                                </select>
                                <Textarea
                                  value={promotionSummary}
                                  onChange={(event) => setPromotionSummary(event.target.value)}
                                  placeholder="Optional reproduction summary"
                                  className="min-h-[84px]"
                                />
                                <div className="flex flex-wrap items-center gap-2">
                                  <Button
                                    size="sm"
                                    onClick={() => promoteSkillMutation.mutate()}
                                    disabled={promoteSkillMutation.isPending || !promotionSkillId}
                                  >
                                    {promoteSkillMutation.isPending ? "Promoting..." : "Create hardening issue"}
                                  </Button>
                                  {skillsQuery.isLoading ? (
                                    <span className="text-xs text-muted-foreground">Loading skill library...</span>
                                  ) : null}
                                </div>
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              </SectionCard>
            ) : null}

            {showBranchForm ? (
              <SectionCard title="Create branch issue" subtitle="Bounded branch work returns into the same parent continuity thread.">
                <div className="grid gap-2 md:grid-cols-2">
                  <Input value={branchTitle} onChange={(event) => setBranchTitle(event.target.value)} placeholder="Branch issue title" />
                  <Input value={branchBudget} onChange={(event) => setBranchBudget(event.target.value)} placeholder="Budget" />
                  <Textarea value={branchPurpose} onChange={(event) => setBranchPurpose(event.target.value)} placeholder="Purpose" className="md:col-span-2" />
                  <Textarea value={branchScope} onChange={(event) => setBranchScope(event.target.value)} placeholder="Scope" className="md:col-span-2" />
                  <Input
                    value={branchReturnArtifact}
                    onChange={(event) => setBranchReturnArtifact(event.target.value)}
                    placeholder="Expected return artifact"
                    className="md:col-span-2"
                  />
                  <div className="md:col-span-2 flex gap-2">
                    <Button
                      size="sm"
                      onClick={() => branchMutation.mutate()}
                      disabled={branchMutation.isPending || !branchTitle.trim() || !branchPurpose.trim() || !branchScope.trim()}
                    >
                      {branchMutation.isPending ? "Creating…" : "Create branch issue"}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setShowBranchForm(false)}>Cancel</Button>
                  </div>
                </div>
              </SectionCard>
            ) : null}

            {showHandoffForm ? (
              <SectionCard title="Start handoff" subtitle="Ownership transfer is explicit and requires a durable handoff artifact.">
                <div className="grid gap-2 md:grid-cols-2">
                  <select
                    value={handoffAgentId}
                    onChange={(event) => setHandoffAgentId(event.target.value)}
                    className="h-9 rounded-md border border-border bg-background px-2 text-sm"
                  >
                    <option value="">Select agent target</option>
                    {agents
                      .filter((agent) => agent.id !== issue.assigneeAgentId)
                      .map((agent) => (
                        <option key={agent.id} value={agent.id}>
                          {agent.name}
                        </option>
                      ))}
                  </select>
                  <Input value={handoffUserId} onChange={(event) => setHandoffUserId(event.target.value)} placeholder="Or board user id" />
                  <Input value={handoffReason} onChange={(event) => setHandoffReason(event.target.value)} placeholder="Reason code" />
                  <Input value={handoffNextAction} onChange={(event) => setHandoffNextAction(event.target.value)} placeholder="Exact next action" className="md:col-span-2" />
                  <div className="md:col-span-2 flex gap-2">
                    <Button
                      size="sm"
                      onClick={() => handoffMutation.mutate()}
                      disabled={handoffMutation.isPending || (!handoffAgentId && !handoffUserId.trim()) || !handoffNextAction.trim()}
                    >
                      {handoffMutation.isPending ? "Handing off…" : "Confirm handoff"}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setShowHandoffForm(false)}>Cancel</Button>
                  </div>
                </div>
              </SectionCard>
            ) : null}

            {state.status === "handoff_pending" || state.health === "invalid_handoff" ? (
              <SectionCard title="Pending handoff remediation" subtitle="Repair or cancel the current handoff explicitly.">
                {showRepairForm ? (
                  <div className="grid gap-2 md:grid-cols-2">
                    <Input value={repairReasonCode} onChange={(event) => setRepairReasonCode(event.target.value)} placeholder="Reason code" />
                    <Input value={cancelReason} onChange={(event) => setCancelReason(event.target.value)} placeholder="Cancel reason" />
                    <Textarea value={repairNextAction} onChange={(event) => setRepairNextAction(event.target.value)} placeholder="Exact next action" className="md:col-span-2" />
                    <Textarea value={repairOpenQuestions} onChange={(event) => setRepairOpenQuestions(event.target.value)} placeholder="Open questions (one per line)" className="md:col-span-2" />
                    <Textarea value={repairEvidence} onChange={(event) => setRepairEvidence(event.target.value)} placeholder="Evidence (one per line)" className="md:col-span-2" />
                    <div className="md:col-span-2 flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        onClick={() => repairHandoffMutation.mutate()}
                        disabled={repairHandoffMutation.isPending || !repairNextAction.trim()}
                      >
                        {repairHandoffMutation.isPending ? "Repairing…" : "Repair handoff"}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => cancelHandoffMutation.mutate()}
                        disabled={cancelHandoffMutation.isPending || !cancelReason.trim()}
                      >
                        {cancelHandoffMutation.isPending ? "Cancelling…" : "Cancel handoff"}
                      </Button>
                    </div>
                  </div>
                ) : null}
              </SectionCard>
            ) : null}

            {continuity?.activeGateParticipant ? (
              <SectionCard title="Review gate" subtitle="Review and approval remain gates. They do not take continuity ownership.">
                {showReviewReturnForm ? (
                  <div className="grid gap-2 md:grid-cols-2">
                    <select
                      value={reviewOutcome}
                      onChange={(event) => setReviewOutcome(event.target.value as typeof reviewOutcome)}
                      className="h-9 rounded-md border border-border bg-background px-2 text-sm"
                    >
                      <option value="changes_requested">Changes requested</option>
                      <option value="approved_with_notes">Approved with notes</option>
                      <option value="blocked">Blocked</option>
                    </select>
                    <Input value={reviewContext} onChange={(event) => setReviewContext(event.target.value)} placeholder="Decision context" />
                    <select
                      value={reviewSeverity}
                      onChange={(event) => setReviewSeverity(event.target.value as typeof reviewSeverity)}
                      className="h-9 rounded-md border border-border bg-background px-2 text-sm"
                    >
                      <option value="critical">Critical</option>
                      <option value="high">High</option>
                      <option value="medium">Medium</option>
                      <option value="low">Low</option>
                    </select>
                    <Input value={reviewCategory} onChange={(event) => setReviewCategory(event.target.value)} placeholder="Category" />
                    <Input value={reviewTitle} onChange={(event) => setReviewTitle(event.target.value)} placeholder="Finding title" className="md:col-span-2" />
                    <Textarea value={reviewDetail} onChange={(event) => setReviewDetail(event.target.value)} placeholder="Detail" className="md:col-span-2" />
                    <Textarea value={reviewRequiredAction} onChange={(event) => setReviewRequiredAction(event.target.value)} placeholder="Required action" className="md:col-span-2" />
                    <Textarea value={reviewEvidence} onChange={(event) => setReviewEvidence(event.target.value)} placeholder="Evidence links (one per line)" className="md:col-span-2" />
                    <Textarea value={reviewOwnerNextAction} onChange={(event) => setReviewOwnerNextAction(event.target.value)} placeholder="Owner-facing exact next action" className="md:col-span-2" />
                    <div className="md:col-span-2 flex gap-2">
                      <Button
                        size="sm"
                        onClick={() => reviewReturnMutation.mutate()}
                        disabled={
                          reviewReturnMutation.isPending
                          || !reviewTitle.trim()
                          || !reviewDetail.trim()
                          || !reviewRequiredAction.trim()
                          || !reviewOwnerNextAction.trim()
                        }
                      >
                        {reviewReturnMutation.isPending ? "Returning…" : "Write findings and return"}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setShowReviewReturnForm(false)}>Cancel</Button>
                    </div>
                  </div>
                ) : null}
              </SectionCard>
            ) : null}

            {reviewFindingsDoc && reviewFindingsDoc.document.resolutionState === "open" ? (
              <SectionCard title="Review resubmit" subtitle="The continuity owner explicitly marks findings addressed and reopens the same gate.">
                {showResubmitForm ? (
                  <div className="grid gap-2 md:grid-cols-2">
                    <Textarea value={resubmitResponseNote} onChange={(event) => setResubmitResponseNote(event.target.value)} placeholder="Owner response note" className="md:col-span-2" />
                    <Textarea value={checkpointCurrentState} onChange={(event) => setCheckpointCurrentState(event.target.value)} placeholder="Updated current state (optional checkpoint)" className="md:col-span-2" />
                    <Textarea value={checkpointNextAction} onChange={(event) => setCheckpointNextAction(event.target.value)} placeholder="Updated next action (optional checkpoint)" className="md:col-span-2" />
                    <div className="md:col-span-2 flex gap-2">
                      <Button
                        size="sm"
                        onClick={() => reviewResubmitMutation.mutate()}
                        disabled={reviewResubmitMutation.isPending}
                      >
                        {reviewResubmitMutation.isPending ? "Resubmitting…" : "Mark addressed and resubmit"}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setShowResubmitForm(false)}>Cancel</Button>
                    </div>
                  </div>
                ) : null}
              </SectionCard>
            ) : null}

            {state.branchRole === "branch" ? (
              <SectionCard title="Branch return" subtitle="Return branch output through a typed artifact before the parent can merge anything.">
                {branchReturnDoc ? (
                  <div className="space-y-1 text-xs">
                    <p className="text-muted-foreground">{branchReturnDoc.document.resultSummary}</p>
                    <p>
                      <span className="font-medium text-foreground">Proposed parent updates:</span>{" "}
                      {branchReturnDoc.document.proposedParentUpdates.map((update) => update.documentKey).join(", ") || "none"}
                    </p>
                  </div>
                ) : null}
                {showBranchReturnForm && issue.parentId ? (
                  <div className="grid gap-2 md:grid-cols-2">
                    <Textarea value={branchReturnPurposeScopeRecap} onChange={(event) => setBranchReturnPurposeScopeRecap(event.target.value)} placeholder="Purpose / scope recap" className="md:col-span-2" />
                    <Textarea value={branchReturnResultSummary} onChange={(event) => setBranchReturnResultSummary(event.target.value)} placeholder="Returned result summary" className="md:col-span-2" />
                    <select
                      value={branchReturnDocKey}
                      onChange={(event) => setBranchReturnDocKey(event.target.value)}
                      className="h-9 rounded-md border border-border bg-background px-2 text-sm"
                    >
                      <option value="spec">spec</option>
                      <option value="plan">plan</option>
                      <option value="runbook">runbook</option>
                      <option value="progress">progress</option>
                      <option value="test-plan">test-plan</option>
                      <option value="handoff">handoff</option>
                    </select>
                    <select
                      value={branchReturnDocAction}
                      onChange={(event) => setBranchReturnDocAction(event.target.value as "replace" | "append")}
                      className="h-9 rounded-md border border-border bg-background px-2 text-sm"
                    >
                      <option value="append">append</option>
                      <option value="replace">replace</option>
                    </select>
                    <Input value={branchReturnDocSummary} onChange={(event) => setBranchReturnDocSummary(event.target.value)} placeholder="Proposed update summary" className="md:col-span-2" />
                    <Textarea value={branchReturnDocContent} onChange={(event) => setBranchReturnDocContent(event.target.value)} placeholder="Proposed parent document content" className="md:col-span-2" />
                    <Textarea value={branchReturnChecklist} onChange={(event) => setBranchReturnChecklist(event.target.value)} placeholder="Merge checklist (one per line)" className="md:col-span-2" />
                    <Textarea value={branchReturnRisks} onChange={(event) => setBranchReturnRisks(event.target.value)} placeholder="Unresolved risks (one per line)" className="md:col-span-2" />
                    <Textarea value={branchReturnQuestions} onChange={(event) => setBranchReturnQuestions(event.target.value)} placeholder="Open questions (one per line)" className="md:col-span-2" />
                    <Textarea value={branchReturnEvidence} onChange={(event) => setBranchReturnEvidence(event.target.value)} placeholder="Evidence links (one per line)" className="md:col-span-2" />
                    <Textarea value={branchReturnArtifacts} onChange={(event) => setBranchReturnArtifacts(event.target.value)} placeholder="Returned artifacts (one per line)" className="md:col-span-2" />
                    <div className="md:col-span-2 flex gap-2">
                      <Button
                        size="sm"
                        onClick={() => branchReturnMutation.mutate()}
                        disabled={branchReturnMutation.isPending || !branchReturnPurposeScopeRecap.trim() || !branchReturnResultSummary.trim()}
                      >
                        {branchReturnMutation.isPending ? "Returning…" : "Write branch return"}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setShowBranchReturnForm(false)}>Cancel</Button>
                    </div>
                  </div>
                ) : null}
              </SectionCard>
            ) : null}

            {returnedBranches.length > 0 ? (
              <SectionCard title="Returned branches" subtitle="Preview returned artifacts and confirm parent updates explicitly.">
                <div className="flex flex-wrap gap-2">
                  {returnedBranches.map((branch) => (
                    <Button
                      key={branch.id}
                      size="sm"
                      variant={selectedMergeBranchId === branch.id ? "default" : "outline"}
                      onClick={() => setSelectedMergeBranchId(branch.id)}
                    >
                      Review {branch.identifier ?? branch.id.slice(0, 8)}
                    </Button>
                  ))}
                </div>

                {selectedMergeBranchId && mergePreviewQuery.isLoading ? (
                  <p className="text-xs text-muted-foreground">Loading merge preview…</p>
                ) : null}

                {selectedMergeBranchId && mergePreviewQuery.data ? (
                  <div className="space-y-3">
                    <div className="text-xs text-muted-foreground">
                      {mergePreviewQuery.data.canMerge
                        ? "Select which proposed parent updates to apply."
                        : mergePreviewQuery.data.blockedReason ?? "Merge is blocked."}
                    </div>

                    {mergePreviewQuery.data.proposedUpdates.length > 0 ? (
                      <div className="space-y-2">
                        {mergePreviewQuery.data.proposedUpdates.map((update, index) => {
                          const checked = selectedMergeKeys.includes(update.documentKey);
                          return (
                            <div key={`${update.documentKey}-${index}`} className="rounded-md border border-border/70 p-3 space-y-2">
                              <div className="flex items-start gap-2">
                                <Checkbox
                                  checked={checked}
                                  onCheckedChange={(value) => {
                                    setSelectedMergeKeys((current) => {
                                      if (value) {
                                        return current.includes(update.documentKey) ? current : [...current, update.documentKey];
                                      }
                                      return current.filter((key) => key !== update.documentKey);
                                    });
                                  }}
                                />
                                <div className="space-y-1">
                                  <div className="text-xs font-medium text-foreground">
                                    {update.documentKey} · {update.action}
                                  </div>
                                  <p className="text-xs text-muted-foreground">{update.summary}</p>
                                  <pre className="max-h-48 overflow-auto rounded bg-muted/40 p-2 text-[11px] whitespace-pre-wrap">
                                    {update.content}
                                  </pre>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">This branch return proposed no parent document updates.</p>
                    )}

                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        onClick={() => mergeBranchMutation.mutate(mergePreviewQuery.data)}
                        disabled={mergeBranchMutation.isPending || !mergePreviewQuery.data.canMerge}
                      >
                        {mergeBranchMutation.isPending ? "Merging…" : "Confirm merge"}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setSelectedMergeBranchId(null)}>Close preview</Button>
                    </div>
                  </div>
                ) : null}
              </SectionCard>
            ) : null}
          </div>
        ) : null}
      </SectionCard>

      <SectionCard title="Details" subtitle="Continuity metadata and low-level diagnostics.">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs text-muted-foreground">
            Required docs, timestamps, health details, and actor eligibility.
          </div>
          <Button
            size="sm"
            variant="outline"
            data-testid="continuity-details-toggle"
            onClick={() => setShowDetails((value) => !value)}
          >
            {showDetails ? "Hide details" : "Show details"}
          </Button>
        </div>

        {showDetails ? (
          <div data-testid="continuity-details-panel" className="space-y-3">
            <div className="grid gap-3 text-xs text-muted-foreground md:grid-cols-2">
              <div>
                <span className="font-medium text-foreground">Required docs:</span> {state.requiredDocumentKeys.join(", ")}
              </div>
              <div>
                <span className="font-medium text-foreground">Missing docs:</span>{" "}
                {state.missingDocumentKeys.length > 0 ? state.missingDocumentKeys.join(", ") : "none"}
              </div>
              <div>
                <span className="font-medium text-foreground">Spec state:</span> {state.specState.replaceAll("_", " ")}
              </div>
              <div>
                <span className="font-medium text-foreground">Ready gate:</span> {readyToExecute ? "open" : "blocked"}
              </div>
              <div>
                <span className="font-medium text-foreground">Last progress:</span>{" "}
                {state.lastProgressAt ? relativeTime(state.lastProgressAt) : "none"}
              </div>
              <div>
                <span className="font-medium text-foreground">Last handoff:</span>{" "}
                {state.lastHandoffAt ? relativeTime(state.lastHandoffAt) : "none"}
              </div>
              <div>
                <span className="font-medium text-foreground">Last review return:</span>{" "}
                {state.lastReviewReturnAt ? relativeTime(state.lastReviewReturnAt) : "none"}
              </div>
              <div>
                <span className="font-medium text-foreground">Last branch return:</span>{" "}
                {state.lastBranchReturnAt ? relativeTime(state.lastBranchReturnAt) : "none"}
              </div>
              <div>
                <span className="font-medium text-foreground">Open decisions:</span>{" "}
                {state.openDecisionQuestionCount ?? 0}
                {state.blockingDecisionQuestionCount ? ` (${state.blockingDecisionQuestionCount} blocking)` : ""}
              </div>
              <div>
                <span className="font-medium text-foreground">Plan approval:</span>{" "}
                {planApprovalStatusLabel(planApproval).toLowerCase()}
              </div>
              <div>
                <span className="font-medium text-foreground">Last answered decision:</span>{" "}
                {state.lastDecisionAnswerAt ? relativeTime(state.lastDecisionAnswerAt) : "none"}
              </div>
            </div>

            {state.healthReason || (state.healthDetails?.length ?? 0) > 0 ? (
              <div className="space-y-1 text-xs text-muted-foreground">
                <div className="font-medium text-foreground">Health details</div>
                {(state.healthDetails ?? []).map((detail) => (
                  <div key={detail}>{detail}</div>
                ))}
              </div>
            ) : null}

            {handoffDoc ? (
              <div className="space-y-1 text-xs">
                <div className="font-medium text-foreground">Latest handoff</div>
                <p className="text-muted-foreground">Target: {handoffDoc.document.transferTarget}</p>
                <p className="text-muted-foreground">Next: {handoffDoc.document.exactNextAction}</p>
              </div>
            ) : null}

            {state.unresolvedBranchIssueIds.length > 0 ? (
              <div className="space-y-1 text-xs">
                <div className="font-medium text-foreground">Unresolved branches</div>
                <div className="flex flex-wrap gap-2">
                  {state.unresolvedBranchIssueIds.map((branchId) => {
                    const branchIssue = childIssuesById.get(branchId);
                    return (
                      <Link
                        key={branchId}
                        to={`/issues/${branchIssue?.identifier ?? branchId}`}
                        className="rounded-full border border-border px-2 py-0.5 text-xs underline-offset-2 hover:underline"
                      >
                        {branchIssue?.identifier ?? branchId}
                      </Link>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {detailedRemediationActions.length > 0 ? (
              <div className="space-y-2">
                <div className="text-xs font-medium text-foreground">Remediation actor eligibility</div>
                {detailedRemediationActions.map((action, index) => (
                  <ActionRow key={`${action.id}-${index}`} title={action.label} description={action.description}>
                    <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                      Eligible actor: {action.actor.replaceAll("_", " ")}
                    </div>
                    {!action.eligible && action.blockedReason ? (
                      <div className="text-xs text-muted-foreground">{action.blockedReason}</div>
                    ) : null}
                  </ActionRow>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </SectionCard>

      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
