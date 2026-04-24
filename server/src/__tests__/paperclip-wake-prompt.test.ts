import { describe, expect, it } from "vitest";
import {
  renderPaperclipWakePrompt,
  stringifyPaperclipWakePayload,
} from "../../../packages/adapter-utils/src/server-utils.js";

describe("Paperclip room wake prompts", () => {
  it("renders room-specific guidance for conference room questions", () => {
    const payload = {
      reason: "conference_room_question",
      conferenceRoom: {
        id: "room-1",
        title: "Onboarding Meeting",
        kind: "project_leadership",
        status: "open",
        linkedIssues: [
          {
            id: "issue-1",
            identifier: "PAP-1",
            title: "Kickoff onboarding work",
          },
        ],
      },
      conferenceRoomMessage: {
        id: "comment-1",
        parentCommentId: null,
        messageType: "question",
        body: "How do you feel about the audit?",
        createdAt: "2026-04-17T00:48:07.000Z",
        author: {
          type: "user",
          id: "board-user",
        },
      },
      conferenceRoomThread: [
        {
          id: "comment-1",
          parentCommentId: null,
          messageType: "question",
          body: "How do you feel about the audit?",
          createdAt: "2026-04-17T00:48:07.000Z",
          author: {
            type: "user",
            id: "board-user",
          },
        },
      ],
      conferenceRoomPendingResponses: [
        {
          agent: { id: "agent-1", name: "Technical Project Lead" },
          status: "pending",
          repliedCommentId: null,
        },
      ],
    };

    expect(stringifyPaperclipWakePayload(payload)).toContain('"conferenceRoom"');

    const prompt = renderPaperclipWakePrompt(payload);

    expect(prompt).toContain("Paperclip Wake Payload");
    expect(prompt).toContain("conference room: Onboarding Meeting (room-1)");
    expect(prompt).toContain("reply in the conference room thread");
    expect(prompt).toContain("An invited board question is awaiting your in-thread response.");
    expect(prompt).toContain("Room response state:");
    expect(prompt).toContain("Technical Project Lead: pending");
    expect(prompt).not.toContain("issue below. Do not switch");
  });

  it("renders planning and answered decision question guidance for issue wakes", () => {
    const payload = {
      reason: "decision_question_answered",
      issue: {
        id: "issue-1",
        identifier: "AIW-12",
        title: "Audit the architecture",
        status: "todo",
        priority: "high",
      },
      mode: "planning",
      planningMode: true,
      continuityStatus: "planning",
      openDecisionQuestionCount: 1,
      blockingDecisionQuestionCount: 0,
      decisionQuestion: {
        id: "question-1",
        status: "answered",
        blocking: true,
        title: "Pick the first audit slice",
        question: "Should the audit start with runtime or governance?",
        whyBlocked: "The plan shape changes depending on the first slice.",
        suggestedDefault: "runtime",
        linkedApprovalId: null,
        recommendedOptions: [
          { key: "runtime", label: "Runtime" },
          { key: "governance", label: "Governance" },
        ],
        answer: {
          answer: "Start with runtime hardening first.",
          selectedOptionKey: "runtime",
          note: "The biggest execution risk is there.",
        },
      },
      checkedOutByHarness: false,
      executionStage: null,
      commentIds: [],
      latestCommentId: null,
      comments: [],
      requestedCount: 0,
      includedCount: 0,
      missingCount: 0,
      truncated: false,
      fallbackFetchNeeded: false,
      conferenceRoom: null,
      conferenceRoomMessage: null,
      conferenceRoomThread: [],
      conferenceRoomPendingResponses: [],
    };

    const prompt = renderPaperclipWakePrompt(payload);

    expect(prompt).toContain("mode: planning");
    expect(prompt).toContain("Decision question context:");
    expect(prompt).toContain("board answer: Start with runtime hardening first.");
    expect(prompt).toContain("The board answered your decision question.");
  });

  it("renders option-only decision answers using the canonical option label", () => {
    const payload = {
      reason: "decision_question_answered",
      issue: {
        id: "issue-1",
        identifier: "AIW-12",
        title: "Audit the architecture",
        status: "todo",
        priority: "high",
      },
      mode: "planning",
      planningMode: true,
      continuityStatus: "planning",
      openDecisionQuestionCount: 0,
      blockingDecisionQuestionCount: 0,
      decisionQuestion: {
        id: "question-1",
        status: "answered",
        blocking: true,
        title: "Pick the first audit slice",
        question: "Should the audit start with runtime or governance?",
        whyBlocked: "The plan shape changes depending on the first slice.",
        suggestedDefault: "runtime",
        linkedApprovalId: null,
        recommendedOptions: [
          { key: "runtime", label: "Runtime" },
          { key: "governance", label: "Governance" },
        ],
        answer: {
          answer: "Runtime",
          selectedOptionKey: "runtime",
          note: null,
        },
      },
      checkedOutByHarness: false,
      executionStage: null,
      commentIds: [],
      latestCommentId: null,
      comments: [],
      requestedCount: 0,
      includedCount: 0,
      missingCount: 0,
      truncated: false,
      fallbackFetchNeeded: false,
      conferenceRoom: null,
      conferenceRoomMessage: null,
      conferenceRoomThread: [],
      conferenceRoomPendingResponses: [],
    };

    const prompt = renderPaperclipWakePrompt(payload);

    expect(prompt).toContain("board answer: Runtime");
  });

  it("renders plan approval revision guidance for issue wakes", () => {
    const payload = {
      reason: "approval_revision_requested",
      issue: {
        id: "issue-1",
        identifier: "AIW-5",
        title: "Deep audit of the architecture",
        status: "todo",
        priority: "high",
      },
      mode: "approval",
      planningMode: true,
      continuityStatus: "awaiting_decision",
      openDecisionQuestionCount: 0,
      blockingDecisionQuestionCount: 0,
      decisionQuestion: null,
      planApproval: {
        approvalId: "approval-1",
        status: "revision_requested",
        currentPlanRevisionId: "plan-revision-2",
        requestedPlanRevisionId: "plan-revision-2",
        approvedPlanRevisionId: "plan-revision-1",
        decisionNote: "Tighten the rollout and clarify ownership.",
        currentRevisionApproved: false,
        requiresApproval: true,
        requiresResubmission: true,
        lastRequestedAt: "2026-04-20T01:00:00.000Z",
        lastDecidedAt: "2026-04-20T01:05:00.000Z",
      },
      checkedOutByHarness: false,
      executionStage: null,
      commentIds: [],
      latestCommentId: null,
      comments: [],
      requestedCount: 0,
      includedCount: 0,
      missingCount: 0,
      truncated: false,
      fallbackFetchNeeded: false,
      conferenceRoom: null,
      conferenceRoomMessage: null,
      conferenceRoomThread: [],
      conferenceRoomPendingResponses: [],
    };

    const prompt = renderPaperclipWakePrompt(payload);

    expect(prompt).toContain("Plan approval context:");
    expect(prompt).toContain("status: revision_requested");
    expect(prompt).toContain("board note: Tighten the rollout and clarify ownership.");
    expect(prompt).toContain("The board requested revisions on your plan approval.");
    expect(prompt).toContain("revise the plan document");
  });

  it("keeps resumed issue wakes to the latest delta by default", () => {
    const payload = {
      reason: "issue_commented",
      issue: {
        id: "issue-1",
        identifier: "AIW-12",
        title: "Audit the architecture",
        status: "in_progress",
        priority: "high",
      },
      mode: "execution",
      continuityStatus: "executing",
      openDecisionQuestionCount: 0,
      blockingDecisionQuestionCount: 0,
      checkedOutByHarness: true,
      commentIds: ["comment-1", "comment-2"],
      latestCommentId: "comment-2",
      comments: [
        {
          id: "comment-1",
          body: "Older context that should not be replayed.",
          createdAt: "2026-04-24T10:00:00.000Z",
          author: { type: "user", id: "board" },
        },
        {
          id: "comment-2",
          body: "Latest requested change.",
          createdAt: "2026-04-24T10:05:00.000Z",
          author: { type: "user", id: "board" },
        },
      ],
      requestedCount: 2,
      includedCount: 2,
      missingCount: 0,
      fallbackFetchNeeded: false,
      sharedSkills: [
        {
          sharedSkillId: "skill-1",
          key: "paperclip",
          name: "Paperclip",
          mirrorState: "synced",
          sourceDriftState: "clean",
          proposalAllowed: true,
          applyAllowed: false,
        },
      ],
      conferenceRoom: null,
      conferenceRoomMessage: null,
      conferenceRoomThread: [],
      conferenceRoomPendingResponses: [],
    };

    const prompt = renderPaperclipWakePrompt(payload, { resumedSession: true });

    expect(prompt).toContain("Paperclip Resume Delta");
    expect(prompt).toContain("Latest wake comment:");
    expect(prompt).toContain("Latest requested change.");
    expect(prompt).toContain("omitted comments: 1");
    expect(prompt).not.toContain("Older context that should not be replayed.");
    expect(prompt).not.toContain("Shared skill mirror context:");
  });
});
