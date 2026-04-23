import {
  DEFAULT_COMPANY_SKILL_IMPORT_SLUGS,
  getDefaultDesiredSkillSlugsForAgent,
  type GlobalSkillCatalogItem,
} from "@paperclipai/shared";

export const DEFAULT_COMPANY_BUDGET_CENTS = 5_000;
export const DEFAULT_ONBOARDING_PROJECT_BUDGET_CENTS = 2_500;
export const DEFAULT_STARTER_AGENT_BUDGET_CENTS = 0;
export const DEFAULT_WORKER_HEARTBEAT_INTERVAL_SEC = 300;
export const DEFAULT_OFFICE_OPERATOR_HEARTBEAT_INTERVAL_SEC = 300;

export const STARTER_AGENT_NAMES = {
  ceo: "CEO",
  officeOperator: "Chief of Staff",
  technicalProjectLead: "Technical Project Lead",
  backendContinuityOwner: "Backend/API Continuity Owner",
  qaEvalsContinuityOwner: "QA/Evals Continuity Owner",
} as const;

function buildStarterRoleNames(baseName: string, count: number) {
  return Array.from({ length: count }, (_, index) =>
    index === 0 ? baseName : `${baseName} ${index + 1}`,
  );
}

export const STARTER_BACKEND_CONTINUITY_OWNER_NAMES = buildStarterRoleNames(
  STARTER_AGENT_NAMES.backendContinuityOwner,
  2,
);
export const STARTER_QA_EVALS_CONTINUITY_OWNER_NAMES = buildStarterRoleNames(
  STARTER_AGENT_NAMES.qaEvalsContinuityOwner,
  3,
);

export const ONBOARDING_ROUTINE_TITLES = {
  dailyReadiness: "Daily readiness review",
  weeklyBudgetAudit: "Weekly budget and heartbeat audit",
  weeklyKickoffRiskReview: "Weekly kickoff and risk review",
} as const;

export const ONBOARDING_DEMO_TITLES = {
  planning: "Demo: plan the onboarding execution lane",
  review: "Demo: review onboarding readiness findings",
  handoff: "Demo: hand off onboarding follow-up",
} as const;

export const ONBOARDING_BRANCH_TITLE = "Demo branch: inspect onboarding bootstrap risks";
export const ONBOARDING_KICKOFF_ROOM_TITLE = "Onboarding Kickoff";
export const ONBOARDING_COMPANY_SKILL_IMPORT_SLUGS = [...DEFAULT_COMPANY_SKILL_IMPORT_SLUGS];
export const ONBOARDING_STARTER_SKILL_ASSIGNMENTS = {
  ceo: getDefaultDesiredSkillSlugsForAgent({ role: "ceo" }),
  officeOperator: getDefaultDesiredSkillSlugsForAgent({
    role: "coo",
    operatingClass: "executive",
    archetypeKey: "chief_of_staff",
  }),
  technicalProjectLead: getDefaultDesiredSkillSlugsForAgent({
    role: "engineer",
    operatingClass: "project_leadership",
    archetypeKey: "project_lead",
  }),
  backendContinuityOwner: getDefaultDesiredSkillSlugsForAgent({
    role: "engineer",
    operatingClass: "worker",
    archetypeKey: "backend_api_continuity_owner",
  }),
  qaEvalsContinuityOwner: getDefaultDesiredSkillSlugsForAgent({
    role: "qa",
    operatingClass: "worker",
    archetypeKey: "qa_evals_continuity_owner",
  }),
} as const;
export const ONBOARDING_REQUIRED_STARTER_SKILL_SLUGS = mergeDesiredSkillRefs(
  [],
  Object.values(ONBOARDING_STARTER_SKILL_ASSIGNMENTS).flat(),
);

export function mergeDesiredSkillRefs(currentRefs: string[], requiredRefs: string[]) {
  return Array.from(new Set([...currentRefs, ...requiredRefs]));
}

export function canonicalizeDesiredSkillRefs(
  refs: string[],
  slugToKey: Map<string, string>,
) {
  return Array.from(new Set(refs.map((ref) => slugToKey.get(ref) ?? ref))).sort();
}

