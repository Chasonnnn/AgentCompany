import { describe, expect, it } from "vitest";
import { issueContinuityBundleSchema, issueContinuityStateSchema } from "./index.js";

describe("issue continuity schemas", () => {
  it("round-trips issue continuity state", () => {
    const parsed = issueContinuityStateSchema.parse({
      tier: "long_running",
      status: "active",
      health: "healthy",
      requiredDocumentKeys: ["spec", "plan", "runbook", "progress", "test-plan", "handoff"],
      missingDocumentKeys: [],
      specState: "frozen",
      branchRole: "parent",
      branchStatus: "open",
      unresolvedBranchIssueIds: [
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
      ],
      healthDetails: [],
      returnedBranchIssueIds: [],
      openReviewFindingsRevisionId: null,
      lastProgressAt: "2026-04-14T12:00:00.000Z",
      lastHandoffAt: null,
      lastReviewFindingsAt: null,
      lastReviewReturnAt: null,
      lastBranchReturnAt: null,
      lastPreparedAt: "2026-04-14T09:00:00.000Z",
      lastBundleHash: "abc123",
    });

    expect(parsed).toEqual({
      tier: "long_running",
      status: "active",
      health: "healthy",
      requiredDocumentKeys: ["spec", "plan", "runbook", "progress", "test-plan", "handoff"],
      missingDocumentKeys: [],
      specState: "frozen",
      branchRole: "parent",
      branchStatus: "open",
      unresolvedBranchIssueIds: [
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
      ],
      healthDetails: [],
      returnedBranchIssueIds: [],
      openReviewFindingsRevisionId: null,
      lastProgressAt: "2026-04-14T12:00:00.000Z",
      lastHandoffAt: null,
      lastReviewFindingsAt: null,
      lastReviewReturnAt: null,
      lastBranchReturnAt: null,
      lastPreparedAt: "2026-04-14T09:00:00.000Z",
      lastBundleHash: "abc123",
    });
  });

  it("round-trips issue continuity bundles", () => {
    const parsed = issueContinuityBundleSchema.parse({
      issueId: "33333333-3333-4333-8333-333333333333",
      generatedAt: "2026-04-14T12:30:00.000Z",
      bundleHash: "bundle-123",
      continuityState: {
        tier: "normal",
        status: "ready",
        health: "healthy",
        healthDetails: [],
        requiredDocumentKeys: ["spec", "plan", "progress", "test-plan"],
        missingDocumentKeys: [],
        specState: "editable",
        branchRole: "none",
        branchStatus: "none",
        unresolvedBranchIssueIds: [],
        returnedBranchIssueIds: [],
        openReviewFindingsRevisionId: null,
        lastProgressAt: "2026-04-14T12:00:00.000Z",
        lastHandoffAt: null,
        lastReviewFindingsAt: null,
        lastReviewReturnAt: null,
        lastBranchReturnAt: null,
        lastPreparedAt: "2026-04-14T11:30:00.000Z",
        lastBundleHash: "bundle-123",
      },
      executionState: null,
      issueDocuments: {
        spec: {
          key: "spec",
          title: "Spec",
          body: "## Goal\n\nShip the feature",
          latestRevisionId: "44444444-4444-4444-8444-444444444444",
          latestRevisionNumber: 1,
          updatedAt: "2026-04-14T12:00:00.000Z",
        },
        plan: null,
        runbook: null,
        progress: {
          key: "progress",
          title: null,
          body: "Current snapshot",
          latestRevisionId: "55555555-5555-4555-8555-555555555555",
          latestRevisionNumber: 2,
          updatedAt: "2026-04-14T12:05:00.000Z",
        },
        "test-plan": null,
        handoff: null,
        "review-findings": null,
        "branch-return": null,
      },
      projectDocuments: {
        context: null,
        runbook: null,
      },
      referencedRevisionIds: {
        spec: "44444444-4444-4444-8444-444444444444",
        plan: null,
        runbook: null,
        progress: "55555555-5555-4555-8555-555555555555",
        "test-plan": null,
        handoff: null,
        "review-findings": null,
        "branch-return": null,
        "project:context": null,
        "project:runbook": null,
      },
    });

    expect(parsed.bundleHash).toBe("bundle-123");
    expect(parsed.issueDocuments.progress?.latestRevisionNumber).toBe(2);
    expect(parsed.continuityState?.status).toBe("ready");
  });
});
