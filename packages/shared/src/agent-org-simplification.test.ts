import { describe, expect, it } from "vitest";
import {
  companyOrgSimplificationReportSchema,
  orgSimplificationActionResultSchema,
} from "./index.js";

describe("org simplification schemas", () => {
  it("round-trips simplification reports", () => {
    const parsed = companyOrgSimplificationReportSchema.parse({
      companyId: "11111111-1111-1111-1111-111111111111",
      generatedAt: "2026-04-15T12:00:00.000Z",
      recommendedSteadyStateAgents: {
        min: 4,
        max: 6,
      },
      counts: {
        totalConfiguredAgents: 14,
        activeContinuityOwners: 5,
        activeGovernanceLeads: 2,
        activeSharedServiceAgents: 1,
        legacyAgents: 3,
        inactiveAgents: 2,
        simplificationCandidates: 4,
      },
      candidates: [
        {
          agent: {
            id: "22222222-2222-2222-2222-222222222222",
            name: "Legacy PM",
            urlKey: "legacy-pm",
            role: "pm",
            title: "PM",
            icon: null,
            status: "idle",
            reportsTo: null,
            orgLevel: "staff",
            operatingClass: "worker",
            capabilityProfileKey: "worker",
            archetypeKey: "product_manager",
            departmentKey: "product",
            departmentName: null,
          },
          classification: "archive",
          confidence: "high",
          reasons: ["Uses a legacy relay execution role with no active responsibility."],
          activeIssueCount: 0,
          directReportCount: 0,
          recentRunCount: 0,
          activeSharedServiceEngagementCount: 0,
          activeGateCount: 0,
          suggestedTargetAgentId: null,
          suggestedTargetName: null,
        },
      ],
    });

    expect(parsed.counts.simplificationCandidates).toBe(4);
    expect(parsed.candidates[0]?.classification).toBe("archive");
  });

  it("round-trips simplification action results", () => {
    const parsed = orgSimplificationActionResultSchema.parse({
      companyId: "11111111-1111-1111-1111-111111111111",
      action: "archive",
      affectedAgentIds: ["22222222-2222-2222-2222-222222222222"],
      report: {
        companyId: "11111111-1111-1111-1111-111111111111",
        generatedAt: "2026-04-15T12:00:00.000Z",
        recommendedSteadyStateAgents: {
          min: 4,
          max: 6,
        },
        counts: {
          totalConfiguredAgents: 9,
          activeContinuityOwners: 4,
          activeGovernanceLeads: 2,
          activeSharedServiceAgents: 1,
          legacyAgents: 1,
          inactiveAgents: 1,
          simplificationCandidates: 2,
        },
        candidates: [],
      },
    });

    expect(parsed.action).toBe("archive");
    expect(parsed.affectedAgentIds).toHaveLength(1);
  });
});
