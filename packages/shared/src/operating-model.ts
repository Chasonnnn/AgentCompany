import {
  COMPANY_RESERVED_DOCUMENT_KEYS,
  CONFERENCE_ROOM_KINDS,
  ISSUE_RESERVED_DOCUMENT_KEYS,
  ISSUE_CONTINUITY_TIERS,
  ISSUE_QA_MODES,
  ISSUE_QA_RISK_TIERS,
  PROJECT_RESERVED_DOCUMENT_KEYS,
  TEAM_RESERVED_DOCUMENT_KEYS,
  type ConferenceRoomKind,
  type CompanyReservedDocumentKey,
  type IssueContinuityTier,
  type IssuePriority,
  type IssueQaMode,
  type IssueQaRiskTier,
  type IssueReservedDocumentKey,
  type ProjectReservedDocumentKey,
  type TeamReservedDocumentKey,
} from "./constants.js";
import type {
  ConferenceRoomKindDescriptor,
  PacketEnvelope,
  ReservedDocumentDescriptor,
} from "./types/operating-model.js";

export const PAPERCLIP_PACKET_KINDS = [
  "paperclip/assignment.v1",
  "paperclip/heartbeat.v1",
  "paperclip/decision-request.v1",
  "paperclip/review-request.v1",
  "paperclip/escalation.v1",
] as const;

export const ISSUE_PROGRESS_DOCUMENT_KIND = "paperclip/issue-progress.v1" as const;
export const ISSUE_HANDOFF_DOCUMENT_KIND = "paperclip/issue-handoff.v1" as const;
export const ISSUE_BRANCH_CHARTER_KIND = "paperclip/issue-branch-charter.v1" as const;
export const ISSUE_REVIEW_FINDINGS_DOCUMENT_KIND = "paperclip/issue-review-findings.v1" as const;
export const ISSUE_BRANCH_RETURN_DOCUMENT_KIND = "paperclip/issue-branch-return.v1" as const;
export const ISSUE_BRANCH_CHARTER_DOCUMENT_KEY = "branch-charter" as const;

const ISSUE_CONTINUITY_TIER_REQUIREMENTS: Record<IssueContinuityTier, string[]> = {
  tiny: ["spec", "progress"],
  normal: ["spec", "plan", "progress", "test-plan"],
  long_running: ["spec", "plan", "runbook", "progress", "test-plan", "handoff"],
};

export const ISSUE_QA_RISK_TIER_LABELS: Record<IssueQaRiskTier, string> = {
  low: "Low risk",
  medium: "Medium risk",
  high: "High risk",
  critical: "Critical risk",
};

export const ISSUE_QA_MODE_LABELS: Record<IssueQaMode, string> = {
  evidence_only: "Evidence only",
  qa_first: "QA first",
  independent_verify: "Independent verify",
  full_gate: "Full gate",
};

export interface IssueQaPolicyInput {
  title?: string | null;
  description?: string | null;
  labels?: Array<string | { name?: string | null; key?: string | null; slug?: string | null }> | null;
  originKind?: string | null;
  priority?: IssuePriority | string | null;
  changedPaths?: string[] | null;
  subsystemKeywords?: string[] | null;
}

export interface IssueQaPolicySuggestion {
  riskTier: IssueQaRiskTier;
  mode: IssueQaMode;
  reasons: string[];
}

function inputParts(input: IssueQaPolicyInput): string[] {
  const labels = (input.labels ?? []).map((label) => {
    if (typeof label === "string") return label;
    return label.name ?? label.key ?? label.slug ?? "";
  });
  return [
    input.title ?? "",
    input.description ?? "",
    input.originKind ?? "",
    input.priority ?? "",
    ...(input.changedPaths ?? []),
    ...(input.subsystemKeywords ?? []),
    ...labels,
  ].map((part) => part.toLowerCase());
}

