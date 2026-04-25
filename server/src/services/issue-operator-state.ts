import type { IssueContinuitySummary, IssueOperatorState, IssueOperatorWaitTarget, IssueStatus } from "@paperclipai/shared";

type ActiveRunLike = {
  id: string;
  status: string;
} | null | undefined;

type IssueOperatorStateInput = {
  issueId: string;
  status: IssueStatus;
  hiddenAt?: Date | null;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  continuitySummary?: IssueContinuitySummary | null;
  activeRun?: ActiveRunLike;
};

export function buildIssueOperatorState(
  input: IssueOperatorStateInput,
): {
  operatorState: IssueOperatorState;
  operatorReason: string;
  operatorWaitTargets: IssueOperatorWaitTarget[];
} {
  if (input.hiddenAt || input.status === "done" || input.status === "cancelled") {
    return {
      operatorState: "archived",
      operatorReason: input.status === "done" ? "Issue is complete" : "Issue is archived or cancelled",
      operatorWaitTargets: [],
    };
  }

  if (input.activeRun?.status === "running") {
    return {
      operatorState: "running",
      operatorReason: "Issue has an active execution run",
      operatorWaitTargets: [{ type: "run", id: input.activeRun.id, label: "Active run" }],
    };
  }

  if (input.activeRun?.status === "queued" || input.activeRun?.status === "scheduled_retry") {
    return {
      operatorState: "queued_followup",
      operatorReason: "Issue already has queued follow-up execution",
      operatorWaitTargets: [{ type: "run", id: input.activeRun.id, label: "Queued run" }],
    };
  }

  const continuity = input.continuitySummary;
  if ((continuity?.blockingDecisionQuestions ?? 0) > 0) {
    return {
      operatorState: "decision_blocked",
      operatorReason: "Issue is waiting on a blocking decision question",
      operatorWaitTargets: [{
        type: "decision_question",
        id: input.issueId,
        label: `${continuity?.blockingDecisionQuestions ?? 0} blocking question(s)`,
      }],
    };
  }

  if (continuity?.activeGatePresent || input.status === "in_review") {
    return {
      operatorState: "review_waiting",
      operatorReason: "Issue is waiting on review or approval",
      operatorWaitTargets: [],
    };
  }

  if (
    continuity?.health === "missing_required_docs"
    || continuity?.health === "invalid_handoff"
    || continuity?.health === "stale_progress"
    || (continuity?.missingDocumentCount ?? 0) > 0
  ) {
    return {
      operatorState: "continuity_blocked",
      operatorReason: "Issue continuity artifacts need repair before execution can safely continue",
      operatorWaitTargets: [],
    };
  }

  if (input.status === "blocked") {
    return {
      operatorState: "dependency_blocked",
      operatorReason: "Issue is blocked on an external dependency or prerequisite",
      operatorWaitTargets: [],
    };
  }

  const hasAssignee = Boolean(input.assigneeAgentId || input.assigneeUserId);
  if (hasAssignee && (input.status === "todo" || input.status === "in_progress")) {
    return {
      operatorState: "idle_active",
      operatorReason: "Issue is active but no agent run is queued or running.",
      operatorWaitTargets: [],
    };
  }

  return {
    operatorState: "ready",
    operatorReason: "Issue is ready for active work",
    operatorWaitTargets: [],
  };
}
