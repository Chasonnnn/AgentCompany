import { describe, expect, it } from "vitest";
import {
  buildCompanyDocumentBody,
  buildEngineeringTeamDocumentBody,
  buildFallbackCompanyGoal,
  buildOnboardingKickoffQuestion,
  buildOnboardingProjectDocuments,
  buildOnboardingProjectGoal,
  buildOperationsTeamDocumentBody,
} from "./onboarding-bootstrap";

describe("onboarding bootstrap helpers", () => {
  it("builds a deterministic fallback company goal", () => {
    expect(buildFallbackCompanyGoal("Paperclip")).toEqual({
      title: "Paperclip: stand up an enterprise-ready operating company",
      description:
        "Create a governed company with durable docs, non-zero budgets, active routines, working heartbeats, and a visible governance path from kickoff through delivery.",
    });
  });

  it("builds the onboarding project goal from company context", () => {
    expect(
      buildOnboardingProjectGoal({
        companyName: "Paperclip",
        companyGoalTitle: "Run a governed company",
        ownerAgentId: "agent-1",
        parentId: "goal-1",
      }),
    ).toEqual({
      title: "Onboarding: establish the first governed execution lane",
      description: [
        "Company goal: Run a governed company",
        "Company: Paperclip",
        "Launch a real kickoff, seed durable docs, and exercise planning, branch return, review return, and handoff flows.",
      ].join("\n"),
      level: "team",
      status: "active",
      parentId: "goal-1",
      ownerAgentId: "agent-1",
    });
  });

  it("scaffolds durable company, team, and project docs with real starter content", () => {
    const companyDoc = buildCompanyDocumentBody({
      companyName: "Paperclip",
      companyGoalTitle: "Run a governed company",
    });
    const engineeringTeamDoc = buildEngineeringTeamDocumentBody();
    const operationsTeamDoc = buildOperationsTeamDocumentBody();
    const projectDocs = buildOnboardingProjectDocuments({
      companyName: "Paperclip",
      companyGoalTitle: "Run a governed company",
      projectGoalTitle: "Stand up onboarding",
    });

    expect(companyDoc).toContain("# COMPANY.md");
    expect(companyDoc).toContain("Company monthly budget: $50");
    expect(companyDoc).toContain("project_leadership");

    expect(engineeringTeamDoc).toContain("# TEAM.md");
    expect(engineeringTeamDoc).toContain("project leadership breakdown");

    expect(operationsTeamDoc).toContain("# TEAM.md");
    expect(operationsTeamDoc).toContain("heartbeat hygiene");

    expect(projectDocs.context).toContain("Company goal: Run a governed company");
    expect(projectDocs["decision-log"]).toContain("Default budgets are non-zero and conservative.");
    expect(projectDocs.risks).toContain("Workers exist but never wake.");
    expect(projectDocs.runbook).toContain("Use the seeded demo issues");
  });

  it("builds the kickoff question with the expected governance prompts", () => {
    const question = buildOnboardingKickoffQuestion({
      companyName: "Paperclip",
      projectGoalTitle: "Stand up onboarding",
    });

    expect(question).toContain("Please confirm the Paperclip onboarding kickoff.");
    expect(question).toContain("Project goal: Stand up onboarding");
    expect(question).toContain("- owned work breakdown");
    expect(question).toContain("- key risks");
  });
});
