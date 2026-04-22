import { z } from "zod";
import {
  COMPANY_RESERVED_DOCUMENT_KEYS,
  CONFERENCE_ROOM_KINDS,
  ISSUE_RESERVED_DOCUMENT_KEYS,
  PROJECT_RESERVED_DOCUMENT_KEYS,
  TEAM_RESERVED_DOCUMENT_KEYS,
} from "../constants.js";
import type {
  AssignmentPacket,
  ConnectionContract,
  ConnectionContractCadence,
  DecisionRequestPacket,
  EscalationPacket,
  IssueBranchReturnDocument,
  IssueBranchReturnProposedUpdate,
  HeartbeatPacket,
  IssueBranchCharter,
  IssueHandoffDocument,
  IssueProgressCheckpoint,
  IssueProgressDocument,
  IssueReviewFinding,
  IssueReviewFindingsDocument,
  PacketEnvelope,
  ParsedIssueBranchReturnDocument,
  ParsedConnectionContract,
  ParsedIssueBranchCharter,
  ParsedIssueHandoffDocument,
  ParsedIssueProgressDocument,
  ParsedIssueReviewFindingsDocument,
  ParsedPacketEnvelope,
  ReviewRequestPacket,
} from "../types/operating-model.js";

function normalizeNullableText(value: string | null | undefined) {
  if (value == null) return value ?? null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeStringList(value: string[] | undefined) {
  if (!value) return [];
  return value
    .map((entry) => entry.trim())
    .filter((entry, index, all) => entry.length > 0 && all.indexOf(entry) === index);
}

export const connectionContractKindSchema = z.literal("paperclip/connection-contract.v1");

export const connectionContractCadenceSchema = z.object({
  workerUpdates: z.string().trim().min(1).nullable().optional(),
  teamLeadSummary: z.string().trim().min(1).nullable().optional(),
  projectLeadershipCheckIn: z.string().trim().min(1).nullable().optional(),
  executiveReview: z.string().trim().min(1).nullable().optional(),
  incidentUpdate: z.string().trim().min(1).nullable().optional(),
  consultingCloseout: z.string().trim().min(1).nullable().optional(),
  milestoneReset: z.string().trim().min(1).nullable().optional(),
}).transform((value) => ({
  workerUpdates: normalizeNullableText(value.workerUpdates),
  teamLeadSummary: normalizeNullableText(value.teamLeadSummary),
  projectLeadershipCheckIn: normalizeNullableText(value.projectLeadershipCheckIn),
  executiveReview: normalizeNullableText(value.executiveReview),
  incidentUpdate: normalizeNullableText(value.incidentUpdate),
  consultingCloseout: normalizeNullableText(value.consultingCloseout),
  milestoneReset: normalizeNullableText(value.milestoneReset),
})) as z.ZodType<ConnectionContractCadence>;

export type ConnectionContractCadenceInput = z.input<typeof connectionContractCadenceSchema>;

export const connectionContractSchema = z.object({
  upstreamInputs: z.array(z.string()).default([]),
  downstreamOutputs: z.array(z.string()).default([]),
  ownedArtifacts: z.array(z.string()).default([]),
  delegationRights: z.array(z.string()).default([]),
  reviewRights: z.array(z.string()).default([]),
  escalationPath: z.array(z.string()).default([]),
  standingRooms: z.array(z.string()).default([]),
  scopeBoundaries: z.array(z.string()).default([]),
  cadence: connectionContractCadenceSchema.nullable().optional(),
}).transform((value) => ({
  upstreamInputs: normalizeStringList(value.upstreamInputs),
  downstreamOutputs: normalizeStringList(value.downstreamOutputs),
  ownedArtifacts: normalizeStringList(value.ownedArtifacts),
  delegationRights: normalizeStringList(value.delegationRights),
  reviewRights: normalizeStringList(value.reviewRights),
  escalationPath: normalizeStringList(value.escalationPath),
  standingRooms: normalizeStringList(value.standingRooms),
  scopeBoundaries: normalizeStringList(value.scopeBoundaries),
  cadence: value.cadence ?? null,
})) as z.ZodType<ConnectionContract>;

export type ConnectionContractInput = z.input<typeof connectionContractSchema>;

const paperclipPacketKindSchema = z.enum([
  "paperclip/assignment.v1",
  "paperclip/heartbeat.v1",
  "paperclip/decision-request.v1",
  "paperclip/review-request.v1",
  "paperclip/escalation.v1",
]);

const packetBaseSchema = z.object({
  kind: paperclipPacketKindSchema,
}).passthrough();

const packetStringArraySchema = z.array(z.string()).optional();

export const assignmentPacketSchema = packetBaseSchema.extend({
  kind: z.literal("paperclip/assignment.v1"),
  owner: z.string().optional().nullable(),
  requestedBy: z.string().optional().nullable(),
  parentTask: z.string().optional().nullable(),
  objective: z.string().optional().nullable(),
  scope: z.string().optional().nullable(),
  nonGoals: packetStringArraySchema,
  dependencies: packetStringArraySchema,
  definitionOfDone: packetStringArraySchema,
  references: packetStringArraySchema,
  deadline: z.string().optional().nullable(),
  priority: z.string().optional().nullable(),
  escalateIf: packetStringArraySchema,
}).transform((value) => ({
  kind: value.kind,
  owner: normalizeNullableText(value.owner),
  requestedBy: normalizeNullableText(value.requestedBy),
  parentTask: normalizeNullableText(value.parentTask),
  objective: normalizeNullableText(value.objective),
  scope: normalizeNullableText(value.scope),
  nonGoals: normalizeStringList(value.nonGoals),
  dependencies: normalizeStringList(value.dependencies),
  definitionOfDone: normalizeStringList(value.definitionOfDone),
  references: normalizeStringList(value.references),
  deadline: normalizeNullableText(value.deadline),
  priority: normalizeNullableText(value.priority),
  escalateIf: normalizeStringList(value.escalateIf),
}));

export const heartbeatPacketSchema = packetBaseSchema.extend({
  kind: z.literal("paperclip/heartbeat.v1"),
  state: z.enum(["green", "yellow", "red"]).optional().nullable(),
  progress: z.string().optional().nullable(),
  completedSinceLastUpdate: packetStringArraySchema,
  nextActions: packetStringArraySchema,
  blockers: packetStringArraySchema,
  needFromManager: packetStringArraySchema,
  artifactsUpdated: packetStringArraySchema,
}).transform((value) => ({
  kind: value.kind,
  state: value.state ?? null,
  progress: normalizeNullableText(value.progress),
  completedSinceLastUpdate: normalizeStringList(value.completedSinceLastUpdate),
  nextActions: normalizeStringList(value.nextActions),
  blockers: normalizeStringList(value.blockers),
  needFromManager: normalizeStringList(value.needFromManager),
  artifactsUpdated: normalizeStringList(value.artifactsUpdated),
}));

export const decisionRequestPacketSchema = packetBaseSchema.extend({
  kind: z.literal("paperclip/decision-request.v1"),
  decisionNeeded: z.string().optional().nullable(),
  whyNow: z.string().optional().nullable(),
  optionsConsidered: packetStringArraySchema,
  recommendedOption: z.string().optional().nullable(),
  tradeoffs: packetStringArraySchema,
  impactIfDelayed: z.string().optional().nullable(),
  references: packetStringArraySchema,
}).transform((value) => ({
  kind: value.kind,
  decisionNeeded: normalizeNullableText(value.decisionNeeded),
  whyNow: normalizeNullableText(value.whyNow),
  optionsConsidered: normalizeStringList(value.optionsConsidered),
  recommendedOption: normalizeNullableText(value.recommendedOption),
  tradeoffs: normalizeStringList(value.tradeoffs),
  impactIfDelayed: normalizeNullableText(value.impactIfDelayed),
  references: normalizeStringList(value.references),
}));

export const reviewRequestPacketSchema = packetBaseSchema.extend({
  kind: z.literal("paperclip/review-request.v1"),
  reviewType: z.string().optional().nullable(),
  scope: z.string().optional().nullable(),
  acceptanceCriteria: packetStringArraySchema,
  specificQuestions: packetStringArraySchema,
  deadline: z.string().optional().nullable(),
  artifacts: packetStringArraySchema,
}).transform((value) => ({
  kind: value.kind,
  reviewType: normalizeNullableText(value.reviewType),
  scope: normalizeNullableText(value.scope),
  acceptanceCriteria: normalizeStringList(value.acceptanceCriteria),
  specificQuestions: normalizeStringList(value.specificQuestions),
  deadline: normalizeNullableText(value.deadline),
  artifacts: normalizeStringList(value.artifacts),
}));

export const escalationPacketSchema = packetBaseSchema.extend({
  kind: z.literal("paperclip/escalation.v1"),
  problem: z.string().optional().nullable(),
  currentOwner: z.string().optional().nullable(),
  whyBlocked: z.string().optional().nullable(),
  attempted: packetStringArraySchema,
  neededDecisionOrResource: z.string().optional().nullable(),
  affectedParties: packetStringArraySchema,
  timeSensitivity: z.string().optional().nullable(),
}).transform((value) => ({
  kind: value.kind,
  problem: normalizeNullableText(value.problem),
  currentOwner: normalizeNullableText(value.currentOwner),
  whyBlocked: normalizeNullableText(value.whyBlocked),
  attempted: normalizeStringList(value.attempted),
  neededDecisionOrResource: normalizeNullableText(value.neededDecisionOrResource),
  affectedParties: normalizeStringList(value.affectedParties),
  timeSensitivity: normalizeNullableText(value.timeSensitivity),
}));

export const packetEnvelopeSchema = z.union([
  assignmentPacketSchema,
  heartbeatPacketSchema,
  decisionRequestPacketSchema,
  reviewRequestPacketSchema,
  escalationPacketSchema,
]) as z.ZodType<PacketEnvelope>;

export const conferenceRoomKindSchema = z.enum(CONFERENCE_ROOM_KINDS);
export const companyReservedDocumentKeySchema = z.enum(COMPANY_RESERVED_DOCUMENT_KEYS);
export const projectReservedDocumentKeySchema = z.enum(PROJECT_RESERVED_DOCUMENT_KEYS);
export const issueReservedDocumentKeySchema = z.enum(ISSUE_RESERVED_DOCUMENT_KEYS);
export const teamReservedDocumentKeySchema = z.enum(TEAM_RESERVED_DOCUMENT_KEYS);

const issueProgressDocumentKindSchema = z.literal("paperclip/issue-progress.v1");
const issueHandoffDocumentKindSchema = z.literal("paperclip/issue-handoff.v1");
const issueBranchCharterKindSchema = z.literal("paperclip/issue-branch-charter.v1");
const issueReviewFindingsDocumentKindSchema = z.literal("paperclip/issue-review-findings.v1");
const issueBranchReturnDocumentKindSchema = z.literal("paperclip/issue-branch-return.v1");

export const issueProgressCheckpointSchema = z.object({
  at: z.string().trim().min(1).nullable().optional(),
  completed: z.array(z.string()).optional().default([]),
  currentState: z.string().trim().min(1),
  knownPitfalls: z.array(z.string()).optional().default([]),
  nextAction: z.string().trim().min(1),
  openQuestions: z.array(z.string()).optional().default([]),
  evidence: z.array(z.string()).optional().default([]),
}).transform((value) => ({
  at: normalizeNullableText(value.at),
  completed: normalizeStringList(value.completed),
  currentState: value.currentState.trim(),
  knownPitfalls: normalizeStringList(value.knownPitfalls),
  nextAction: value.nextAction.trim(),
  openQuestions: normalizeStringList(value.openQuestions),
  evidence: normalizeStringList(value.evidence),
})) as z.ZodType<IssueProgressCheckpoint>;

export const issueProgressDocumentSchema = z.object({
  kind: issueProgressDocumentKindSchema,
  summary: z.string().trim().min(1).nullable().optional(),
  currentState: z.string().trim().min(1),
  knownPitfalls: z.array(z.string()).optional().default([]),
  nextAction: z.string().trim().min(1),
  openQuestions: z.array(z.string()).optional().default([]),
  evidence: z.array(z.string()).optional().default([]),
  checkpoints: z.array(issueProgressCheckpointSchema).optional().default([]),
}).transform((value) => ({
  kind: value.kind,
  summary: normalizeNullableText(value.summary),
  currentState: value.currentState.trim(),
  knownPitfalls: normalizeStringList(value.knownPitfalls),
  nextAction: value.nextAction.trim(),
  openQuestions: normalizeStringList(value.openQuestions),
  evidence: normalizeStringList(value.evidence),
  checkpoints: value.checkpoints,
})) as z.ZodType<IssueProgressDocument>;

export const issueHandoffDocumentSchema = z.object({
  kind: issueHandoffDocumentKindSchema,
  reasonCode: z.string().trim().min(1),
  timestamp: z.string().trim().min(1),
  transferTarget: z.string().trim().min(1),
  exactNextAction: z.string().trim().min(1),
  unresolvedBranches: z.array(z.string()).optional().default([]),
  openQuestions: z.array(z.string()).optional().default([]),
  evidence: z.array(z.string()).optional().default([]),
}).transform((value) => ({
  kind: value.kind,
  reasonCode: value.reasonCode.trim(),
  timestamp: value.timestamp.trim(),
  transferTarget: value.transferTarget.trim(),
  exactNextAction: value.exactNextAction.trim(),
  unresolvedBranches: normalizeStringList(value.unresolvedBranches),
  openQuestions: normalizeStringList(value.openQuestions),
  evidence: normalizeStringList(value.evidence),
})) as z.ZodType<IssueHandoffDocument>;

export const issueBranchCharterSchema = z.object({
  kind: issueBranchCharterKindSchema,
  purpose: z.string().trim().min(1),
  scope: z.string().trim().min(1),
  budget: z.string().trim().min(1),
  expectedReturnArtifact: z.string().trim().min(1),
  mergeCriteria: z.array(z.string()).optional().default([]),
  expiration: z.string().trim().min(1).nullable().optional(),
  timeout: z.string().trim().min(1).nullable().optional(),
}).transform((value) => ({
  kind: value.kind,
  purpose: value.purpose.trim(),
  scope: value.scope.trim(),
  budget: value.budget.trim(),
  expectedReturnArtifact: value.expectedReturnArtifact.trim(),
  mergeCriteria: normalizeStringList(value.mergeCriteria),
  expiration: normalizeNullableText(value.expiration),
  timeout: normalizeNullableText(value.timeout),
})) as z.ZodType<IssueBranchCharter>;

export const issueReviewFindingSchema = z.object({
  findingId: z.string().trim().min(1).nullable().optional(),
  severity: z.enum(["critical", "high", "medium", "low"]),
  category: z.string().trim().min(1),
  title: z.string().trim().min(1),
  detail: z.string().trim().min(1),
  requiredAction: z.string().trim().min(1),
  evidence: z.array(z.string()).optional().default([]),
  skillPromotion: z.object({
    hardeningIssueId: z.string().uuid().nullable().optional(),
    hardeningIssueIdentifier: z.string().trim().min(1).nullable().optional(),
    companySkillId: z.string().uuid().nullable().optional(),
    companySkillKey: z.string().trim().min(1).nullable().optional(),
    sharedSkillId: z.string().uuid().nullable().optional(),
    sharedSkillProposalId: z.string().uuid().nullable().optional(),
    sharedSkillProposalStatus: z.enum(["pending", "revision_requested", "approved", "rejected", "superseded"]).nullable().optional(),
    sourceRunId: z.string().uuid().nullable().optional(),
    failureFingerprint: z.string().trim().min(1).nullable().optional(),
    promotedAt: z.string().trim().min(1).nullable().optional(),
    promotedBy: z.string().trim().min(1).nullable().optional(),
  }).nullable().optional(),
}).transform((value) => ({
  findingId: normalizeNullableText(value.findingId),
  severity: value.severity,
  category: value.category.trim(),
  title: value.title.trim(),
  detail: value.detail.trim(),
  requiredAction: value.requiredAction.trim(),
  evidence: normalizeStringList(value.evidence),
  skillPromotion: value.skillPromotion
    ? {
      hardeningIssueId: value.skillPromotion.hardeningIssueId ?? null,
      hardeningIssueIdentifier: normalizeNullableText(value.skillPromotion.hardeningIssueIdentifier),
      companySkillId: value.skillPromotion.companySkillId ?? null,
      companySkillKey: normalizeNullableText(value.skillPromotion.companySkillKey),
      sharedSkillId: value.skillPromotion.sharedSkillId ?? null,
      sharedSkillProposalId: value.skillPromotion.sharedSkillProposalId ?? null,
      sharedSkillProposalStatus: value.skillPromotion.sharedSkillProposalStatus ?? null,
      sourceRunId: value.skillPromotion.sourceRunId ?? null,
      failureFingerprint: normalizeNullableText(value.skillPromotion.failureFingerprint),
      promotedAt: normalizeNullableText(value.skillPromotion.promotedAt),
      promotedBy: normalizeNullableText(value.skillPromotion.promotedBy),
    }
    : null,
})) as z.ZodType<IssueReviewFinding>;

export const issueReviewFindingsDocumentSchema = z.object({
  kind: issueReviewFindingsDocumentKindSchema,
  reviewer: z.string().trim().min(1),
  gateParticipant: z.string().trim().min(1),
  reviewStage: z.string().trim().min(1),
  decisionContext: z.string().trim().min(1).nullable().optional(),
  outcome: z.enum(["changes_requested", "approved_with_notes", "blocked"]),
  resolutionState: z.enum(["open", "addressed"]).optional().default("open"),
  ownerNextAction: z.string().trim().min(1),
  ownerResponseNote: z.string().trim().min(1).nullable().optional(),
  addressedAt: z.string().trim().min(1).nullable().optional(),
  findings: z.array(issueReviewFindingSchema).min(1),
}).transform((value) => ({
  kind: value.kind,
  reviewer: value.reviewer.trim(),
  gateParticipant: value.gateParticipant.trim(),
  reviewStage: value.reviewStage.trim(),
  decisionContext: normalizeNullableText(value.decisionContext),
  outcome: value.outcome,
  resolutionState: value.resolutionState,
  ownerNextAction: value.ownerNextAction.trim(),
  ownerResponseNote: normalizeNullableText(value.ownerResponseNote),
  addressedAt: normalizeNullableText(value.addressedAt),
  findings: value.findings,
})) as z.ZodType<IssueReviewFindingsDocument>;

export const issueBranchReturnProposedUpdateSchema = z.object({
  documentKey: z.string().trim().min(1),
  action: z.enum(["append", "replace"]),
  summary: z.string().trim().min(1),
  content: z.string().trim().min(1),
  title: z.string().trim().min(1).nullable().optional(),
}).transform((value) => ({
  documentKey: value.documentKey.trim(),
  action: value.action,
  summary: value.summary.trim(),
  content: value.content.trim(),
  title: normalizeNullableText(value.title),
})) as z.ZodType<IssueBranchReturnProposedUpdate>;

export const issueBranchReturnDocumentSchema = z.object({
  kind: issueBranchReturnDocumentKindSchema,
  purposeScopeRecap: z.string().trim().min(1),
  resultSummary: z.string().trim().min(1),
  proposedParentUpdates: z.array(issueBranchReturnProposedUpdateSchema).default([]),
  mergeChecklist: z.array(z.string()).optional().default([]),
  unresolvedRisks: z.array(z.string()).optional().default([]),
  openQuestions: z.array(z.string()).optional().default([]),
  evidence: z.array(z.string()).optional().default([]),
  returnedArtifacts: z.array(z.string()).optional().default([]),
}).transform((value) => ({
  kind: value.kind,
  purposeScopeRecap: value.purposeScopeRecap.trim(),
  resultSummary: value.resultSummary.trim(),
  proposedParentUpdates: value.proposedParentUpdates,
  mergeChecklist: normalizeStringList(value.mergeChecklist),
  unresolvedRisks: normalizeStringList(value.unresolvedRisks),
  openQuestions: normalizeStringList(value.openQuestions),
  evidence: normalizeStringList(value.evidence),
  returnedArtifacts: normalizeStringList(value.returnedArtifacts),
})) as z.ZodType<IssueBranchReturnDocument>;

type FrontmatterDoc = {
  frontmatter: Record<string, unknown>;
  body: string;
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseYamlScalar(raw: string): unknown {
  const value = raw.trim();
  if (!value.length) return "";
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null" || value === "~") return null;
  if (/^-?\d+$/.test(value)) return Number.parseInt(value, 10);
  if (/^-?\d+\.\d+$/.test(value)) return Number.parseFloat(value);
  if (
    (value.startsWith("\"") && value.endsWith("\""))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    if (value.startsWith("\"") && value.endsWith("\"")) {
      try {
        return JSON.parse(value);
      } catch {
        return value.slice(1, -1);
      }
    }
    return value.slice(1, -1);
  }
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (!inner.length) return [];
    return inner.split(",").map((entry) => parseYamlScalar(entry));
  }
  if (value.startsWith("{") && value.endsWith("}")) {
    const inner = value.slice(1, -1).trim();
    if (!inner.length) return {};
    const record: Record<string, unknown> = {};
    for (const part of inner.split(",")) {
      const separator = part.indexOf(":");
      if (separator <= 0) continue;
      const key = part.slice(0, separator).trim().replace(/^["']|["']$/g, "");
      const nextValue = part.slice(separator + 1).trim();
      record[key] = parseYamlScalar(nextValue);
    }
    return record;
  }
  return value;
}

type PreparedYamlLine = {
  indent: number;
  content: string;
};

function prepareYamlLines(raw: string): PreparedYamlLine[] {
  return raw
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\t/g, "  "))
    .filter((line) => line.trim().length > 0 && !line.trimStart().startsWith("#"))
    .map((line) => ({
      indent: line.length - line.trimStart().length,
      content: line.trim(),
    }));
}

function parseYamlBlock(
  lines: PreparedYamlLine[],
  startIndex: number,
  indentLevel: number,
): { value: unknown; nextIndex: number } {
  let index = startIndex;
  while (index < lines.length && lines[index]!.content.length === 0) index += 1;
  if (index >= lines.length || lines[index]!.indent < indentLevel) {
    return { value: {}, nextIndex: index };
  }

  const isArray = lines[index]!.indent === indentLevel && lines[index]!.content.startsWith("-");
  if (isArray) {
    const values: unknown[] = [];
    while (index < lines.length) {
      const line = lines[index]!;
      if (line.indent < indentLevel) break;
      if (line.indent !== indentLevel || !line.content.startsWith("-")) break;
      const remainder = line.content.slice(1).trim();
      index += 1;
      if (!remainder) {
        const nested = parseYamlBlock(lines, index, indentLevel + 2);
        values.push(nested.value);
        index = nested.nextIndex;
        continue;
      }
      const inlineObjectSeparator = remainder.indexOf(":");
      if (
        inlineObjectSeparator > 0
        && !remainder.startsWith("\"")
        && !remainder.startsWith("{")
        && !remainder.startsWith("[")
      ) {
        const key = remainder.slice(0, inlineObjectSeparator).trim();
        const rawValue = remainder.slice(inlineObjectSeparator + 1).trim();
        const nextObject: Record<string, unknown> = {
          [key]: parseYamlScalar(rawValue),
        };
        if (index < lines.length && lines[index]!.indent > indentLevel) {
          const nested = parseYamlBlock(lines, index, indentLevel + 2);
          if (isPlainRecord(nested.value)) {
            Object.assign(nextObject, nested.value);
          }
          index = nested.nextIndex;
        }
        values.push(nextObject);
        continue;
      }
      values.push(parseYamlScalar(remainder));
    }
    return { value: values, nextIndex: index };
  }

  const record: Record<string, unknown> = {};
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.indent < indentLevel) break;
    if (line.indent !== indentLevel) {
      index += 1;
      continue;
    }
    const separatorIndex = line.content.indexOf(":");
    if (separatorIndex <= 0) {
      index += 1;
      continue;
    }
    const key = line.content.slice(0, separatorIndex).trim();
    const remainder = line.content.slice(separatorIndex + 1).trim();
    index += 1;
    if (!remainder) {
      const nested = parseYamlBlock(lines, index, indentLevel + 2);
      record[key] = nested.value;
      index = nested.nextIndex;
      continue;
    }
    record[key] = parseYamlScalar(remainder);
  }
  return { value: record, nextIndex: index };
}

