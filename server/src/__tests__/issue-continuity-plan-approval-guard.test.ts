import { describe, expect, it } from "vitest";
import { hasPlanningStageEnded } from "../services/issue-continuity.ts";

const coderAgentId = "11111111-1111-4111-8111-111111111111";
const qaAgentId = "22222222-2222-4222-8222-222222222222";
const stageId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("hasPlanningStageEnded", () => {
  it("returns false for a freshly-checked-out task (status flipped to in_progress, no executionState)", () => {
    // Covers AIW-23 acceptance: checkout sets status=in_progress and startedAt,
    // but the planning stage has not ended so plan-approval must stay open.
    const issue = {
      status: "in_progress",
      startedAt: new Date().toISOString(),
      executionState: null,
    };
    expect(hasPlanningStageEnded(issue)).toBe(false);
  });

  it("returns false for a backlog/todo task with no executionState", () => {
    expect(
      hasPlanningStageEnded({
        status: "todo",
        startedAt: null,
        executionState: null,
      }),
    ).toBe(false);
  });

  it("returns false when executionState is a malformed blob that fails to parse", () => {
    expect(
      hasPlanningStageEnded({
        status: "in_progress",
        executionState: { status: "not-a-real-status" },
      }),
    ).toBe(false);
  });

  it("returns true when executionState.status is pending (execution policy active)", () => {
    expect(
      hasPlanningStageEnded({
        status: "in_review",
        executionState: {
          status: "pending",
          currentStageId: stageId,
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: qaAgentId },
          returnAssignee: { type: "agent", agentId: coderAgentId },
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
        },
      }),
    ).toBe(true);
  });

  it("returns true when executionState.status is changes_requested", () => {
    expect(
      hasPlanningStageEnded({
        status: "in_progress",
        executionState: {
          status: "changes_requested",
          currentStageId: stageId,
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: null,
          returnAssignee: { type: "agent", agentId: coderAgentId },
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: "changes_requested",
        },
      }),
    ).toBe(true);
  });

  it("returns true when a decision outcome has been recorded on an otherwise-idle executionState", () => {
    expect(
      hasPlanningStageEnded({
        status: "in_progress",
        executionState: {
          status: "completed",
          currentStageId: null,
          currentStageIndex: null,
          currentStageType: null,
          currentParticipant: null,
          returnAssignee: { type: "agent", agentId: coderAgentId },
          completedStageIds: [stageId],
          lastDecisionId: null,
          lastDecisionOutcome: "approved",
        },
      }),
    ).toBe(true);
  });
});
