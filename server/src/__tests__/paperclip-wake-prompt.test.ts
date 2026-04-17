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
});
