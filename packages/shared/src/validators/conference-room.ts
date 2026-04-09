import { z } from "zod";
import { CONFERENCE_ROOM_STATUSES } from "../constants.js";
import type {
  ConferenceRoom,
  ConferenceRoomComment,
  ConferenceRoomDecisionSummary,
  ConferenceRoomIssueLinkSummary,
  ConferenceRoomParticipant,
} from "../types/conference-room.js";

function normalizeOptionalText(value: string | null | undefined): string | null | undefined {
  if (value == null) return value;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeIdList(value: string[] | undefined) {
  if (!value) return undefined;
  const normalized = Array.from(
    new Set(
      value
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  );
  return normalized.length > 0 ? normalized : [];
}

export const conferenceRoomStatusSchema = z.enum(CONFERENCE_ROOM_STATUSES);

export const createConferenceRoomSchema = z.object({
  title: z.string().trim().min(1),
  summary: z.string().trim().min(1),
  agenda: z.string().optional().nullable(),
  issueIds: z.array(z.string().uuid()).optional(),
  participantAgentIds: z.array(z.string().uuid()).optional(),
}).transform((value) => ({
  title: value.title.trim(),
  summary: value.summary.trim(),
  agenda: normalizeOptionalText(value.agenda),
  issueIds: normalizeIdList(value.issueIds) ?? [],
  participantAgentIds: normalizeIdList(value.participantAgentIds) ?? [],
}));

export type CreateConferenceRoom = z.infer<typeof createConferenceRoomSchema>;

export const updateConferenceRoomSchema = z.object({
  title: z.string().trim().min(1).optional(),
  summary: z.string().trim().min(1).optional(),
  agenda: z.string().optional().nullable(),
  issueIds: z.array(z.string().uuid()).optional(),
  participantAgentIds: z.array(z.string().uuid()).optional(),
  status: conferenceRoomStatusSchema.optional(),
}).transform((value) => ({
  ...(value.title !== undefined ? { title: value.title.trim() } : {}),
  ...(value.summary !== undefined ? { summary: value.summary.trim() } : {}),
  ...(value.agenda !== undefined ? { agenda: normalizeOptionalText(value.agenda) } : {}),
  ...(value.issueIds !== undefined ? { issueIds: normalizeIdList(value.issueIds) ?? [] } : {}),
  ...(value.participantAgentIds !== undefined
    ? { participantAgentIds: normalizeIdList(value.participantAgentIds) ?? [] }
    : {}),
  ...(value.status !== undefined ? { status: value.status } : {}),
}));

export type UpdateConferenceRoom = z.infer<typeof updateConferenceRoomSchema>;

export const addConferenceRoomCommentSchema = z.object({
  body: z.string().trim().min(1),
});

export type AddConferenceRoomComment = z.infer<typeof addConferenceRoomCommentSchema>;

export const requestConferenceRoomDecisionSchema = z.object({
  title: z.string().trim().min(1, "Title is required"),
  summary: z.string().trim().min(1, "Summary is required"),
  recommendedAction: z.string().optional(),
  nextActionOnApproval: z.string().optional(),
  risks: z.union([z.string(), z.array(z.string())]).optional(),
  proposedComment: z.string().optional(),
}).transform((value) => {
  const normalizedRisks = value.risks == null
    ? undefined
    : Array.isArray(value.risks)
      ? value.risks.map((entry) => entry.trim()).filter(Boolean)
      : value.risks.split("\n").map((entry) => entry.trim()).filter(Boolean);

  return {
    title: value.title.trim(),
    summary: value.summary.trim(),
    ...(normalizeOptionalText(value.recommendedAction) ? { recommendedAction: normalizeOptionalText(value.recommendedAction)! } : {}),
    ...(normalizeOptionalText(value.nextActionOnApproval)
      ? { nextActionOnApproval: normalizeOptionalText(value.nextActionOnApproval)! }
      : {}),
    ...(normalizedRisks && normalizedRisks.length > 0 ? { risks: normalizedRisks } : {}),
    ...(normalizeOptionalText(value.proposedComment) ? { proposedComment: normalizeOptionalText(value.proposedComment)! } : {}),
  };
});

export type RequestConferenceRoomDecision = z.infer<typeof requestConferenceRoomDecisionSchema>;

export const conferenceRoomParticipantSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  conferenceRoomId: z.string().uuid(),
  agentId: z.string().uuid(),
  addedByAgentId: z.string().uuid().nullable(),
  addedByUserId: z.string().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
}).strict() satisfies z.ZodType<ConferenceRoomParticipant>;

export const conferenceRoomCommentSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  conferenceRoomId: z.string().uuid(),
  authorAgentId: z.string().uuid().nullable(),
  authorUserId: z.string().nullable(),
  body: z.string().min(1),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
}).strict() satisfies z.ZodType<ConferenceRoomComment>;

export const conferenceRoomIssueLinkSummarySchema = z.object({
  issueId: z.string().uuid(),
  identifier: z.string().nullable(),
  title: z.string().min(1),
  status: z.string().min(1),
  priority: z.string().min(1),
  createdAt: z.coerce.date(),
}).strict() satisfies z.ZodType<ConferenceRoomIssueLinkSummary>;

export const conferenceRoomDecisionSummarySchema = z.object({
  approvalId: z.string().uuid(),
  status: z.enum(["pending", "revision_requested", "approved", "rejected", "cancelled"]),
  requestedByAgentId: z.string().uuid().nullable(),
  requestedByUserId: z.string().nullable(),
  title: z.string().min(1),
  summary: z.string().min(1),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
}).strict() satisfies z.ZodType<ConferenceRoomDecisionSummary>;

export const conferenceRoomSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  title: z.string().min(1),
  summary: z.string().min(1),
  agenda: z.string().nullable(),
  status: conferenceRoomStatusSchema,
  createdByAgentId: z.string().uuid().nullable(),
  createdByUserId: z.string().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  linkedIssues: z.array(conferenceRoomIssueLinkSummarySchema),
  participants: z.array(conferenceRoomParticipantSchema),
  decisions: z.array(conferenceRoomDecisionSummarySchema),
  latestCommentAt: z.coerce.date().nullable(),
}).strict() satisfies z.ZodType<ConferenceRoom>;