function matchesAny(parts: string[], patterns: RegExp[]) {
  return patterns.some((pattern) => parts.some((part) => pattern.test(part)));
}

export function qaModeForRiskTier(riskTier: IssueQaRiskTier): IssueQaMode {
  switch (riskTier) {
    case "low":
      return "evidence_only";
    case "medium":
      return "independent_verify";
    case "high":
      return "qa_first";
    case "critical":
      return "full_gate";
  }
}

export function suggestIssueQaPolicy(input: IssueQaPolicyInput): IssueQaPolicySuggestion {
  const parts = inputParts(input);
  const reasons: string[] = [];

  const criticalPatterns = [
    /\bsecurity\b/,
    /\bsecret\b/,
    /\bdata[- ]?loss\b/,
    /\bdestructive\b/,
    /\bproduction[- ]?data\b/,
    /\bbudget\b.*\b(enforcement|hard[- ]?stop|pause)\b/,
    /\bapproval\b|\bgovernance\b/,
    /\bbroad\b.*\b(runtime|execution)\b/,
  ];
  if (input.priority === "critical" || matchesAny(parts, criticalPatterns)) {
    if (input.priority === "critical") reasons.push("critical priority");
    if (matchesAny(parts, criticalPatterns)) reasons.push("security, governance, budget, data-loss, or broad runtime signal");
    return { riskTier: "critical", mode: "full_gate", reasons };
  }

  const highPatterns = [
    /\b(db|database|schema|migration|drizzle|sql)\b/,
    /\b(auth|permission|access|company[- ]?scope|scoping)\b/,
    /\b(adapter|session|resume|heartbeat|schedule|scheduler|wake)\b/,
    /\b(memory|instruction|prompt[- ]?injection|agents\.md)\b/,
    /\b(cost|accounting|productivity|token)\b/,
  ];
  const hasBackendSignal = matchesAny(parts, [/\b(api|server|backend|route|service)\b/]);
  const hasUiSignal = matchesAny(parts, [/\b(ui|frontend|react|component|page)\b/]);
  if (matchesAny(parts, highPatterns) || (hasBackendSignal && hasUiSignal)) {
    if (matchesAny(parts, highPatterns)) reasons.push("high-risk subsystem signal");
    if (hasBackendSignal && hasUiSignal) reasons.push("cross-layer backend and UI signal");
    return { riskTier: "high", mode: "qa_first", reasons };
  }

  const lowPatterns = [
    /\b(doc|docs|readme|copy|wording|typo)\b/,
    /\b(polish|style|spacing|small ui)\b/,
    /\bisolated test\b|\btest[- ]?only\b/,
    /\bone[- ]?line\b|\btiny\b/,
  ];
  if (matchesAny(parts, lowPatterns)) {
    return { riskTier: "low", mode: "evidence_only", reasons: ["low-risk documentation, copy, polish, isolated-test, or tiny-fix signal"] };
  }

  return { riskTier: "medium", mode: "independent_verify", reasons: ["default contained-work policy"] };
}

export function parseIssueQaPolicyMarkdown(body: string): Pick<IssueQaPolicySuggestion, "riskTier" | "mode"> | null {
  const riskMatch = body.match(/risk\s*tier\s*:\s*`?([a-z_ -]+)`?/i);
  const modeMatch = body.match(/qa\s*mode\s*:\s*`?([a-z_ -]+)`?/i);
  const riskTier = riskMatch?.[1]?.trim().toLowerCase().replaceAll(" ", "_");
  const mode = modeMatch?.[1]?.trim().toLowerCase().replaceAll(" ", "_");
  if (
    !riskTier
    || !mode
    || !ISSUE_QA_RISK_TIERS.includes(riskTier as IssueQaRiskTier)
    || !ISSUE_QA_MODES.includes(mode as IssueQaMode)
  ) {
    return null;
  }
  return { riskTier: riskTier as IssueQaRiskTier, mode: mode as IssueQaMode };
}

