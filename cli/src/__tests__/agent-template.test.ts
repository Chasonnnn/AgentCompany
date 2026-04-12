import { describe, expect, it } from "vitest";
import type { AgentTemplate } from "@paperclipai/shared";
import { matchAgentTemplateRef } from "../commands/client/agent-template.js";

function buildTemplate(overrides: Partial<AgentTemplate>): AgentTemplate {
  return {
    id: "template-1",
    companyId: "company-1",
    name: "COO",
    role: "general",
    operatingClass: "executive",
    capabilityProfileKey: "executive_standard",
    archetypeKey: "chief_of_staff",
    metadata: null,
    createdAt: new Date("2026-04-12T00:00:00.000Z"),
    updatedAt: new Date("2026-04-12T00:00:00.000Z"),
    archivedAt: null,
    ...overrides,
  };
}

describe("matchAgentTemplateRef", () => {
  it("resolves by id before other fields", () => {
    const templates = [
      buildTemplate({ id: "template-1", name: "COO", archetypeKey: "chief_of_staff" }),
      buildTemplate({ id: "template-2", name: "template-1", archetypeKey: "ops_lead" }),
    ];

    expect(matchAgentTemplateRef(templates, "template-1").id).toBe("template-1");
  });

  it("resolves by exact archetype key", () => {
    const templates = [
      buildTemplate({ id: "template-1", archetypeKey: "chief_of_staff" }),
      buildTemplate({ id: "template-2", name: "CTO", archetypeKey: "cto" }),
    ];

    expect(matchAgentTemplateRef(templates, "cto").id).toBe("template-2");
  });

  it("resolves by exact name when unique", () => {
    const templates = [
      buildTemplate({ id: "template-1", name: "COO", archetypeKey: "chief_of_staff" }),
      buildTemplate({ id: "template-2", name: "CTO", archetypeKey: "cto" }),
    ];

    expect(matchAgentTemplateRef(templates, "CTO").id).toBe("template-2");
  });

  it("throws on ambiguous exact names", () => {
    const templates = [
      buildTemplate({ id: "template-1", name: "COO", archetypeKey: "chief_of_staff" }),
      buildTemplate({ id: "template-2", name: "COO", archetypeKey: "ops_lead" }),
    ];

    expect(() => matchAgentTemplateRef(templates, "COO")).toThrow(/ambiguous/i);
  });
});
