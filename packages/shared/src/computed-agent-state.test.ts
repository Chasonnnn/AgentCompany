import { describe, expect, it, vi } from "vitest";
import { ISSUE_OPERATOR_STATES, type IssueOperatorState } from "./constants.js";
import {
  COMPUTED_AGENT_STATES,
  formatComputedAgentStateLabel,
  groupOperatorState,
  type ComputedAgentState,
} from "./computed-agent-state.js";

describe("groupOperatorState", () => {
  const expected: Record<IssueOperatorState, ComputedAgentState> = {
    ready: "queued",
    queued_followup: "queued",
    running: "running",
    dependency_blocked: "dependency_blocked",
    decision_blocked: "dependency_blocked",
    continuity_blocked: "dependency_blocked",
    budget_blocked: "dependency_blocked",
    review_waiting: "dependency_blocked",
    archived: "idle",
  };

  it("maps every known detailed operator state to a grouped bucket", () => {
    for (const detailed of ISSUE_OPERATOR_STATES) {
      expect(groupOperatorState(detailed)).toBe(expected[detailed]);
    }
  });

  it("falls back to idle when detailed state is null or undefined", () => {
    expect(groupOperatorState(null)).toBe("idle");
    expect(groupOperatorState(undefined)).toBe("idle");
  });

  it("reports a coverage miss for unrecognized detailed states and falls back to idle", () => {
    const onCoverageMiss = vi.fn();
    const result = groupOperatorState("invented_future_state", { onCoverageMiss });
    expect(result).toBe("idle");
    expect(onCoverageMiss).toHaveBeenCalledTimes(1);
    expect(onCoverageMiss).toHaveBeenCalledWith({
      detailed: "invented_future_state",
      fallback: "idle",
    });
  });

  it("does not call the coverage-miss hook for recognized states", () => {
    const onCoverageMiss = vi.fn();
    for (const detailed of ISSUE_OPERATOR_STATES) {
      groupOperatorState(detailed, { onCoverageMiss });
    }
    expect(onCoverageMiss).not.toHaveBeenCalled();
  });

  it("keeps the four grouped states stable", () => {
    expect([...COMPUTED_AGENT_STATES]).toEqual([
      "idle",
      "queued",
      "dependency_blocked",
      "running",
    ]);
  });

  it("formats display labels for each grouped state", () => {
    expect(formatComputedAgentStateLabel("idle")).toBe("Idle");
    expect(formatComputedAgentStateLabel("queued")).toBe("Queued");
    expect(formatComputedAgentStateLabel("dependency_blocked")).toBe("Dependency blocked");
    expect(formatComputedAgentStateLabel("running")).toBe("Running");
  });
});