export const PROJECT_RESERVED_DOCUMENT_DESCRIPTORS: Record<ProjectReservedDocumentKey, ReservedDocumentDescriptor> = {
  context: {
    key: "context",
    label: "Context",
    owner: "Project leadership",
    description: "Shared project context, priorities, and constraints curated for the whole lane.",
  },
  "decision-log": {
    key: "decision-log",
    label: "Decision Log",
    owner: "Project leadership",
    description: "Durable record of project decisions, tradeoffs, and outcomes.",
  },
  risks: {
    key: "risks",
    label: "Risks",
    owner: "Project leadership",
    description: "Open project risks, mitigations, and escalation signals.",
  },
  runbook: {
    key: "runbook",
    label: "Runbook",
    owner: "Project leadership",
    description: "Operational instructions, coordination norms, and repeatable procedures.",
  },
};

export const COMPANY_RESERVED_DOCUMENT_DESCRIPTORS: Record<CompanyReservedDocumentKey, ReservedDocumentDescriptor> = {
  company: {
    key: "company",
    label: "COMPANY.md",
    owner: "Board and CEO",
    description: "Durable company charter, operating regime, and bootstrap context.",
  },
};

export const TEAM_RESERVED_DOCUMENT_DESCRIPTORS: Record<TeamReservedDocumentKey, ReservedDocumentDescriptor> = {
  team: {
    key: "team",
    label: "TEAM.md",
    owner: "Department lead",
    description: "Durable team charter, routines, and operating instructions for a department lane.",
  },
};

export const ISSUE_RESERVED_DOCUMENT_DESCRIPTORS: Record<IssueReservedDocumentKey, ReservedDocumentDescriptor> = {
  spec: {
    key: "spec",
    label: "Spec",
    owner: "Continuity owner",
    description: "Frozen task intent, interfaces, and scoped requirements for the work.",
  },
  plan: {
    key: "plan",
    label: "Plan",
    owner: "Continuity owner",
    description: "Current execution plan and intended path to done.",
  },
  runbook: {
    key: "runbook",
    label: "Runbook",
    owner: "Continuity owner",
    description: "Issue-local operating instructions that override the project runbook when needed.",
  },
  progress: {
    key: "progress",
    label: "Progress",
    owner: "Continuity owner",
    description: "Snapshot plus append-only checkpoints for safe resume across sessions.",
  },
  "test-plan": {
    key: "test-plan",
    label: "Test Plan",
    owner: "QA or continuity owner",
    description: "Validation matrix and coverage notes for the current task.",
  },
  handoff: {
    key: "handoff",
    label: "Handoff",
    owner: "Continuity owner",
    description: "What the next owner or reviewer needs to know to continue safely.",
  },
  "review-findings": {
    key: "review-findings",
    label: "Review Findings",
    owner: "Reviewer or approver",
    description: "Durable findings and return-to-owner guidance captured at a review or approval gate.",
  },
  "branch-return": {
    key: "branch-return",
    label: "Branch Return",
    owner: "Branch owner",
    description: "Structured return artifact that proposes explicit parent updates before merge.",
  },
};

export const CONFERENCE_ROOM_KIND_DESCRIPTORS: Record<ConferenceRoomKind, ConferenceRoomKindDescriptor> = {
  executive_staff: {
    kind: "executive_staff",
    label: "Executive Staff",
    description: "Executive coordination and portfolio-level decision prep.",
  },
  project_leadership: {
    kind: "project_leadership",
    label: "Project Leadership",
    description: "Project leads, directors, and team leads coordinating delivery.",
  },
  architecture_review: {
    kind: "architecture_review",
    label: "Architecture Review",
    description: "Architecture and technical review forum with explicit rulings.",
  },
  incident: {
    kind: "incident",
    label: "Incident",
    description: "Time-sensitive incident coordination room with explicit update cadence.",
  },
  audit_release: {
    kind: "audit_release",
    label: "Audit / Release",
    description: "Audit, QA, or release review room with formal findings and closeout.",
  },
};