export function parseYamlFrontmatter(raw: string): Record<string, unknown> {
  const prepared = prepareYamlLines(raw);
  if (prepared.length === 0) return {};
  const parsed = parseYamlBlock(prepared, 0, prepared[0]!.indent);
  return isPlainRecord(parsed.value) ? parsed.value : {};
}

export function parseFrontmatterMarkdown(raw: string): FrontmatterDoc {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { frontmatter: {}, body: normalized.trim() };
  }
  const closing = normalized.indexOf("\n---\n", 4);
  if (closing < 0) {
    return { frontmatter: {}, body: normalized.trim() };
  }
  const frontmatterRaw = normalized.slice(4, closing).trim();
  const body = normalized.slice(closing + 5).trim();
  return {
    frontmatter: parseYamlFrontmatter(frontmatterRaw),
    body,
  };
}

export function parsePacketEnvelopeMarkdown(raw: string): ParsedPacketEnvelope | null {
  const parsed = parseFrontmatterMarkdown(raw);
  if (!parsed.frontmatter.kind || typeof parsed.frontmatter.kind !== "string") return null;
  if (!parsed.frontmatter.kind.startsWith("paperclip/")) return null;
  const envelope = packetEnvelopeSchema.safeParse(parsed.frontmatter);
  if (!envelope.success) return null;
  return {
    envelope: envelope.data,
    body: parsed.body,
    frontmatter: parsed.frontmatter,
  };
}

