import { describe, expect, it } from "vitest";
import { loadDefaultAgentTemplatePack } from "../services/default-agent-templates.js";

describe("loadDefaultAgentTemplatePack", () => {
  it("loads the lean shared-state template library", async () => {
    const pack = await loadDefaultAgentTemplatePack();

    expect(pack.rootPath).toBe("server/src/onboarding-assets/templates");
    expect(Object.keys(pack.files)).toEqual(
      expect.arrayContaining([
        "technical-project-lead.md",
        "backend-api-continuity-owner.md",
        "qa-evals-continuity-owner.md",
        "frontend-ui-continuity-owner.md",
        "infra-runtime-continuity-owner.md",
        "audit-reviewer.md",
        "research-specialist.md",
        "consulting-specialist.md",
        "growth-specialist.md",
      ]),
    );
    expect(pack.files["technical-project-lead.md"]).toContain("Technical Project Lead");
    expect(pack.files["audit-reviewer.md"]).toContain("inactive until engaged");
  });
});
