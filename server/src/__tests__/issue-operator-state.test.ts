import { describe, expect, it } from "vitest";
import { buildIssueOperatorState } from "../services/issue-operator-state.ts";

describe("buildIssueOperatorState", () => {
  it("marks assigned active issues with no active run as idle_active", () => {
    const operator = buildIssueOperatorState({
      issueId: "issue-1",
      status: "in_progress",
      assigneeAgentId: "agent-1",
      activeRun: null,
    });

    expect(operator.operatorState).toBe("idle_active");
    expect(operator.operatorReason).toBe("Issue is active but no agent run is queued or running.");
  });

  it("marks assigned todo issues with no active run as idle_active", () => {
    const operator = buildIssueOperatorState({
      issueId: "issue-1",
      status: "todo",
      assigneeAgentId: "agent-1",
      activeRun: null,
    });

    expect(operator.operatorState).toBe("idle_active");
  });

  it("keeps actual running and queued runs distinct from idle active work", () => {
    expect(
      buildIssueOperatorState({
        issueId: "issue-1",
        status: "in_progress",
        assigneeAgentId: "agent-1",
        activeRun: { id: "run-1", status: "running" },
      }).operatorState,
    ).toBe("running");

    expect(
      buildIssueOperatorState({
        issueId: "issue-1",
        status: "in_progress",
        assigneeAgentId: "agent-1",
        activeRun: { id: "run-2", status: "queued" },
      }).operatorState,
    ).toBe("queued_followup");
  });
});
