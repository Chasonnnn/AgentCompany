import type { Issue, IssueOperatorState } from "@paperclipai/shared";
import { timeAgo } from "./timeAgo";

const ISSUE_OPERATOR_STATE_LABELS: Record<IssueOperatorState, string> = {
  ready: "Ready",
  idle_active: "Idle",
  running: "Live",
  queued_followup: "Queued",
  decision_blocked: "Needs decision",
  dependency_blocked: "Dependency blocked",
  continuity_blocked: "Continuity blocked",
  budget_blocked: "Budget blocked",
  review_waiting: "In review",
  archived: "Archived",
};

export function formatIssueOperatorStateLabel(state: IssueOperatorState): string {
  return ISSUE_OPERATOR_STATE_LABELS[state];
}

export function resolveIssueOperatorState(
  issue: Pick<Issue, "operatorState">,
  options?: { isLiveFallback?: boolean },
): IssueOperatorState | null {
  if (issue.operatorState) return issue.operatorState;
  return options?.isLiveFallback ? "running" : null;
}

export function describeIssueActivity(
  issue: Pick<Issue, "updatedAt" | "lastActivityAt" | "lastExternalCommentAt" | "operatorState" | "operatorReason">,
  options?: { isLiveFallback?: boolean },
): string {
  const updatedText = `Updated ${timeAgo(issue.lastActivityAt ?? issue.lastExternalCommentAt ?? issue.updatedAt)}`;
  const operatorState = resolveIssueOperatorState(issue, options);
  if (!operatorState || operatorState === "ready") return updatedText;

  const reason = issue.operatorReason?.trim();
  if (reason) return `${formatIssueOperatorStateLabel(operatorState)} · ${reason}`;

  if (operatorState === "running") {
    return "Live · work is actively running";
  }

  if (operatorState === "idle_active") {
    return "Idle · issue is active but no agent run is queued or running";
  }

  return `${formatIssueOperatorStateLabel(operatorState)} · ${updatedText}`;
}
