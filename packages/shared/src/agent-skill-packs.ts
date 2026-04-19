import type {
  AgentOperatingClass,
  AgentRole,
} from "./constants.js";

function uniqueSkillSlugs(values: readonly string[]) {
  return Array.from(new Set(values));
}

export const LEADERSHIP_GOVERNANCE_SKILL_SLUGS = uniqueSkillSlugs([
  "para-memory-files",
  "paperclip-create-agent",
  "find-skills",
  "openai-docs",
  "plan-ceo-review",
  "office-hours",
  "checkpoint",
]);

export const PROJECT_LEAD_ENGINEERING_MANAGEMENT_SKILL_SLUGS = uniqueSkillSlugs([
  "para-memory-files",
  "find-skills",
  "plan-eng-review",
  "review",
  "health",
  "investigate",
  "checkpoint",
]);

export const GENERAL_ENGINEER_EXECUTION_SKILL_SLUGS = uniqueSkillSlugs([
  "investigate",
  "review",
  "health",
  "security-best-practices",
  "playwright",
]);

export const FRONTEND_UI_SKILL_SLUGS = uniqueSkillSlugs([
  "impeccable",
  "shape",
  "clarify",
  "adapt",
  "arrange",
  "normalize",
  "polish",
  "optimize",
  "harden",
  "typeset",
  "extract",
  "critique",
  "react-doctor",
  "vercel-react-best-practices",
  "vercel-composition-patterns",
  "playwright",
  "playwright-interactive",
  "audit",
  "onboard",
]);

export const BACKEND_API_SKILL_SLUGS = uniqueSkillSlugs([
  "investigate",
  "review",
  "health",
  "security-best-practices",
  "supabase-postgres-best-practices",
  "openai-docs",
]);

export const QA_EVALS_SKILL_SLUGS = uniqueSkillSlugs([
  "playwright",
  "playwright-interactive",
  "audit",
  "qa-only",
  "benchmark",
  "browse",
  "spreadsheet",
]);

export const INFRA_RUNTIME_RELEASE_SKILL_SLUGS = uniqueSkillSlugs([
  "investigate",
  "health",
  "security-best-practices",
  "security-threat-model",
  "careful",
  "guard",
  "setup-deploy",
  "land-and-deploy",
  "canary",
  "benchmark",
]);

export const RESEARCH_SKILL_SLUGS = uniqueSkillSlugs([
  "arxiv",
  "research-paper-writing",
  "openai-docs",
  "pdf",
  "doc",
  "spreadsheet",
  "transcribe",
]);

export const GROWTH_ONBOARDING_MARKET_LEARNING_SKILL_SLUGS = uniqueSkillSlugs([
  "onboard",
  "clarify",
  "critique",
  "spreadsheet",
  "transcribe",
  "agent-browser",
]);

export const CONSULTING_SPECIALIST_SKILL_SLUGS = uniqueSkillSlugs([
  "find-skills",
]);

export const AUDIT_REVIEWER_SKILL_SLUGS = uniqueSkillSlugs([
  "audit",
  "critique",
  "security-best-practices",
  "qa-only",
  "playwright",
]);

export const COMPANY_SKILL_IMPORT_FOUNDATION_SLUGS = uniqueSkillSlugs([
  "para-memory-files",
  "paperclip-create-agent",
  "find-skills",
  "openai-docs",
  "plan-ceo-review",
  "plan-eng-review",
  "review",
  "health",
  "investigate",
  "checkpoint",
  "security-best-practices",
  "playwright",
  "audit",
  "supabase-postgres-best-practices",
]);

export const COMPANY_SKILL_IMPORT_UI_EXPANSION_SLUGS = uniqueSkillSlugs([
  "impeccable",
  "shape",
  "clarify",
  "adapt",
  "arrange",
  "normalize",
  "polish",
  "optimize",
  "harden",
  "typeset",
  "extract",
  "critique",
  "react-doctor",
  "vercel-react-best-practices",
  "vercel-composition-patterns",
  "onboard",
  "playwright-interactive",
]);