export function isPaperclipPacketKind(value: unknown): value is typeof PAPERCLIP_PACKET_KINDS[number] {
  return typeof value === "string" && PAPERCLIP_PACKET_KINDS.includes(value as typeof PAPERCLIP_PACKET_KINDS[number]);
}

export function isReservedProjectDocumentKey(value: string): value is ProjectReservedDocumentKey {
  return PROJECT_RESERVED_DOCUMENT_KEYS.includes(value as ProjectReservedDocumentKey);
}

export function isReservedCompanyDocumentKey(value: string): value is CompanyReservedDocumentKey {
  return COMPANY_RESERVED_DOCUMENT_KEYS.includes(value as CompanyReservedDocumentKey);
}

export function isReservedIssueDocumentKey(value: string): value is IssueReservedDocumentKey {
  return ISSUE_RESERVED_DOCUMENT_KEYS.includes(value as IssueReservedDocumentKey);
}

export function isReservedTeamDocumentKey(value: string): value is TeamReservedDocumentKey {
  return TEAM_RESERVED_DOCUMENT_KEYS.includes(value as TeamReservedDocumentKey);
}

export function getReservedProjectDocumentDescriptor(key: string): ReservedDocumentDescriptor | null {
  return isReservedProjectDocumentKey(key) ? PROJECT_RESERVED_DOCUMENT_DESCRIPTORS[key] : null;
}

export function getReservedCompanyDocumentDescriptor(key: string): ReservedDocumentDescriptor | null {
  return isReservedCompanyDocumentKey(key) ? COMPANY_RESERVED_DOCUMENT_DESCRIPTORS[key] : null;
}

export function getReservedIssueDocumentDescriptor(key: string): ReservedDocumentDescriptor | null {
  return isReservedIssueDocumentKey(key) ? ISSUE_RESERVED_DOCUMENT_DESCRIPTORS[key] : null;
}

export function getReservedTeamDocumentDescriptor(key: string): ReservedDocumentDescriptor | null {
  return isReservedTeamDocumentKey(key) ? TEAM_RESERVED_DOCUMENT_DESCRIPTORS[key] : null;
}

export function getConferenceRoomKindDescriptor(kind: ConferenceRoomKind | null | undefined): ConferenceRoomKindDescriptor | null {
  if (!kind || !CONFERENCE_ROOM_KINDS.includes(kind)) return null;
  return CONFERENCE_ROOM_KIND_DESCRIPTORS[kind];
}

export function getIssueContinuityTierRequirements(tier: IssueContinuityTier): string[] {
  return [...ISSUE_CONTINUITY_TIER_REQUIREMENTS[tier]];
}

