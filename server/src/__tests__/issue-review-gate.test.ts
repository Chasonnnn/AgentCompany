import { describe, expect, it } from "vitest";

import { assertInReviewEntryGate } from "../services/issue-review-gate.js";

describe("assertInReviewEntryGate", () => {
  it("returns null when not transitioning from in_progress to in_review", () => {
    expect(assertInReviewEntryGate({ status: "todo" }, { status: "in_review" })).toBeNull();
    expect(assertInReviewEntryGate({ status: "in_progress" }, { status: "done" })).toBeNull();
    expect(assertInReviewEntryGate({ status: "in_progress" }, {})).toBeNull();
  });

  it("accepts a valid pullRequestUrl", () => {
    expect(
      assertInReviewEntryGate(
        { status: "in_progress" },
        { status: "in_review", pullRequestUrl: "https://github.com/o/r/pull/1" },
      ),
    ).toBeNull();
  });

  it("accepts a complete selfAttest checklist with all true", () => {
    expect(
      assertInReviewEntryGate(
        { status: "in_progress" },
        {
          status: "in_review",
          selfAttest: { testsRun: true, docsUpdated: true, worktreeClean: true },
        },
      ),
    ).toBeNull();
  });

  it("rejects when neither pullRequestUrl nor selfAttest supplied, listing all missing fields", () => {
    const result = assertInReviewEntryGate(
      { status: "in_progress" },
      { status: "in_review" },
    );
    expect(result).not.toBeNull();
    expect(result?.details.missing).toEqual([
      "pullRequestUrl",
      "selfAttest.testsRun",
      "selfAttest.docsUpdated",
      "selfAttest.worktreeClean",
    ]);
    expect(result?.error).toMatch(/pullRequestUrl/);
    expect(result?.error).toMatch(/selfAttest/);
  });

  it("rejects when selfAttest has a field set to false, naming only that field", () => {
    const result = assertInReviewEntryGate(
      { status: "in_progress" },
      {
        status: "in_review",
        selfAttest: { testsRun: true, docsUpdated: false, worktreeClean: true },
      },
    );
    expect(result).not.toBeNull();
    expect(result?.details.missing).toEqual(["pullRequestUrl", "selfAttest.docsUpdated"]);
  });

  it("rejects empty-string pullRequestUrl and no attest", () => {
    const result = assertInReviewEntryGate(
      { status: "in_progress" },
      { status: "in_review", pullRequestUrl: "" },
    );
    expect(result).not.toBeNull();
    expect(result?.details.missing).toContain("pullRequestUrl");
  });

  it("accepts both pullRequestUrl and complete selfAttest together", () => {
    expect(
      assertInReviewEntryGate(
        { status: "in_progress" },
        {
          status: "in_review",
          pullRequestUrl: "https://forge.example.com/team/project/merge_requests/42",
          selfAttest: { testsRun: true, docsUpdated: true, worktreeClean: true },
        },
      ),
    ).toBeNull();
  });

  it("ignores unrelated transitions (in_review → in_progress, etc.)", () => {
    expect(assertInReviewEntryGate({ status: "in_review" }, { status: "in_progress" })).toBeNull();
    expect(assertInReviewEntryGate({ status: "in_review" }, { status: "done" })).toBeNull();
    expect(assertInReviewEntryGate({ status: "blocked" }, { status: "in_review" })).toBeNull();
  });
});