export function buildGlobalCatalogInstallPlan(
  installedSlugs: Set<string>,
  catalog: GlobalSkillCatalogItem[],
  desiredSlugs: string[],
) {
  const catalogBySlug = new Map(catalog.map((item) => [item.slug, item] as const));
  const missingSlugs: string[] = [];
  const installCatalogKeys: string[] = [];

  for (const slug of desiredSlugs) {
    if (installedSlugs.has(slug)) continue;
    const item = catalogBySlug.get(slug);
    if (!item) {
      missingSlugs.push(slug);
      continue;
    }
    if (item.installedSkillId) continue;
    installCatalogKeys.push(item.catalogKey);
  }

  return { installCatalogKeys, missingSlugs };
}

export function buildFallbackCompanyGoal(companyName: string) {
  const trimmedName = companyName.trim() || "the company";
  return {
    title: `${trimmedName}: stand up an enterprise-ready operating company`,
    description:
      "Create a governed company with durable docs, company and project budgets, active routines, working heartbeats, and a visible governance path from kickoff through delivery.",
  };
}

export function buildOnboardingProjectGoal(input: {
  companyName: string;
  companyGoalTitle: string;
  ownerAgentId?: string | null;
  parentId?: string | null;
}) {
  return {
    title: "Onboarding: establish the first governed execution lane",
    description: [
      `Company goal: ${input.companyGoalTitle}`,
      `Company: ${input.companyName}`,
      "Launch a real kickoff, seed durable docs, and exercise planning, branch return, review return, and handoff flows.",
    ].join("\n"),
    level: "team" as const,
    status: "active" as const,
    parentId: input.parentId ?? null,
    ownerAgentId: input.ownerAgentId ?? null,
  };
}

export function buildCompanyDocumentBody(input: {
  companyName: string;
  companyGoalTitle: string;
}) {
  return [
    "# COMPANY.md",
    "",
    "## Charter",
    "",
    `- Company: ${input.companyName}`,
    `- Goal: ${input.companyGoalTitle}`,
    "- Standard: Operate with durable docs, explicit approvals for material decisions, and visible ownership across execution lanes.",
    "",
    "## Escalation Matrix",
    "",
    "- Board: Strategic direction, staffing changes, trust posture, and budget regime changes.",
    "- CEO: Kickoff sponsorship, prioritization, and turning decisions into owned work.",
    "- Chief of Staff: Company-wide routing, coordination, staffing-gap follow-up, and shared-skill proposal triage.",
    "- Project leadership: Break approved work into owned issues, dependencies, risks, and milestone intent.",
    "",
    "## Budget Regime",
    "",
    "- Company monthly budget: $50",
    "- Onboarding project budget: $25",
    "- Starter-agent budgets: unset by default.",
    "",
    "## Approval Regime",
    "",
    "- Conference rooms coordinate and surface questions, but they do not authorize high-impact changes by themselves.",
    "- Material direction, staffing, budget, or trust changes must resolve through an approval outcome.",
    "",
    "## Sandbox And Trust Posture",
    "",
    "- Default to the existing adapter/runtime trust posture for this workspace.",
    "- Escalate destructive or high-impact changes before acting.",
    "",
    "## Kickoff Rule",
    "",
    "- New projects and major approved plans entering execution must open a `project_leadership` kickoff room.",
  ].join("\n");
}

export function buildEngineeringTeamDocumentBody() {
  return [
    "# TEAM.md",
    "",
    "## Charter",
    "",
    "- Own project leadership breakdown, continuity docs, implementation routing, and dependency clarity for the onboarding lane.",
    "",
    "## Operating Rhythm",
    "",
    "- Join kickoff rooms, maintain the project context and runbook, and keep owned work decomposed before delegation.",
    "- Keep progress, risks, and branch returns durable in issue and project artifacts.",
    "",
    "## Interfaces",
    "",
    "- Coordinate with the CEO on priorities and approvals.",
    "- Coordinate with the Chief of Staff on intake routing, staffing gaps, and cross-project follow-up.",
    "- Coordinate with Operations on governance, release readiness, and shared-service requests.",
  ].join("\n");
}

