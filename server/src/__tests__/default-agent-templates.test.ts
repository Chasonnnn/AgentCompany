import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { loadDefaultAgentTemplatePack } from "../services/default-agent-templates.js";

describe("loadDefaultAgentTemplatePack", () => {
  it("loads the lean shared-state template library", async () => {
    const pack = await loadDefaultAgentTemplatePack();

    expect(pack.rootPath).toBe("server/src/onboarding-assets/templates");
    expect(Object.keys(pack.files)).toEqual(
      expect.arrayContaining([
        "chief-of-staff.md",
        "technical-project-lead.md",
        "backend-api-continuity-owner.md",
        "qa-evals-continuity-owner.md",
        "frontend-ui-continuity-owner.md",
        "infra-runtime-continuity-owner.md",
        "audit-reviewer.md",
        "productivity-monitor.md",
        "research-specialist.md",
        "consulting-specialist.md",
        "growth-specialist.md",
      ]),
    );
    expect(pack.files["chief-of-staff.md"]).toContain("Chief of Staff");
    expect(pack.files["technical-project-lead.md"]).toContain("Project Lead");
    expect(pack.files["audit-reviewer.md"]).toContain("inactive until engaged");
    expect(pack.files["qa-evals-continuity-owner.md"]).toContain("QA-first support");
    expect(pack.files["qa-evals-continuity-owner.md"]).toContain("reviewers stay gates");
    expect(pack.files["backend-api-continuity-owner.md"]).toContain("Use QA-first only when backend work is high or critical risk");
    expect(pack.files["productivity-monitor.md"]).toContain("advisory-only");
    expect(pack.files["productivity-monitor.md"]).toContain("unnecessary QA ceremony");
    expect(pack.files["productivity-monitor.md"]).toContain("adapterType: codex_local");
    expect(pack.files["productivity-monitor.md"]).toContain("model: gpt-5.3-codex-spark");
    expect(pack.files["productivity-monitor.md"]).toContain("modelReasoningEffort: high");
    expect(pack.files["chief-of-staff.md"]).toContain("check whether the wake is yours and actionable");
    expect(pack.files["chief-of-staff.md"]).toContain("one lightweight unblock packet");
    expect(pack.files["technical-project-lead.md"]).toContain("check whether the wake is yours and actionable");
    expect(pack.files["technical-project-lead.md"]).toContain("one lightweight unblock packet");
    expect(pack.files["productivity-monitor.md"]).toContain("Start from the compact productivity packet");
    expect(pack.files["productivity-monitor.md"]).toContain("repeated scope/ownership preflight misses");
    for (const [filename, content] of Object.entries(pack.files)) {
      if (filename === "README.md") continue;
      expect(content, filename).toContain("Subagent Collaboration");
      expect(content, filename).toContain("safe");
      expect(content, filename).toContain("planning loops");
    }
  });

  it("keeps the heartbeat skill focused on scope and ownership preflight", async () => {
    const [skill, ceoInstructions] = await Promise.all([
      readFile(new URL("../../../skills/paperclip/SKILL.md", import.meta.url), "utf8"),
      readFile(new URL("../onboarding-assets/ceo/AGENTS.md", import.meta.url), "utf8"),
    ]);

    expect(skill).toContain("run a scope and ownership preflight");
    expect(skill).toContain("Is this wake assigned to me");
    expect(skill).toContain("post one short redirect");
    expect(skill).toContain("name the blocker, owner, and exact unblock action");
    expect(ceoInstructions).toContain("check whether the wake is yours and actionable");
    expect(ceoInstructions).toContain("one unblock packet");
    expect(ceoInstructions).toContain("Use subagents only for safe bounded parallelism");
  });

  it("ships the QA/Evals in_review wake branch in the continuity owner template", async () => {
    const pack = await loadDefaultAgentTemplatePack();
    const qaTemplate = pack.files["qa-evals-continuity-owner.md"];
    expect(qaTemplate).toBeTruthy();
    expect(qaTemplate).toContain("# Handling in_review wakes");
    expect(qaTemplate).toContain("execution_review_requested");
    expect(qaTemplate).toContain("returnAssignee");
    expect(qaTemplate).toContain("executionStage.executorAgentId");
  });

  it("tells reviewers to reassign the executor when blocking on missing context", async () => {
    const pack = await loadDefaultAgentTemplatePack();
    const qaTemplate = pack.files["qa-evals-continuity-owner.md"];
    expect(qaTemplate).toBeTruthy();
    expect(qaTemplate).toMatch(/Block on missing context[\s\S]+Apply the same return-assignee rules as step 4/);
    expect(qaTemplate).toMatch(/Block on missing context[\s\S]+auto-route path/);
    expect(qaTemplate).toMatch(/Block on missing context[\s\S]+executionStage\.executorAgentId/);
  });
});
