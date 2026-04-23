export type IssueHeartbeatMode = "planning" | "execution" | "review" | "approval";

type ResolveIssueHeartbeatModeInput = {
  issueStatus?: string | null;
  continuityStatus?: string | null;
  planApprovalStatus?: string | null;
  planApprovalRequired?: boolean | null;
  executionStateStatus?: string | null;
  executionStageType?: string | null;
};

export function resolveIssueHeartbeatMode(input: ResolveIssueHeartbeatModeInput): IssueHeartbeatMode {
  if (input.executionStageType === "approval") return "approval";
  if (
    input.planApprovalRequired === true ||
    input.planApprovalStatus === "pending" ||
    input.planApprovalStatus === "revision_requested"
  ) {
    return "approval";
  }

  if (input.executionStageType === "review") return "review";
  if (input.issueStatus === "in_review" || input.executionStateStatus === "changes_requested") {
    return "review";
  }

  if (input.issueStatus === "backlog" || input.issueStatus === "todo") {
    return "planning";
  }

  if (
    input.continuityStatus === "draft" ||
    input.continuityStatus === "planning" ||
    input.continuityStatus === "ready" ||
    input.continuityStatus === "awaiting_decision" ||
    input.continuityStatus === "blocked_missing_docs" ||
    input.continuityStatus === "handoff_pending"
  ) {
    return "planning";
  }

  return "execution";
}