export function parseConnectionContractMarkdown(raw: string): ParsedConnectionContract | null {
  const parsed = parseFrontmatterMarkdown(raw);
  if (parsed.frontmatter.connectionContractKind !== "paperclip/connection-contract.v1") return null;
  const contract = connectionContractSchema.safeParse(parsed.frontmatter.connectionContract);
  if (!contract.success) return null;
  return {
    connectionContractKind: "paperclip/connection-contract.v1",
    connectionContract: contract.data,
    body: parsed.body,
    frontmatter: parsed.frontmatter,
  };
}

export function parseIssueProgressMarkdown(raw: string): ParsedIssueProgressDocument | null {
  const parsed = parseFrontmatterMarkdown(raw);
  if (parsed.frontmatter.kind !== "paperclip/issue-progress.v1") return null;
  const document = issueProgressDocumentSchema.safeParse(parsed.frontmatter);
  if (!document.success) return null;
  return {
    document: document.data,
    body: parsed.body,
    frontmatter: parsed.frontmatter,
  };
}

export function parseIssueHandoffMarkdown(raw: string): ParsedIssueHandoffDocument | null {
  const parsed = parseFrontmatterMarkdown(raw);
  if (parsed.frontmatter.kind !== "paperclip/issue-handoff.v1") return null;
  const document = issueHandoffDocumentSchema.safeParse(parsed.frontmatter);
  if (!document.success) return null;
  return {
    document: document.data,
    body: parsed.body,
    frontmatter: parsed.frontmatter,
  };
}