export function buildIssueDocumentTemplate(
  key: string,
  context?: {
    title?: string | null;
    description?: string | null;
    tier?: IssueContinuityTier | null;
  },
): string | null {
  const title = context?.title?.trim() ?? "";
  const description = context?.description?.trim() ?? "";
  const tier = context?.tier ?? null;
  const taskLine = title ? `- ${title}` : "- State the concrete outcome this issue needs to produce.";
  const descriptionLine = description
    ? `- ${description}`
    : "- Explain why this work matters now and what changes when it is done.";
  const tierLine = tier
    ? `- Continuity tier: \`${tier}\``
    : "- Note whether this should stay tiny, normal, or long-running.";
  switch (key) {
    case "spec":
      return [
        "## Goal",
        "",
        taskLine,
        descriptionLine,
        "",
        "## Interfaces",
        "",
        "- List the documents, APIs, services, routes, or operators this issue must touch.",
        "",
        "## Constraints",
        "",
        tierLine,
        "- Record any scope, governance, runtime, or compatibility constraints that must not be violated.",
        "",
        "## Acceptance",
        "",
        "- Describe the observable outcome that proves the issue is done.",
        "- Include the verification that should pass before handoff or closeout.",
      ].join("\n");
    case "plan":
      return [
        "## Steps",
        "",
        "1. Review the current issue, code, and runtime evidence before changing anything.",
        "2. Make the smallest concrete change that moves the issue toward acceptance.",
        "3. Verify the result, update progress, and capture any follow-up work.",
        "",
        "## Risks",
        "",
        "- Note the most likely way this issue could drift, regress, or require escalation.",
      ].join("\n");
    case "runbook":
      return [
        "## Operating Notes",
        "",
        "- Record issue-local instructions that matter on every resume.",
        "",
        "## Overrides",
        "",
        "- Note any project runbook rules this issue intentionally overrides.",
        "",
        "## Resume Checklist",
        "",
        "- Read spec, plan, and progress before taking action.",
        "- Confirm the next action is still correct before continuing.",
      ].join("\n");
    case "progress":
      return [
        "---",
        `kind: ${ISSUE_PROGRESS_DOCUMENT_KIND}`,
        `summary: ${JSON.stringify(title ? `Issue created: ${title}` : "Issue created. Replace with the current execution summary.")}`,
        `currentState: ${JSON.stringify(description || "Continuity docs were scaffolded and the issue is ready for the first real checkpoint.")}`,
        'nextAction: "Read the spec and plan, then replace this scaffold with the first concrete execution step."',
        "knownPitfalls:",
        '  - "Do not let comments become the source of truth; keep continuity in the issue docs."',
        "openQuestions:",
        '  - "What is the first concrete slice of work that should happen on this issue?"',
        "evidence:",
        '  - "Link the first code path, doc, run, or artifact you inspect."',
        "checkpoints:",
        "  - at: 2026-04-14T00:00:00Z",
        "    completed:",
        '      - "Replace this example with the first real completed step."',
        '    currentState: "Describe what is true after that step."',
        "    knownPitfalls:",
        '      - "Record any trap you discovered while working."',
        '    nextAction: "State the exact next move from this checkpoint."',
        "    openQuestions:",
        '      - "Question to resolve before or during the next move."',
        "    evidence:",
        '      - "Artifact, test, commit, or proof from this checkpoint."',
        "---",
        "",
        "Replace the scaffolded snapshot quickly. Keep the structured fields current and use freeform notes only for supporting detail.",
      ].join("\n");
    case "test-plan":
      return [
        "## Risk and QA Mode",
        "",
        "- Risk tier: `medium`",
        "- QA mode: `independent_verify`",
        "- Low-risk work should keep evidence compact; high or critical work should name exact invariants before implementation.",
        "",
        "## Coverage",
        "",
        "- List the user-visible behavior, runtime path, or document contract this issue must validate.",
        "",
        "## Checks",
        "",
        "- Name the concrete tests, manual checks, or smoke paths to run before closeout.",
        "",
        "## Risks Not Covered",
        "",
        "- Be explicit about what will remain unverified after this issue ships.",
      ].join("\n");
    case "handoff":
      return [
        "---",
        `kind: ${ISSUE_HANDOFF_DOCUMENT_KIND}`,
        'reasonCode: "reassignment"',
        "timestamp: 2026-04-14T00:00:00Z",
        'transferTarget: "agent:<id> or user:<id>"',
        'exactNextAction: "The next owner should do this next"',
        "unresolvedBranches:",
        '  - "Child issue or branch reference"',
        "openQuestions:",
        '  - "Outstanding question"',
        "evidence:",
        '  - "Artifact or proof"',
        "---",
        "",
        "Optional narrative context for the next owner.",
      ].join("\n");
    case "review-findings":
      return [
        "---",
        `kind: ${ISSUE_REVIEW_FINDINGS_DOCUMENT_KIND}`,
        'reviewer: "agent:<id> or user:<id>"',
        'gateParticipant: "agent:<id> or user:<id>"',
        'reviewStage: "review or approval"',
        'decisionContext: "Why this gate is happening"',
        'outcome: "changes_requested"',
        'resolutionState: "open"',
        'ownerNextAction: "What the continuity owner must do next"',
        "findings:",
        "  - severity: critical",
        '    category: "correctness"',
        '    title: "Describe the finding"',
        '    detail: "What is wrong and why it matters"',
        '    requiredAction: "The exact fix or response needed"',
        "    evidence:",
        '      - "Link or artifact"',
        "---",
        "",
        "## Blocking Findings",
        "",
        "- Findings that must be addressed before approval or closeout.",
        "",
        "## Advisory Notes",
        "",
        "- Non-blocking quality notes or follow-up suggestions.",
      ].join("\n");
    case ISSUE_BRANCH_CHARTER_DOCUMENT_KEY:
      return [
        "---",
        `kind: ${ISSUE_BRANCH_CHARTER_KIND}`,
        'purpose: "Why this branch exists"',
        'scope: "Exactly what this branch may touch"',
        'budget: "Time, token, or review budget"',
        'expectedReturnArtifact: "Patch, findings, repro, or doc"',
        "mergeCriteria:",
        '  - "Condition for merging back"',
        'expiration: "2026-04-15T00:00:00Z"',
        'timeout: "Escalate or close after this condition"',
        "---",
        "",
        "Optional branch-specific notes.",
      ].join("\n");
    case "branch-return":
      return [
        "---",
        `kind: ${ISSUE_BRANCH_RETURN_DOCUMENT_KIND}`,
        'purposeScopeRecap: "What this branch was supposed to do"',
        'resultSummary: "What came back from the branch"',
        "proposedParentUpdates:",
        '  - documentKey: "plan"',
        '    action: "append"',
        '    summary: "What should change in the parent doc"',
        '    content: "Markdown content to apply"',
        "mergeChecklist:",
        '  - "What the parent owner should verify before merge"',
        "unresolvedRisks:",
        '  - "Risk or tradeoff that remains"',
        "openQuestions:",
        '  - "Open question for the parent owner"',
        "evidence:",
        '  - "Link or artifact"',
        "returnedArtifacts:",
        '  - "Patch, doc, or screenshot"',
        "---",
        "",
        "Optional branch return notes.",
      ].join("\n");
    default:
      return null;
  }
}

