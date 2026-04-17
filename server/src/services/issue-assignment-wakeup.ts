import { logger } from "../middleware/logger.js";

type WakeupTriggerDetail = "manual" | "ping" | "callback" | "system";
type WakeupSource = "timer" | "assignment" | "on_demand" | "automation";
type IssueContinuityWakeState = {
  status?: string | null;
  health?: string | null;
};

export interface IssueAssignmentWakeupDeps {
  wakeup: (
    agentId: string,
    opts: {
      source?: WakeupSource;
      triggerDetail?: WakeupTriggerDetail;
      reason?: string | null;
      payload?: Record<string, unknown> | null;
      requestedByActorType?: "user" | "agent" | "system";
      requestedByActorId?: string | null;
      contextSnapshot?: Record<string, unknown>;
    },
  ) => Promise<unknown>;
}

export function isIssueWakeBlockedByContinuity(continuityState?: IssueContinuityWakeState | null) {
  if (!continuityState) return false;
  if (continuityState.status === "planning") {
    return continuityState.health === "invalid_handoff";
  }
  return (
    continuityState.health === "invalid_handoff" ||
    continuityState.status === "awaiting_decision" ||
    continuityState.status === "blocked_missing_docs" ||
    continuityState.status === "handoff_pending"
  );
}

export function shouldWakeAssignedAgentForIssue(input: {
  issue: { assigneeAgentId: string | null; status: string };
  continuityState?: IssueContinuityWakeState | null;
}) {
  if (!input.issue.assigneeAgentId || input.issue.status === "backlog") return false;
  return !isIssueWakeBlockedByContinuity(input.continuityState ?? null);
}

export function queueIssueAssignmentWakeup(input: {
  heartbeat: IssueAssignmentWakeupDeps;
  issue: { id: string; assigneeAgentId: string | null; status: string };
  continuityState?: IssueContinuityWakeState | null;
  reason: string;
  mutation: string;
  contextSource: string;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  rethrowOnError?: boolean;
}) {
  if (!shouldWakeAssignedAgentForIssue({ issue: input.issue, continuityState: input.continuityState })) return;
  const assigneeAgentId = input.issue.assigneeAgentId;
  if (!assigneeAgentId) return;

  return input.heartbeat
    .wakeup(assigneeAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: input.reason,
      payload: { issueId: input.issue.id, mutation: input.mutation },
      requestedByActorType: input.requestedByActorType,
      requestedByActorId: input.requestedByActorId ?? null,
      contextSnapshot: { issueId: input.issue.id, source: input.contextSource },
    })
    .catch((err) => {
      logger.warn({ err, issueId: input.issue.id }, "failed to wake assignee on issue assignment");
      if (input.rethrowOnError) throw err;
      return null;
    });
}
