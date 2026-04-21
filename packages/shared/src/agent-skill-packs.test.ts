import { describe, expect, it } from "vitest";
import {
  DEFAULT_COMPANY_SKILL_IMPORT_SLUGS,
  getDefaultDesiredSkillSlugsForAgent,
} from "./agent-skill-packs.js";

describe("agent skill packs", () => {
  it("assigns the governance pack to CEOs", () => {
    expect(getDefaultDesiredSkillSlugsForAgent({ role: "ceo" })).toEqual([
      "para-memory-files",
      "paperclip-create-agent",
      "find-skills",
      "openai-docs",
      "plan-ceo-review",
      "office-hours",
      "checkpoint",
    ]);
  });

  it("assigns the governance pack to chief-of-staff operators", () => {
    expect(
      getDefaultDesiredSkillSlugsForAgent({
        role: "coo",
        operatingClass: "executive",
        archetypeKey: "chief_of_staff",
      }),
    ).toEqual([
      "para-memory-files",
      "paperclip-create-agent",
      "find-skills",
      "openai-docs",
      "plan-ceo-review",
      "office-hours",
      "checkpoint",
    ]);
  });

  it("treats technical project lead as a project-lead pack alias", () => {
    expect(
      getDefaultDesiredSkillSlugsForAgent({
        role: "engineer",
        operatingClass: "project_leadership",
        archetypeKey: "technical_project_lead",
      }),
    ).toEqual([
      "para-memory-files",
      "find-skills",
      "plan-eng-review",
      "review",
      "health",
      "investigate",
      "checkpoint",
    ]);
  });

  it("assigns the frontend pack with its impeccable dependency", () => {
    const skills = getDefaultDesiredSkillSlugsForAgent({
      role: "engineer",
      operatingClass: "worker",
      archetypeKey: "frontend_ui_continuity_owner",
    });

    expect(skills).toContain("impeccable");
    expect(skills).toContain("shape");
    expect(skills).toContain("playwright-interactive");
    expect(skills).toContain("security-best-practices");
  });

  it("keeps backend defaults out of the UI pack and vice versa", () => {
    const backendSkills = getDefaultDesiredSkillSlugsForAgent({
      role: "engineer",
      operatingClass: "worker",
      archetypeKey: "backend_api_continuity_owner",
    });
    const qaSkills = getDefaultDesiredSkillSlugsForAgent({
      role: "qa",
      operatingClass: "worker",
      archetypeKey: "qa_evals_continuity_owner",
    });

    expect(backendSkills).toContain("supabase-postgres-best-practices");
    expect(backendSkills).not.toContain("impeccable");
    expect(qaSkills).toContain("qa-only");
    expect(qaSkills).not.toContain("security-best-practices");
  });

  it("assigns specialist packs by archetype", () => {
    const researchSkills = getDefaultDesiredSkillSlugsForAgent({
      role: "researcher",
      operatingClass: "consultant",
      archetypeKey: "research_specialist",
    });
    const growthSkills = getDefaultDesiredSkillSlugsForAgent({
      role: "general",
      operatingClass: "consultant",
      archetypeKey: "growth_specialist",
    });
    const consultingSkills = getDefaultDesiredSkillSlugsForAgent({
      role: "general",
      operatingClass: "consultant",
      archetypeKey: "consulting_specialist",
    });

    expect(researchSkills).toEqual(
      expect.arrayContaining(["arxiv", "research-paper-writing", "openai-docs"]),
    );
    expect(growthSkills).toEqual(
      expect.arrayContaining(["onboard", "clarify", "agent-browser"]),
    );
    expect(consultingSkills).toEqual(["find-skills"]);
  });

  it("imports the company-wide catalog needed by the default packs", () => {
    expect(DEFAULT_COMPANY_SKILL_IMPORT_SLUGS).toEqual(
      expect.arrayContaining([
        "impeccable",
        "supabase-postgres-best-practices",
        "playwright-interactive",
        "agent-browser",
        "security-threat-model",
        "research-paper-writing",
      ]),
    );
  });
});
