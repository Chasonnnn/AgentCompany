import type {
  Approval,
  AnswerIssueDecisionQuestion,
  ConferenceContext,
  CreateIssueTreeHold,
  DocumentRevision,
  DismissIssueDecisionQuestion,
  IssueBranchMergePreview,
  IssueBranchReturnDocument,
  IssueContinuityRemediation,
  IssueDecisionQuestion,
  IssueDecisionQuestionListItem,
  FeedbackTargetType,
  FeedbackTrace,
  FeedbackVote,
  Issue,
  IssueAttachment,
  AskUserQuestionsAnswer,
  IssueContinuityBundle,
  IssueContinuityState,
  IssueCostSummary,
  IssueComment,
  IssueDocument,
  IssueExecutionStagePrincipal,
  IssueLabel,
  IssueThreadInteraction,
  IssueTreeControlPreview,
  IssueTreeHold,
  IssueWorkProduct,
  PromoteIssueReviewFindingSkill,
  PreviewIssueTreeControl,
  ReleaseIssueTreeHold,
  UpsertIssueDocument,
} from "@paperclipai/shared";
import { api } from "./client";

export type IssueUpdateResponse = Issue & {
  comment?: IssueComment | null;
};

export interface IssueContinuityResponse {
  issueId: string;
  continuityState: IssueContinuityState;
  continuityBundle: IssueContinuityBundle;
  continuityOwner: {
    assigneeAgentId: string | null;
    assigneeUserId: string | null;
  };
  activeGateParticipant: IssueExecutionStagePrincipal | null;
  remediation: IssueContinuityRemediation;
}

type AnswerIssueDecisionQuestionRequest =
  Omit<AnswerIssueDecisionQuestion, "escalateToApproval">
  & { escalateToApproval?: boolean };

