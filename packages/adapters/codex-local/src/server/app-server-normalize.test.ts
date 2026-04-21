import { describe, expect, it } from "vitest";
import {
  buildDecisionQuestionCapture,
  buildPendingUserInputResponse,
  normalizeAppServerNotification,
  parsePendingUserInput,
} from "./app-server-normalize.js";

describe("app-server normalization", () => {
  it("normalizes lifecycle notifications into the legacy Codex NDJSON shape", () => {
    const usageByTurn = new Map<string, { input_tokens: number; cached_input_tokens: number; output_tokens: number }>();

    expect(
      normalizeAppServerNotification({
        method: "thread/started",
        params: {
          thread: {
            id: "thread-1",
          },
        },
        usageByTurn,
      }),
    ).toEqual({
      line: JSON.stringify({
        type: "thread.started",
        thread_id: "thread-1",
      }),
    });

    expect(
      normalizeAppServerNotification({
        method: "item/completed",
        params: {
          item: {
            id: "msg-1",
            type: "agentMessage",
            text: "Hello from Codex",
          },
        },
        usageByTurn,
      }),
    ).toEqual({
      line: JSON.stringify({
        type: "item.completed",
        item: {
          type: "agent_message",
          id: "msg-1",
          text: "Hello from Codex",
        },
      }),
    });

    expect(
      normalizeAppServerNotification({
        method: "thread/tokenUsage/updated",
        params: {
          turnId: "turn-1",
          tokenUsage: {
            last: {
              inputTokens: 11,
              cachedInputTokens: 3,
              outputTokens: 7,
            },
          },
        },
        usageByTurn,
      }),
    ).toBeNull();

    expect(
      normalizeAppServerNotification({
        method: "turn/completed",
        params: {
          turn: {
            id: "turn-1",
            status: "completed",
          },
        },
        usageByTurn,
      }),
    ).toEqual({
      line: JSON.stringify({
        type: "turn.completed",
        usage: {
          input_tokens: 11,
          cached_input_tokens: 3,
          output_tokens: 7,
        },
      }),
    });
  });

  it("captures native question payloads and builds a response from a board answer", () => {
    const pending = parsePendingUserInput({
      requestId: "req-1",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      questions: [
        {
          id: "scope",
          header: "Scope",
          question: "Which audit slice should I start with?",
          isOther: false,
          isSecret: false,
          options: [
            { label: "Runtime", description: "Inspect the live runtime first." },
            { label: "Governance", description: "Start with approval and policy flow." },
          ],
        },
      ],
    });

    expect(pending).toMatchObject({
      requestId: "req-1",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
    });

    expect(buildDecisionQuestionCapture(pending?.questions ?? [])).toEqual({
      prompt: "Scope - Which audit slice should I start with?",
      choices: [
        {
          key: "runtime",
          label: "Runtime",
          description: "Inspect the live runtime first.",
        },
        {
          key: "governance",
          label: "Governance",
          description: "Start with approval and policy flow.",
        },
      ],
    });

    expect(
      buildPendingUserInputResponse({
        questions: pending?.questions ?? [],
        selectedOptionKey: "governance",
        note: "Start there.",
      }),
    ).toEqual({
      answers: {
        scope: {
          answers: ["Governance", "Start there."],
        },
      },
    });
  });
});