export const COMPANY_SKILL_IMPORT_OPS_RELEASE_EXPANSION_SLUGS = uniqueSkillSlugs([
  "qa-only",
  "benchmark",
  "browse",
  "careful",
  "guard",
  "setup-deploy",
  "land-and-deploy",
  "canary",
  "security-threat-model",
]);

export const COMPANY_SKILL_IMPORT_RESEARCH_GROWTH_EXPANSION_SLUGS = uniqueSkillSlugs([
  "arxiv",
  "research-paper-writing",
  "pdf",
  "doc",
  "spreadsheet",
  "transcribe",
  "agent-browser",
  "office-hours",
]);

export const DEFAULT_COMPANY_SKILL_IMPORT_SLUGS = uniqueSkillSlugs([
  ...COMPANY_SKILL_IMPORT_FOUNDATION_SLUGS,
  ...COMPANY_SKILL_IMPORT_UI_EXPANSION_SLUGS,
  ...COMPANY_SKILL_IMPORT_OPS_RELEASE_EXPANSION_SLUGS,
  ...COMPANY_SKILL_IMPORT_RESEARCH_GROWTH_EXPANSION_SLUGS,
]);

export type AgentSkillPackInput = {
  role?: AgentRole | string | null;
  operatingClass?: AgentOperatingClass | string | null;
  archetypeKey?: string | null;
};

export function getDefaultDesiredSkillSlugsForAgent(
  input: AgentSkillPackInput,
) {
  const archetypeKey = input.archetypeKey?.trim().toLowerCase() ?? null;

  if (archetypeKey === "project_lead") {
    return [...PROJECT_LEAD_ENGINEERING_MANAGEMENT_SKILL_SLUGS];
  }

  if (archetypeKey === "backend_api_continuity_owner") {
    return uniqueSkillSlugs([
      ...GENERAL_ENGINEER_EXECUTION_SKILL_SLUGS,
      ...BACKEND_API_SKILL_SLUGS,
    ]);
  }

  if (archetypeKey === "frontend_ui_continuity_owner") {
    return uniqueSkillSlugs([
      ...GENERAL_ENGINEER_EXECUTION_SKILL_SLUGS,
      ...FRONTEND_UI_SKILL_SLUGS,
    ]);
  }

  if (archetypeKey === "qa_evals_continuity_owner") {
    return [...QA_EVALS_SKILL_SLUGS];
  }

  if (archetypeKey === "infra_runtime_continuity_owner") {
    return uniqueSkillSlugs([
      ...GENERAL_ENGINEER_EXECUTION_SKILL_SLUGS,
      ...INFRA_RUNTIME_RELEASE_SKILL_SLUGS,
    ]);
  }

  if (archetypeKey === "audit_reviewer") {
    return [...AUDIT_REVIEWER_SKILL_SLUGS];
  }

  if (archetypeKey === "research_specialist") {
    return [...RESEARCH_SKILL_SLUGS];
  }

  if (archetypeKey === "growth_specialist") {
    return [...GROWTH_ONBOARDING_MARKET_LEARNING_SKILL_SLUGS];
  }

  if (archetypeKey === "consulting_specialist") {
    return [...CONSULTING_SPECIALIST_SKILL_SLUGS];
  }

  if (input.role === "ceo") {
    return [...LEADERSHIP_GOVERNANCE_SKILL_SLUGS];
  }

  if (input.operatingClass === "project_leadership") {
    return [...PROJECT_LEAD_ENGINEERING_MANAGEMENT_SKILL_SLUGS];
  }

  if (input.operatingClass === "worker" && input.role === "engineer") {
    return [...GENERAL_ENGINEER_EXECUTION_SKILL_SLUGS];
  }

  if (input.operatingClass === "consultant" && input.role === "researcher") {
    return [...RESEARCH_SKILL_SLUGS];
  }

  if (input.operatingClass === "consultant" && input.role === "general") {
    return [...CONSULTING_SPECIALIST_SKILL_SLUGS];
  }

  return [];
}
