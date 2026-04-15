import type { IssueContinuityState, IssueContinuitySummary } from "@paperclipai/shared";
import { issueContinuityStateSchema } from "@paperclipai/shared";
import { parseIssueExecutionState } from "./issue-execution-policy.js";

function normalizeContinuityState(value: unknown): IssueContinuityState | null {
  const parsed = issueContinuityStateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function buildIssueContinuitySummary(input: {
  continuityState?: unknown;
  executionState?: unknown;
}): IssueContinuitySummary | null {
  const continuityState = normalizeContinuityState(input.continuityState ?? null);
  if (!continuityState) return null;

  const executionState = parseIssueExecutionState(input.executionState ?? null);

  return {
    tier: continuityState.tier ?? null,
    status: continuityState.status ?? null,
    health: continuityState.health ?? null,
    specState: continuityState.specState ?? null,
    missingDocumentCount: continuityState.missingDocumentKeys.length,
    activeGatePresent:
      executionState?.status === "pending" &&
      (executionState.currentStageType === "review" || executionState.currentStageType === "approval") &&
      executionState.currentParticipant != null,
    openReviewFindings: Boolean(continuityState.openReviewFindingsRevisionId),
    returnedBranchCount: continuityState.returnedBranchIssueIds?.length ?? 0,
  };
}