export function parseIssueBranchCharterMarkdown(raw: string): ParsedIssueBranchCharter | null {
  const parsed = parseFrontmatterMarkdown(raw);
  if (parsed.frontmatter.kind !== "paperclip/issue-branch-charter.v1") return null;
  const document = issueBranchCharterSchema.safeParse(parsed.frontmatter);
  if (!document.success) return null;
  return {
    document: document.data,
    body: parsed.body,
    frontmatter: parsed.frontmatter,
  };
}

export function parseIssueReviewFindingsMarkdown(raw: string): ParsedIssueReviewFindingsDocument | null {
  const parsed = parseFrontmatterMarkdown(raw);
  if (parsed.frontmatter.kind !== "paperclip/issue-review-findings.v1") return null;
  const document = issueReviewFindingsDocumentSchema.safeParse(parsed.frontmatter);
  if (!document.success) return null;
  return {
    document: document.data,
    body: parsed.body,
    frontmatter: parsed.frontmatter,
  };
}

export function parseIssueBranchReturnMarkdown(raw: string): ParsedIssueBranchReturnDocument | null {
  const parsed = parseFrontmatterMarkdown(raw);
  if (parsed.frontmatter.kind !== "paperclip/issue-branch-return.v1") return null;
  const document = issueBranchReturnDocumentSchema.safeParse(parsed.frontmatter);
  if (!document.success) return null;
  return {
    document: document.data,
    body: parsed.body,
    frontmatter: parsed.frontmatter,
  };
}
