import { describe, expect, it } from "vitest";
import {
  buildGlobalCatalogInstallPlan,
  buildCompanyDocumentBody,
  buildEngineeringTeamDocumentBody,
  buildFallbackCompanyGoal,
  buildMarketingTeamDocumentBody,
  buildOnboardingKickoffQuestion,
  buildOnboardingProjectDocuments,
  buildOnboardingProjectGoal,
  canonicalizeDesiredSkillRefs,
  mergeDesiredSkillRefs,
  ONBOARDING_COMPANY_SKILL_IMPORT_SLUGS,
  ONBOARDING_REQUIRED_STARTER_SKILL_SLUGS,
  ONBOARDING_STARTER_SKILL_ASSIGNMENTS,
  buildOperationsTeamDocumentBody,
  buildResearchTeamDocumentBody,
} from "./onboarding-bootstrap";

describe("onboarding bootstrap helpers", () => {
  it("builds a deterministic fallback company goal", () => {
    expect(buildFallbackCompanyGoal("Paperclip")).toEqual({
      title: "Paperclip: stand up an enterprise-ready operating company",
      description:
        "Create a governed company with durable docs, company and project budgets, active routines, working heartbeats, and a visible governance path from kickoff through delivery.",
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
    const researchTeamDoc = buildResearchTeamDocumentBody();
    const marketingTeamDoc = buildMarketingTeamDocumentBody();
    const projectDocs = buildOnboardingProjectDocuments({
      companyName: "Paperclip",
      companyGoalTitle: "Run a governed company",
      projectGoalTitle: "Stand up onboarding",
    });

    expect(companyDoc).toContain("# COMPANY.md");
    expect(companyDoc).toContain("Company monthly budget: $50");
    expect(companyDoc).toContain("Starter-agent budgets: unset by default.");
    expect(companyDoc).toContain("project_leadership");

    expect(engineeringTeamDoc).toContain("# TEAM.md");
    expect(engineeringTeamDoc).toContain("project leadership breakdown");

    expect(operationsTeamDoc).toContain("# TEAM.md");
    expect(operationsTeamDoc).toContain("heartbeat hygiene");

    expect(researchTeamDoc).toContain("# TEAM.md");
    expect(researchTeamDoc).toContain("shared-service engagements");

    expect(marketingTeamDoc).toContain("# TEAM.md");
    expect(marketingTeamDoc).toContain("growth, onboarding, and market-learning support");

    expect(projectDocs.context).toContain("Company goal: Run a governed company");
    expect(projectDocs["decision-log"]).toContain("Default company and project budgets are non-zero and conservative.");
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

  it("defines the starter-team skill assignments and broad company import set", () => {
    expect(ONBOARDING_STARTER_SKILL_ASSIGNMENTS.ceo).toEqual(
      expect.arrayContaining(["para-memory-files", "paperclip-create-agent", "plan-ceo-review"]),
    );
    expect(ONBOARDING_STARTER_SKILL_ASSIGNMENTS.technicalProjectLead).toEqual(
      expect.arrayContaining(["plan-eng-review", "review", "health"]),
    );
    expect(ONBOARDING_STARTER_SKILL_ASSIGNMENTS.continuityOwner).toEqual(
      expect.arrayContaining(["supabase-postgres-best-practices", "security-best-practices"]),
    );
    expect(ONBOARDING_STARTER_SKILL_ASSIGNMENTS.auditReviewer).toEqual(
      expect.arrayContaining(["audit", "qa-only"]),
    );
    expect(ONBOARDING_STARTER_SKILL_ASSIGNMENTS.researchSpecialist).toEqual(
      expect.arrayContaining(["arxiv", "research-paper-writing", "transcribe"]),
    );
    expect(ONBOARDING_STARTER_SKILL_ASSIGNMENTS.growthSpecialist).toEqual(
      expect.arrayContaining(["onboard", "clarify", "agent-browser"]),
    );
    expect(ONBOARDING_STARTER_SKILL_ASSIGNMENTS.consultingSpecialist).toEqual(
      expect.arrayContaining(["find-skills"]),
    );
    expect(ONBOARDING_REQUIRED_STARTER_SKILL_SLUGS).toEqual(
      expect.arrayContaining([
        "para-memory-files",
        "plan-eng-review",
        "supabase-postgres-best-practices",
        "audit",
        "arxiv",
        "agent-browser",
        "find-skills",
      ]),
    );
    expect(ONBOARDING_COMPANY_SKILL_IMPORT_SLUGS).toEqual(
      expect.arrayContaining([
        "impeccable",
        "playwright-interactive",
        "security-threat-model",
        "agent-browser",
      ]),
    );
  });

  it("builds a targeted global-catalog install plan and preserves existing skill refs", () => {
    const plan = buildGlobalCatalogInstallPlan(
      new Set(["paperclip-create-agent"]),
      [
        {
          catalogKey: "catalog-1",
          slug: "paperclip-create-agent",
          name: "Paperclip Create Agent",
          description: null,
          sourceRoot: "codex",
          sourcePath: ".codex/skills/paperclip-create-agent",
          trustLevel: "markdown_only",
          compatibility: "compatible",
          fileInventory: [],
          installedSkillId: "skill-1",
          installedSkillKey: "company/company-1/paperclip-create-agent",
        },
        {
          catalogKey: "catalog-2",
          slug: "plan-eng-review",
          name: "Plan Eng Review",
          description: null,
          sourceRoot: "codex",
          sourcePath: ".codex/skills/gstack-plan-eng-review",
          trustLevel: "markdown_only",
          compatibility: "compatible",
          fileInventory: [],
          installedSkillId: null,
          installedSkillKey: null,
        },
      ],
      ["paperclip-create-agent", "plan-eng-review", "missing-skill"],
    );

    expect(plan).toEqual({
      installCatalogKeys: ["catalog-2"],
      missingSlugs: ["missing-skill"],
    });

    expect(mergeDesiredSkillRefs(["skill-a"], ["skill-a", "skill-b"])).toEqual([
      "skill-a",
      "skill-b",
    ]);
    expect(
      canonicalizeDesiredSkillRefs(
        ["plan-eng-review", "company/company-1/custom-skill"],
        new Map([["plan-eng-review", "company/company-1/plan-eng-review"]]),
      ),
    ).toEqual([
      "company/company-1/custom-skill",
      "company/company-1/plan-eng-review",
    ]);
  });
});