export function buildOperationsTeamDocumentBody() {
  return [
    "# TEAM.md",
    "",
    "## Charter",
    "",
    "- Own company-wide coordination, routing, governance checks, heartbeat hygiene, and evidence-based operational follow-up for the onboarding lane.",
    "",
    "## Operating Rhythm",
    "",
    "- Sweep untriaged intake, blocked work, staffing gaps, engagement requests, and shared-skill proposal queues on a fixed cadence.",
    "- Route work through existing issue, engagement, and proposal artifacts rather than taking continuity ownership by default.",
    "",
    "## Interfaces",
    "",
    "- Work with Engineering on intake routing, staffing gaps, and blocked-work recovery.",
    "- Escalate company-level risk or policy drift to the CEO and board.",
  ].join("\n");
}

export function buildResearchTeamDocumentBody() {
  return [
    "# TEAM.md",
    "",
    "## Charter",
    "",
    "- Provide scoped research support, option analysis, and evidence gathering through explicit shared-service engagements.",
    "",
    "## Operating Rhythm",
    "",
    "- Stay dormant until a project lead or continuity owner requests a bounded research engagement.",
    "- Return findings as durable artifacts linked from the issue, branch return, or project docs instead of continuing execution by default.",
    "",
    "## Interfaces",
    "",
    "- Work with Engineering on architecture questions, unknowns, and comparative option analysis.",
    "- Escalate ambiguous scope or missing success criteria before continuing.",
  ].join("\n");
}

export function buildMarketingTeamDocumentBody() {
  return [
    "# TEAM.md",
    "",
    "## Charter",
    "",
    "- Provide growth, onboarding, and market-learning support through explicit shared-service engagements.",
    "",
    "## Operating Rhythm",
    "",
    "- Stay dormant until the company has a concrete launch, onboarding, or market-learning question.",
    "- Return bounded recommendations, experiment ideas, and evidence rather than becoming a standing execution lane by default.",
    "",
    "## Interfaces",
    "",
    "- Work with the CEO on company-level growth questions and with project leads on scoped onboarding or launch work.",
    "- Escalate unclear success criteria or unsupported requests before continuing.",
  ].join("\n");
}

export function buildOnboardingProjectDocuments(input: {
  companyName: string;
  companyGoalTitle: string;
  projectGoalTitle: string;
}) {
  return {
    context: [
      "# Context",
      "",
      `- Company goal: ${input.companyGoalTitle}`,
      `- Project goal: ${input.projectGoalTitle}`,
      "- Scope: Stand up a governed bootstrap lane with docs, kickoff coordination, routines, budgets, and visible continuity flows.",
      "- Success criteria: A fresh workspace can inspect goals, docs, kickoff, routines, heartbeats, and one full governance demo path without manual scaffolding.",
    ].join("\n"),
    "decision-log": [
      "# Decision Log",
      "",
      "- Default company and project budgets are non-zero and conservative.",
      "- Starter workers run timer heartbeats every 300 seconds with wake-on-demand enabled.",
      "- Kickoff outcomes live in project docs, issue plans, and decision logs rather than a new reserved artifact.",
      "",
      "## Open choices",
      "",
      "- Confirm any company-specific trust, budget, or staffing changes through approvals.",
    ].join("\n"),
    risks: [
      "# Risks",
      "",
      "- Risk: Bootstrap looks complete but durable docs stay empty. Owner: Continuity Owner. Mitigation: Scaffold and point users to native artifacts first.",
      "- Risk: Kickoff chat exists without owned work. Owner: Technical Project Lead. Mitigation: Seed the kickoff question and linked issues immediately.",
      "- Risk: Workers exist but never wake. Owner: Audit Reviewer. Mitigation: Default heartbeats on and review them in a routine.",
    ].join("\n"),
    runbook: [
      "# Runbook",
      "",
      `- Operate ${input.companyName} onboarding through the kickoff room, project docs, and issue continuity artifacts.`,
      "- Use the seeded demo issues to inspect branch return, review return, and handoff flows before opening live work.",
      "- Keep new decisions and plan changes durable in docs, not only in chat.",
    ].join("\n"),
  };
}

export function buildOnboardingKickoffQuestion(input: {
  companyName: string;
  projectGoalTitle: string;
}) {
  return [
    `Please confirm the ${input.companyName} onboarding kickoff.`,
    "",
    `Project goal: ${input.projectGoalTitle}`,
    "",
    "Reply in thread with:",
    "- scope",
    "- owned work breakdown",
    "- dependencies",
    "- milestone intent",
    "- key risks",
  ].join("\n");
}
