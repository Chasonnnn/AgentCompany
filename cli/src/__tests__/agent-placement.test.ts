import { describe, expect, it } from "vitest";
import { buildProjectPlacementPayload } from "../commands/client/agent.js";

describe("buildProjectPlacementPayload", () => {
  it("builds the minimal placement payload from a resolved project id", () => {
    expect(
      buildProjectPlacementPayload("11111111-1111-4111-8111-111111111111", {}),
    ).toEqual({
      projectId: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("includes optional placement flags when provided", () => {
    expect(
      buildProjectPlacementPayload("11111111-1111-4111-8111-111111111111", {
        projectRole: "functional_lead",
        scopeMode: "leadership_raw",
        teamFunctionKey: "frontend",
        teamFunctionLabel: "Frontend",
        workstreamKey: "landing-page",
        workstreamLabel: "Landing Page",
        placementReason: "Initial onboarding pod staffing",
      }),
    ).toEqual({
      projectId: "11111111-1111-4111-8111-111111111111",
      projectRole: "functional_lead",
      scopeMode: "leadership_raw",
      teamFunctionKey: "frontend",
      teamFunctionLabel: "Frontend",
      workstreamKey: "landing-page",
      workstreamLabel: "Landing Page",
      requestedReason: "Initial onboarding pod staffing",
    });
  });

  it("drops empty placement flag values", () => {
    expect(
      buildProjectPlacementPayload("11111111-1111-4111-8111-111111111111", {
        teamFunctionKey: "   ",
        teamFunctionLabel: "",
        placementReason: "   ",
      }),
    ).toEqual({
      projectId: "11111111-1111-4111-8111-111111111111",
    });
  });
});