function normalizeScaffoldComparison(body: string): string {
  return body.replace(/\r\n/g, "\n").replace(/\s+$/g, "");
}

export function isIssueDocumentScaffoldBaseline(
  key: string,
  body: string,
  context?: {
    title?: string | null;
    description?: string | null;
    tier?: IssueContinuityTier | null;
  },
): boolean {
  const template = buildIssueDocumentTemplate(key, context);
  if (template == null) return false;
  return normalizeScaffoldComparison(body) === normalizeScaffoldComparison(template);
}

export function describePacketEnvelope(envelope: PacketEnvelope): { label: string; summary: string } {
  switch (envelope.kind) {
    case "paperclip/assignment.v1":
      return {
        label: "Assignment",
        summary: envelope.objective ?? envelope.scope ?? envelope.owner ?? "Assignment context",
      };
    case "paperclip/heartbeat.v1":
      return {
        label: "Heartbeat",
        summary: envelope.progress ?? envelope.state ?? "Status update",
      };
    case "paperclip/decision-request.v1":
      return {
        label: "Decision Request",
        summary: envelope.decisionNeeded ?? envelope.recommendedOption ?? "Decision pending",
      };
    case "paperclip/review-request.v1":
      return {
        label: "Review Request",
        summary: envelope.scope ?? envelope.reviewType ?? "Review requested",
      };
    case "paperclip/escalation.v1":
      return {
        label: "Escalation",
        summary: envelope.problem ?? envelope.neededDecisionOrResource ?? "Escalated issue",
      };
  }
}
