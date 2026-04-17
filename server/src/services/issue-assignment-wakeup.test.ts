import { describe, expect, it } from "vitest";
import {
  isIssueWakeBlockedByContinuity,
  shouldWakeAssignedAgentForIssue,
} from "./issue-assignment-wakeup.js";

describe("issue assignment wakeup continuity gating", () => {
  it("blocks wakeups when continuity is missing required docs", () => {
    expect(
      isIssueWakeBlockedByContinuity({
        status: "blocked_missing_docs",
        health: "missing_required_docs",
      }),
    ).toBe(true);
  });

  it("blocks wakeups when continuity is stuck on an invalid handoff", () => {
    expect(
      isIssueWakeBlockedByContinuity({
        status: "handoff_pending",
        health: "invalid_handoff",
      }),
    ).toBe(true);
  });

  it("allows wakeups for ready or active healthy issues", () => {
    expect(
      shouldWakeAssignedAgentForIssue({
        issue: {
          assigneeAgentId: "agent-1",
          status: "todo",
        },
        continuityState: {
          status: "ready",
          health: "healthy",
        },
      }),
    ).toBe(true);

    expect(
      shouldWakeAssignedAgentForIssue({
        issue: {
          assigneeAgentId: "agent-1",
          status: "in_progress",
        },
        continuityState: {
          status: "active",
          health: "healthy",
        },
      }),
    ).toBe(true);
  });

  it("never wakes backlog issues even when continuity is healthy", () => {
    expect(
      shouldWakeAssignedAgentForIssue({
        issue: {
          assigneeAgentId: "agent-1",
          status: "backlog",
        },
        continuityState: {
          status: "ready",
          health: "healthy",
        },
      }),
    ).toBe(false);
  });
});
