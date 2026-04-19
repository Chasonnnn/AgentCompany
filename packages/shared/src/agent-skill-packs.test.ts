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
