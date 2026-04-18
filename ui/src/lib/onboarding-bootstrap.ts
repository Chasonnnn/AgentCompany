export const DEFAULT_COMPANY_BUDGET_CENTS = 5_000;
export const DEFAULT_ONBOARDING_PROJECT_BUDGET_CENTS = 2_500;
export const DEFAULT_STARTER_AGENT_BUDGET_CENTS = 1_000;
export const DEFAULT_WORKER_HEARTBEAT_INTERVAL_SEC = 300;

export const STARTER_AGENT_NAMES = {
  ceo: "CEO",
  technicalProjectLead: "Technical Project Lead",
  continuityOwner: "Continuity Owner",
  auditReviewer: "Audit Reviewer",
} as const;

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

export function buildFallbackCompanyGoal(companyName: string) {
  const trimmedName = companyName.trim() || "the company";
  return {
    title: `${trimmedName}: stand up an enterprise-ready operating company`,
    description:
      "Create a governed company with durable docs, non-zero budgets, active routines, working heartbeats, and a visible governance path from kickoff through delivery.",
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
    "- Project leadership: Break approved work into owned issues, dependencies, risks, and milestone intent.",
    "",
    "## Budget Regime",
    "",
    "- Company monthly budget: $50",
    "- Onboarding project budget: $25",
    "- Starter-agent monthly budgets: $10 each",
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
    "- Coordinate with Operations on audit findings, risks, and release readiness.",
  ].join("\n");
}

export function buildOperationsTeamDocumentBody() {
  return [
    "# TEAM.md",
    "",
    "## Charter",
    "",
    "- Own audit/review coverage, governance checks, heartbeat hygiene, and evidence-based findings for the onboarding lane.",
    "",
    "## Operating Rhythm",
    "",
    "- Review planning readiness, budget posture, and worker heartbeat health on a fixed cadence.",
    "- Return findings in durable review artifacts and route material issues to approvals when needed.",
    "",
    "## Interfaces",
    "",
    "- Work with Engineering on review findings and handoff repair.",
    "- Escalate company-level risk or policy drift to the CEO and board.",
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
      "- Default budgets are non-zero and conservative.",
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
