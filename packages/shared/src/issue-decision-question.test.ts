import { describe, expect, it } from "vitest";
import { answerIssueDecisionQuestionSchema, issueDecisionQuestionSchema } from "./index.js";

describe("issue decision question schema", () => {
  it("round-trips structured board questions", () => {
    const parsed = issueDecisionQuestionSchema.parse({
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      issueId: "22222222-2222-4222-8222-222222222222",
      target: "board",
      requestedByAgentId: "33333333-3333-4333-8333-333333333333",
      requestedByUserId: null,
      status: "answered",
      blocking: true,
      title: "Select migration path",
      question: "Should the migration stay incremental or do a one-shot rebuild?",
      whyBlocked: "The implementation path changes rollout risk and rollback shape.",
      recommendedOptions: [
        {
          key: "incremental",
          label: "Incremental",
          description: "Lower risk, slower cleanup.",
        },
        {
          key: "rebuild",
          label: "Rebuild",
          description: "Faster reset, higher migration blast radius.",
        },
      ],
      suggestedDefault: "incremental",
      answer: {
        answer: "Use the incremental path.",
        selectedOptionKey: "incremental",
        note: "Keep rollback simple for the first wave.",
      },
      answeredByUserId: "44444444-4444-4444-8444-444444444444",
      answeredAt: "2026-04-17T10:15:00.000Z",
      linkedApprovalId: null,
      createdAt: "2026-04-17T10:00:00.000Z",
      updatedAt: "2026-04-17T10:15:00.000Z",
    });

    expect(parsed.status).toBe("answered");
    expect(parsed.answer?.selectedOptionKey).toBe("incremental");
    expect(parsed.recommendedOptions).toHaveLength(2);
  });

  it("accepts option-only answer payloads", () => {
    const parsed = answerIssueDecisionQuestionSchema.parse({
      selectedOptionKey: "incremental",
    });

    expect(parsed.selectedOptionKey).toBe("incremental");
    expect(parsed.answer).toBeUndefined();
  });

  it("accepts custom-comment answer payloads", () => {
    const parsed = answerIssueDecisionQuestionSchema.parse({
      answer: "Add one more audit pass before rollout.",
    });

    expect(parsed.answer).toBe("Add one more audit pass before rollout.");
    expect(parsed.selectedOptionKey).toBeUndefined();
  });

  it("rejects payloads that include both an option and a custom answer", () => {
    expect(() => answerIssueDecisionQuestionSchema.parse({
      selectedOptionKey: "incremental",
      answer: "Incremental with an extra migration buffer.",
    })).toThrow(/exactly one/i);
  });

  it("rejects payloads that include neither an option nor a custom answer", () => {
    expect(() => answerIssueDecisionQuestionSchema.parse({})).toThrow(/exactly one/i);
  });
});