export const issuesApi = {
  list: (
    companyId: string,
    filters?: {
      status?: string;
      projectId?: string;
      parentId?: string;
      assigneeAgentId?: string;
      participantAgentId?: string;
      assigneeUserId?: string;
      touchedByUserId?: string;
      inboxArchivedByUserId?: string;
      unreadForUserId?: string;
      labelId?: string;
      workspaceId?: string;
      executionWorkspaceId?: string;
      originKind?: string;
      originId?: string;
      descendantOf?: string;
      includeRoutineExecutions?: boolean;
      q?: string;
      limit?: number;
      offset?: number;
    },
  ) => {
    const params = new URLSearchParams();
    if (filters?.status) params.set("status", filters.status);
    if (filters?.projectId) params.set("projectId", filters.projectId);
    if (filters?.parentId) params.set("parentId", filters.parentId);
    if (filters?.assigneeAgentId) params.set("assigneeAgentId", filters.assigneeAgentId);
    if (filters?.participantAgentId) params.set("participantAgentId", filters.participantAgentId);
    if (filters?.assigneeUserId) params.set("assigneeUserId", filters.assigneeUserId);
    if (filters?.touchedByUserId) params.set("touchedByUserId", filters.touchedByUserId);
    if (filters?.inboxArchivedByUserId) params.set("inboxArchivedByUserId", filters.inboxArchivedByUserId);
    if (filters?.unreadForUserId) params.set("unreadForUserId", filters.unreadForUserId);
    if (filters?.labelId) params.set("labelId", filters.labelId);
    if (filters?.workspaceId) params.set("workspaceId", filters.workspaceId);
    if (filters?.executionWorkspaceId) params.set("executionWorkspaceId", filters.executionWorkspaceId);
    if (filters?.originKind) params.set("originKind", filters.originKind);
    if (filters?.originId) params.set("originId", filters.originId);
    if (filters?.descendantOf) params.set("descendantOf", filters.descendantOf);
    if (filters?.includeRoutineExecutions) params.set("includeRoutineExecutions", "true");
    if (filters?.q) params.set("q", filters.q);
    if (filters?.limit) params.set("limit", String(filters.limit));
    if (filters?.offset !== undefined) params.set("offset", String(filters.offset));
    const qs = params.toString();
    return api.get<Issue[]>(`/companies/${companyId}/issues${qs ? `?${qs}` : ""}`);
  },
  listLabels: (companyId: string) => api.get<IssueLabel[]>(`/companies/${companyId}/labels`),
  createLabel: (companyId: string, data: { name: string; color: string }) =>
    api.post<IssueLabel>(`/companies/${companyId}/labels`, data),
  deleteLabel: (id: string) => api.delete<IssueLabel>(`/labels/${id}`),
  get: (id: string) => api.get<Issue>(`/issues/${id}`),
  getContinuity: (id: string) => api.get<IssueContinuityResponse>(`/issues/${id}/continuity`),
  listQuestions: (id: string) => api.get<IssueDecisionQuestion[]>(`/issues/${id}/questions`),
  listOpenQuestions: (companyId: string, limit = 25) =>
    api.get<IssueDecisionQuestionListItem[]>(
      `/companies/${companyId}/issue-questions?status=open&limit=${encodeURIComponent(String(limit))}`,
    ),
  createQuestion: (
    id: string,
    data: {
      title: string;
      question: string;
      whyBlocked?: string | null;
      blocking?: boolean;
      recommendedOptions?: Array<{
        key: string;
        label: string;
        description?: string | null;
      }>;
      suggestedDefault?: string | null;
      linkedApprovalId?: string | null;
    },
  ) =>
    api.post<{
      question: IssueDecisionQuestion;
      continuityState: IssueContinuityState;
      continuityBundle: IssueContinuityBundle;
    }>(`/issues/${id}/questions`, data),
  answerQuestion: (
    questionId: string,
    data: AnswerIssueDecisionQuestionRequest,
  ) =>
    api.post<{
      question: IssueDecisionQuestion;
      continuityState: IssueContinuityState;
      continuityBundle: IssueContinuityBundle;
      shouldEscalateToApproval?: boolean;
    }>(`/questions/${questionId}/answer`, data),
  dismissQuestion: (questionId: string, data: DismissIssueDecisionQuestion) =>
    api.post<{
      question: IssueDecisionQuestion;
      continuityState: IssueContinuityState;
      continuityBundle: IssueContinuityBundle;
    }>(`/questions/${questionId}/dismiss`, data),
  escalateQuestionApproval: (
    questionId: string,
    data: {
      summary?: string | null;
      recommendedAction?: string | null;
      nextActionOnApproval?: string | null;
      risks?: string[];
      proposedComment?: string | null;
    },
  ) =>
    api.post<{
      question: IssueDecisionQuestion;
      approvalId: string;
      continuityState: IssueContinuityState;
      continuityBundle: IssueContinuityBundle;
    }>(`/questions/${questionId}/escalate-approval`, data),
  markRead: (id: string) => api.post<{ id: string; lastReadAt: Date }>(`/issues/${id}/read`, {}),
  markUnread: (id: string) => api.delete<{ id: string; removed: boolean }>(`/issues/${id}/read`),
  archiveFromInbox: (id: string) =>
    api.post<{ id: string; archivedAt: Date }>(`/issues/${id}/inbox-archive`, {}),
  unarchiveFromInbox: (id: string) =>
    api.delete<{ id: string; archivedAt: Date } | { ok: true }>(`/issues/${id}/inbox-archive`),
  create: (companyId: string, data: Record<string, unknown>) =>
    api.post<Issue>(`/companies/${companyId}/issues`, data),
  update: (id: string, data: Record<string, unknown>) =>
    api.patch<IssueUpdateResponse>(`/issues/${id}`, data),
  previewTreeControl: (id: string, data: PreviewIssueTreeControl) =>
    api.post<IssueTreeControlPreview>(`/issues/${id}/tree-control/preview`, data),
  createTreeHold: (id: string, data: CreateIssueTreeHold) =>
    api.post<{ hold: IssueTreeHold; preview: IssueTreeControlPreview }>(`/issues/${id}/tree-holds`, data),
  getTreeHold: (id: string, holdId: string) =>
    api.get<IssueTreeHold>(`/issues/${id}/tree-holds/${holdId}`),
  listTreeHolds: (
    id: string,
    filters?: {
      status?: "active" | "released";
      mode?: "pause" | "resume" | "cancel" | "restore";
      includeMembers?: boolean;
    },
  ) => {
    const params = new URLSearchParams();
    if (filters?.status) params.set("status", filters.status);
    if (filters?.mode) params.set("mode", filters.mode);
    if (filters?.includeMembers) params.set("includeMembers", "true");
    const qs = params.toString();
    return api.get<IssueTreeHold[]>(`/issues/${id}/tree-holds${qs ? `?${qs}` : ""}`);
  },
  getTreeControlState: (id: string) =>
    api.get<{
      activePauseHold: {
        holdId: string;
        rootIssueId: string;
        issueId: string;
        isRoot: boolean;
        mode: "pause";
        reason: string | null;
        releasePolicy: { strategy: "manual" | "after_active_runs_finish"; note?: string | null } | null;
      } | null;
    }>(`/issues/${id}/tree-control/state`),
  releaseTreeHold: (id: string, holdId: string, data: ReleaseIssueTreeHold) =>
    api.post<IssueTreeHold>(`/issues/${id}/tree-holds/${holdId}/release`, data),
  remove: (id: string) => api.delete<Issue>(`/issues/${id}`),
  checkout: (id: string, agentId: string) =>
    api.post<Issue>(`/issues/${id}/checkout`, {
      agentId,
      expectedStatuses: ["todo", "backlog", "blocked", "in_review"],
    }),
  release: (id: string) => api.post<Issue>(`/issues/${id}/release`, {}),
  listComments: (
    id: string,
    filters?: {
      after?: string;
      order?: "asc" | "desc";
      limit?: number;
    },
  ) => {
    const params = new URLSearchParams();
    if (filters?.after) params.set("after", filters.after);
    if (filters?.order) params.set("order", filters.order);
    if (filters?.limit) params.set("limit", String(filters.limit));
    const qs = params.toString();
    return api.get<IssueComment[]>(`/issues/${id}/comments${qs ? `?${qs}` : ""}`);
  },
  listInteractions: (id: string) =>
    api.get<IssueThreadInteraction[]>(`/issues/${id}/interactions`),
  createInteraction: (id: string, data: Record<string, unknown>) =>
    api.post<IssueThreadInteraction>(`/issues/${id}/interactions`, data),
  acceptInteraction: (
    id: string,
    interactionId: string,
    data?: { selectedClientKeys?: string[] },
  ) =>
    api.post<IssueThreadInteraction>(`/issues/${id}/interactions/${interactionId}/accept`, data ?? {}),
  rejectInteraction: (id: string, interactionId: string, reason?: string) =>
    api.post<IssueThreadInteraction>(`/issues/${id}/interactions/${interactionId}/reject`, reason ? { reason } : {}),
  cancelInteraction: (id: string, interactionId: string, reason?: string) =>
    api.post<IssueThreadInteraction>(`/issues/${id}/interactions/${interactionId}/cancel`, reason ? { reason } : {}),
  respondToInteraction: (
    id: string,
    interactionId: string,
    data: { answers: AskUserQuestionsAnswer[]; summaryMarkdown?: string | null },
  ) =>
    api.post<IssueThreadInteraction>(`/issues/${id}/interactions/${interactionId}/respond`, data),
  getComment: (id: string, commentId: string) =>
    api.get<IssueComment>(`/issues/${id}/comments/${commentId}`),
  listFeedbackVotes: (id: string) => api.get<FeedbackVote[]>(`/issues/${id}/feedback-votes`),
  getCostSummary: (id: string) => api.get<IssueCostSummary>(`/issues/${id}/cost-summary`),
  listFeedbackTraces: (id: string, filters?: Record<string, string | boolean | undefined>) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters ?? {})) {
      if (value === undefined) continue;
      params.set(key, String(value));
    }
    const qs = params.toString();
    return api.get<FeedbackTrace[]>(`/issues/${id}/feedback-traces${qs ? `?${qs}` : ""}`);
  },
  upsertFeedbackVote: (
    id: string,
    data: {
      targetType: FeedbackTargetType;
      targetId: string;
      vote: "up" | "down";
      reason?: string;
      allowSharing?: boolean;
    },
  ) => api.post<FeedbackVote>(`/issues/${id}/feedback-votes`, data),
  addComment: (id: string, body: string, reopen?: boolean, interrupt?: boolean) =>
    api.post<IssueComment>(
      `/issues/${id}/comments`,
      {
        body,
        ...(reopen === undefined ? {} : { reopen }),
        ...(interrupt === undefined ? {} : { interrupt }),
      },
    ),
  listDocuments: (id: string, options?: { includeSystem?: boolean }) =>
    api.get<IssueDocument[]>(
      `/issues/${id}/documents${options?.includeSystem ? "?includeSystem=true" : ""}`,
    ),
  getDocument: (id: string, key: string) => api.get<IssueDocument>(`/issues/${id}/documents/${encodeURIComponent(key)}`),
  upsertDocument: (id: string, key: string, data: UpsertIssueDocument) =>
    api.put<IssueDocument>(`/issues/${id}/documents/${encodeURIComponent(key)}`, data),
  listDocumentRevisions: (id: string, key: string) =>
    api.get<DocumentRevision[]>(`/issues/${id}/documents/${encodeURIComponent(key)}/revisions`),
  restoreDocumentRevision: (id: string, key: string, revisionId: string) =>
    api.post<IssueDocument>(`/issues/${id}/documents/${encodeURIComponent(key)}/revisions/${revisionId}/restore`, {}),
  deleteDocument: (id: string, key: string) =>
    api.delete<{ ok: true }>(`/issues/${id}/documents/${encodeURIComponent(key)}`),
  prepareContinuity: (id: string, data: { tier?: IssueContinuityState["tier"] }) =>
    api.post<{
      continuityState: IssueContinuityState;
      continuityBundle: IssueContinuityBundle;
      planApprovalRequest?: {
        approvalId: string | null;
        approvalStatus: string | null;
      } | null;
    }>(
      `/issues/${id}/continuity/prepare`,
      data,
    ),
  requestPlanApproval: (id: string) =>
    api.post<{
      approvalId: string | null;
      approvalStatus: string | null;
      continuityState: IssueContinuityState;
      continuityBundle: IssueContinuityBundle;
    }>(`/issues/${id}/continuity/plan-approval`, {}),
  addProgressCheckpoint: (
    id: string,
    data: {
      summary?: string | null;
      completed?: string[];
      currentState: string;
      knownPitfalls?: string[];
      nextAction: string;
      openQuestions?: string[];
      evidence?: string[];
    },
  ) =>
    api.post<{ continuityState: IssueContinuityState; continuityBundle: IssueContinuityBundle }>(
      `/issues/${id}/continuity/progress-checkpoint`,
      data,
    ),
  handoffContinuity: (
    id: string,
    data: {
      assigneeAgentId?: string | null;
      assigneeUserId?: string | null;
      reasonCode: string;
      exactNextAction: string;
      unresolvedBranches?: string[];
      openQuestions?: string[];
      evidence?: string[];
    },
  ) =>
    api.post<{ issue: Issue; continuityState: IssueContinuityState; continuityBundle: IssueContinuityBundle }>(
      `/issues/${id}/continuity/handoff`,
      data,
    ),
  repairHandoff: (
    id: string,
    data: {
      reasonCode: string;
      exactNextAction: string;
      unresolvedBranches?: string[];
      openQuestions?: string[];
      evidence?: string[];
    },
  ) =>
    api.post<{ continuityState: IssueContinuityState; continuityBundle: IssueContinuityBundle }>(
      `/issues/${id}/continuity/handoff-repair`,
      data,
    ),
  cancelHandoff: (id: string, data: { reason: string }) =>
    api.post<{ continuityState: IssueContinuityState; continuityBundle: IssueContinuityBundle }>(
      `/issues/${id}/continuity/handoff-cancel`,
      data,
    ),
  reviewReturn: (
    id: string,
    data: {
      decisionContext?: string | null;
      outcome: "changes_requested" | "approved_with_notes" | "blocked";
      findings: Array<{
        severity: "critical" | "high" | "medium" | "low";
        category: string;
        title: string;
        detail: string;
        requiredAction: string;
        evidence?: string[];
      }>;
      ownerNextAction: string;
    },
  ) =>
    api.post<{ issue: Issue; continuityState: IssueContinuityState; continuityBundle: IssueContinuityBundle }>(
      `/issues/${id}/continuity/review-return`,
      data,
    ),
  reviewResubmit: (
    id: string,
    data: {
      responseNote?: string | null;
      progressCheckpoint?: {
        summary?: string | null;
        completed?: string[];
        currentState: string;
        knownPitfalls?: string[];
        nextAction: string;
        openQuestions?: string[];
        evidence?: string[];
      } | null;
    },
  ) =>
    api.post<{ issue: Issue; continuityState: IssueContinuityState; continuityBundle: IssueContinuityBundle }>(
      `/issues/${id}/continuity/review-resubmit`,
      data,
    ),
  promoteReviewFindingSkill: (
    id: string,
    findingId: string,
    data: PromoteIssueReviewFindingSkill,
  ) =>
    api.post<{ hardeningIssue: Issue; continuityState: IssueContinuityState; continuityBundle: IssueContinuityBundle }>(
      `/issues/${id}/continuity/review-findings/${encodeURIComponent(findingId)}/promote-skill`,
      data,
    ),
  requestSpecThaw: (id: string, data: { approvalId?: string | null; reason?: string | null }) =>
    api.post<{ approvalId: string; continuityState: IssueContinuityState; continuityBundle: IssueContinuityBundle }>(
      `/issues/${id}/continuity/spec-thaw`,
      data,
    ),
  mutateContinuityBranch: (
    id: string,
    data:
      | {
          action: "create";
          title: string;
          description?: string | null;
          purpose: string;
          scope: string;
          budget: string;
          expectedReturnArtifact: string;
          mergeCriteria?: string[];
          expiration?: string | null;
          timeout?: string | null;
          assigneeAgentId?: string | null;
          assigneeUserId?: string | null;
          priority?: Issue["priority"];
        }
      | {
          action: "merge";
          branchIssueId: string;
        },
    ) =>
    api.post<
      | { branchIssue: Issue; continuityState: IssueContinuityState; continuityBundle: IssueContinuityBundle }
      | { branchIssueId: string; continuityState: IssueContinuityState; continuityBundle: IssueContinuityBundle }
    >(`/issues/${id}/continuity/branches`, data),
  returnContinuityBranch: (id: string, branchIssueId: string, data: IssueBranchReturnDocument) =>
    api.post<{ branchIssue: Issue; continuityState: IssueContinuityState; continuityBundle: IssueContinuityBundle }>(
      `/issues/${id}/continuity/branches/${branchIssueId}/return`,
      data,
    ),
  getBranchMergePreview: (id: string, branchIssueId: string) =>
    api.get<IssueBranchMergePreview>(`/issues/${id}/continuity/branches/${branchIssueId}/merge-preview`),
  mergeContinuityBranch: (
    id: string,
    branchIssueId: string,
    data: { selectedDocumentKeys?: string[] },
  ) =>
    api.post<{
      branchIssueId: string;
      appliedDocumentKeys: string[];
      deferredDocumentKeys: string[];
      continuityState: IssueContinuityState;
      continuityBundle: IssueContinuityBundle;
    }>(`/issues/${id}/continuity/branches/${branchIssueId}/merge`, data),
  listAttachments: (id: string) => api.get<IssueAttachment[]>(`/issues/${id}/attachments`),
  uploadAttachment: (
    companyId: string,
    issueId: string,
    file: File,
    issueCommentId?: string | null,
  ) => {
    const form = new FormData();
    form.append("file", file);
    if (issueCommentId) {
      form.append("issueCommentId", issueCommentId);
    }
    return api.postForm<IssueAttachment>(`/companies/${companyId}/issues/${issueId}/attachments`, form);
  },
  deleteAttachment: (id: string) => api.delete<{ ok: true }>(`/attachments/${id}`),
  listApprovals: (id: string) => api.get<Approval[]>(`/issues/${id}/approvals`),
  getConferenceContext: (id: string) => api.get<ConferenceContext>(`/issues/${id}/conference-context`),
  linkApproval: (id: string, approvalId: string) =>
    api.post<Approval[]>(`/issues/${id}/approvals`, { approvalId }),
  unlinkApproval: (id: string, approvalId: string) =>
    api.delete<{ ok: true }>(`/issues/${id}/approvals/${approvalId}`),
  listWorkProducts: (id: string) => api.get<IssueWorkProduct[]>(`/issues/${id}/work-products`),
  createWorkProduct: (id: string, data: Record<string, unknown>) =>
    api.post<IssueWorkProduct>(`/issues/${id}/work-products`, data),
  updateWorkProduct: (id: string, data: Record<string, unknown>) =>
    api.patch<IssueWorkProduct>(`/work-products/${id}`, data),
  deleteWorkProduct: (id: string) => api.delete<IssueWorkProduct>(`/work-products/${id}`),
};
