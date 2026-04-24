// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LowYieldRunList, ProductivityMetricGrid } from "./ProductivitySummaryPanel";

describe("ProductivitySummaryPanel", () => {
  it("renders productivity ratios and low-yield run details", () => {
    const html = renderToStaticMarkup(
      <div>
        <ProductivityMetricGrid
          totals={{
            runCount: 2,
            terminalRunCount: 2,
            usefulRunCount: 1,
            completedRunCount: 1,
            blockedRunCount: 0,
            lowYieldRunCount: 1,
            planOnlyRunCount: 0,
            emptyResponseRunCount: 1,
            needsFollowupRunCount: 0,
            failedRunCount: 0,
            continuationExhaustionCount: 1,
            completedIssueCount: 1,
            inputTokens: 1_500,
            cachedInputTokens: 100,
            cacheCreationInputTokens: 50,
            outputTokens: 270,
            totalTokens: 1_920,
            costCents: 0,
            estimatedApiCostCents: 15,
            durationMs: 360_000,
            timeToFirstUsefulActionMs: 60_000,
          }}
          ratios={{
            usefulRunRate: 0.5,
            lowYieldRunRate: 0.5,
            tokensPerUsefulRun: 1_920,
            tokensPerCompletedIssue: 1_920,
            avgRunDurationMs: 180_000,
            avgTimeToFirstUsefulActionMs: 60_000,
          }}
        />
        <LowYieldRunList
          runs={[
            {
              runId: "run-1",
              agentId: "agent-1",
              agentName: "Operator",
              issueId: "issue-1",
              issueIdentifier: "PAP-1",
              issueTitle: "Fix runtime",
              projectId: "project-1",
              projectName: "Runtime",
              status: "succeeded",
              livenessState: "empty_response",
              livenessReason: "No useful output",
              continuationAttempt: 2,
              startedAt: "2026-04-24T10:00:00.000Z",
              finishedAt: "2026-04-24T10:01:00.000Z",
              durationMs: 60_000,
              totalTokens: 520,
              estimatedApiCostCents: 3,
              nextAction: "Tighten the issue scope",
            },
          ]}
        />
      </div>,
    );

    expect(html).toContain("Useful Runs");
    expect(html).toContain("50%");
    expect(html).toContain("PAP-1");
    expect(html).toContain("No useful output");
    expect(html).toContain("Tighten the issue scope");
  });
});
