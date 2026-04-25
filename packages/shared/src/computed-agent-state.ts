import type { IssueOperatorState } from "./constants.js";

export const COMPUTED_AGENT_STATES = [
  "idle",
  "queued",
  "dependency_blocked",
  "running",
] as const;

export type ComputedAgentState = (typeof COMPUTED_AGENT_STATES)[number];

export type ComputedAgentStateCoverageMiss = {
  detailed: string;
  fallback: ComputedAgentState;
};

export type GroupOperatorStateOptions = {
  onCoverageMiss?: (miss: ComputedAgentStateCoverageMiss) => void;
};

const GROUPING: Record<IssueOperatorState, ComputedAgentState> = {
  ready: "queued",
  idle_active: "idle",
  queued_followup: "queued",
  running: "running",
  dependency_blocked: "dependency_blocked",
  decision_blocked: "dependency_blocked",
  continuity_blocked: "dependency_blocked",
  budget_blocked: "dependency_blocked",
  review_waiting: "dependency_blocked",
  archived: "idle",
};

export function groupOperatorState(
  detailed: IssueOperatorState | string | null | undefined,
  options?: GroupOperatorStateOptions,
): ComputedAgentState {
  if (!detailed) return "idle";
  const mapped = GROUPING[detailed as IssueOperatorState];
  if (mapped) return mapped;
  options?.onCoverageMiss?.({ detailed, fallback: "idle" });
  return "idle";
}

const LABELS: Record<ComputedAgentState, string> = {
  idle: "Idle",
  queued: "Queued",
  dependency_blocked: "Dependency blocked",
  running: "Running",
};

export function formatComputedAgentStateLabel(state: ComputedAgentState): string {
  return LABELS[state];
}

export type ComputedAgentWaitingOn = {
  issueId: string;
  identifier: string | null;
  openChildCount: number;
  nextWakeReason: string | null;
};
