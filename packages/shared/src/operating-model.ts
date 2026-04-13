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
  plan: {
    key: "plan",
    label: "Plan",
    owner: "Current issue owner",
    description: "Current execution plan and intended path to done.",
  },
  spec: {
    key: "spec",
    label: "Spec",
    owner: "Issue owner",
    description: "Implementation details, interfaces, and scoped requirements for the task.",
  },
  "test-plan": {
    key: "test-plan",
    label: "Test Plan",
    owner: "QA or issue owner",
    description: "Validation matrix and coverage notes for the current task.",
  },
  handoff: {
    key: "handoff",
    label: "Handoff",
    owner: "Issue owner",
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
