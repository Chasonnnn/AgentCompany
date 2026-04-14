import {
  CONFERENCE_ROOM_KINDS,
  ISSUE_RESERVED_DOCUMENT_KEYS,
  PROJECT_RESERVED_DOCUMENT_KEYS,
  type ConferenceRoomKind,
  type IssueReservedDocumentKey,
  type ProjectReservedDocumentKey,
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
export const ISSUE_BRANCH_CHARTER_DOCUMENT_KEY = "branch-charter" as const;
export const ISSUE_CONTINUITY_TIERS = ["tiny", "normal", "long_running"] as const;
export type IssueContinuityTier = (typeof ISSUE_CONTINUITY_TIERS)[number];

const ISSUE_CONTINUITY_TIER_REQUIREMENTS: Record<IssueContinuityTier, string[]> = {
  tiny: ["spec", "progress"],
  normal: ["spec", "plan", "progress", "test-plan"],
  long_running: ["spec", "plan", "runbook", "progress", "test-plan", "handoff"],
};

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

export function isReservedIssueDocumentKey(value: string): value is IssueReservedDocumentKey {
  return ISSUE_RESERVED_DOCUMENT_KEYS.includes(value as IssueReservedDocumentKey);
}

export function getReservedProjectDocumentDescriptor(key: string): ReservedDocumentDescriptor | null {
  return isReservedProjectDocumentKey(key) ? PROJECT_RESERVED_DOCUMENT_DESCRIPTORS[key] : null;
}

export function getReservedIssueDocumentDescriptor(key: string): ReservedDocumentDescriptor | null {
  return isReservedIssueDocumentKey(key) ? ISSUE_RESERVED_DOCUMENT_DESCRIPTORS[key] : null;
}

export function getConferenceRoomKindDescriptor(kind: ConferenceRoomKind | null | undefined): ConferenceRoomKindDescriptor | null {
  if (!kind || !CONFERENCE_ROOM_KINDS.includes(kind)) return null;
  return CONFERENCE_ROOM_KIND_DESCRIPTORS[kind];
}

export function getIssueContinuityTierRequirements(tier: IssueContinuityTier): string[] {
  return [...ISSUE_CONTINUITY_TIER_REQUIREMENTS[tier]];
}

export function buildIssueDocumentTemplate(key: string): string | null {
  switch (key) {
    case "spec":
      return [
        "## Goal",
        "",
        "-",
        "",
        "## Interfaces",
        "",
        "-",
        "",
        "## Constraints",
        "",
        "-",
        "",
        "## Acceptance",
        "",
        "-",
      ].join("\n");
    case "plan":
      return [
        "## Steps",
        "",
        "1. ",
        "2. ",
        "3. ",
        "",
        "## Risks",
        "",
        "-",
      ].join("\n");
    case "runbook":
      return [
        "## Operating Notes",
        "",
        "-",
        "",
        "## Overrides",
        "",
        "-",
        "",
        "## Resume Checklist",
        "",
        "-",
      ].join("\n");
    case "progress":
      return [
        "---",
        `kind: ${ISSUE_PROGRESS_DOCUMENT_KIND}`,
        'summary: "Current state at a glance"',
        'currentState: "What is true right now"',
        'nextAction: "The exact next action"',
        "knownPitfalls:",
        '  - "Pitfall or trap to avoid"',
        "openQuestions:",
        '  - "Open question, if any"',
        "evidence:",
        '  - "Link, test, commit, or artifact"',
        "checkpoints:",
        "  - at: 2026-04-14T00:00:00Z",
        "    completed:",
        '      - "Completed item"',
        '    currentState: "Checkpoint state"',
        "    knownPitfalls:",
        '      - "Observed pitfall"',
        '    nextAction: "Next move from this checkpoint"',
        "    openQuestions:",
        '      - "Question to resolve"',
        "    evidence:",
        '      - "Artifact or proof"',
        "---",
        "",
        "Add any freeform notes below the structured snapshot if needed.",
      ].join("\n");
    case "test-plan":
      return [
        "## Coverage",
        "",
        "-",
        "",
        "## Checks",
        "",
        "-",
        "",
        "## Risks Not Covered",
        "",
        "-",
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
    default:
      return null;
  }
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
