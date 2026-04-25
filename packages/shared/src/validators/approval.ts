import { z } from "zod";
import { APPROVAL_TYPES } from "../constants.js";
import type { RequestBoardApprovalPayload } from "../types/approval.js";
import { conferenceContextSchema } from "./conference-context.js";
import { multilineTextSchema } from "./text.js";

function normalizeOptionalText(value: string | null | undefined): string | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeRisks(value: string | string[] | undefined): string[] | undefined {
  if (value == null) return undefined;
  const source = Array.isArray(value) ? value : value.split("\n");
  const normalized = source
    .map((entry) => entry.trim())
    .filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeIdList(value: string[] | undefined): string[] | undefined {
  if (value == null) return undefined;
  const normalized = Array.from(new Set(
    value
      .map((entry) => entry.trim())
      .filter(Boolean),
  ));
  return normalized.length > 0 ? normalized : undefined;
}

const baseRequestBoardApprovalPayloadSchema = z.object({
  title: z.string().trim().min(1, "Title is required"),
  summary: z.string().trim().min(1, "Summary is required"),
  recommendedAction: z.string().optional(),
  nextActionOnApproval: z.string().optional(),
  risks: z.union([z.string(), z.array(z.string())]).optional(),
  proposedComment: z.string().optional(),
  repoContext: conferenceContextSchema.optional(),
  decisionTier: z.literal("board").optional(),
});

const legacyIssueBoardRoomApprovalPayloadSchema = baseRequestBoardApprovalPayloadSchema.extend({
  roomTitle: z.string().optional(),
  agenda: z.string().optional(),
  participantAgentIds: z.array(z.string()).optional(),
  roomKind: z.literal("issue_board_room").optional(),
}).transform((payload): RequestBoardApprovalPayload => {
  const roomTitle = normalizeOptionalText(payload.roomTitle);
  const agenda = normalizeOptionalText(payload.agenda);
  const recommendedAction = normalizeOptionalText(payload.recommendedAction);
  const nextActionOnApproval = normalizeOptionalText(payload.nextActionOnApproval);
  const proposedComment = normalizeOptionalText(payload.proposedComment);
  const risks = normalizeRisks(payload.risks);
  const participantAgentIds = normalizeIdList(payload.participantAgentIds);
  const repoContext = payload.repoContext;

  return {
    title: payload.title.trim(),
    summary: payload.summary.trim(),
    ...(roomTitle ? { roomTitle } : {}),
    ...(agenda ? { agenda } : {}),
    ...(recommendedAction ? { recommendedAction } : {}),
    ...(nextActionOnApproval ? { nextActionOnApproval } : {}),
    ...(risks ? { risks } : {}),
    ...(proposedComment ? { proposedComment } : {}),
    ...(participantAgentIds ? { participantAgentIds } : {}),
    ...(repoContext ? { repoContext } : {}),
    decisionTier: "board",
    roomKind: "issue_board_room",
  };
});

const companyConferenceRoomApprovalPayloadSchema = baseRequestBoardApprovalPayloadSchema.extend({
  conferenceRoomId: z.string().uuid(),
  roomKind: z.literal("company_conference_room").optional(),
}).transform((payload): RequestBoardApprovalPayload => {
  const recommendedAction = normalizeOptionalText(payload.recommendedAction);
  const nextActionOnApproval = normalizeOptionalText(payload.nextActionOnApproval);
  const proposedComment = normalizeOptionalText(payload.proposedComment);
  const risks = normalizeRisks(payload.risks);
  const repoContext = payload.repoContext;

  return {
    title: payload.title.trim(),
    summary: payload.summary.trim(),
    conferenceRoomId: payload.conferenceRoomId,
    ...(recommendedAction ? { recommendedAction } : {}),
    ...(nextActionOnApproval ? { nextActionOnApproval } : {}),
    ...(risks ? { risks } : {}),
    ...(proposedComment ? { proposedComment } : {}),
    ...(repoContext ? { repoContext } : {}),
    decisionTier: "board",
    roomKind: "company_conference_room",
  };
});

const issuePlanApprovalPayloadSchema = baseRequestBoardApprovalPayloadSchema.extend({
  kind: z.literal("issue_plan_approval"),
  issueId: z.string().uuid(),
  identifier: z.string().trim().min(1).optional().nullable(),
  issueTitle: z.string().trim().min(1),
  planRevisionId: z.string().uuid(),
  specRevisionId: z.string().uuid().optional().nullable(),
  testPlanRevisionId: z.string().uuid().optional().nullable(),
}).transform((payload): RequestBoardApprovalPayload => {
  const recommendedAction = normalizeOptionalText(payload.recommendedAction);
  const nextActionOnApproval = normalizeOptionalText(payload.nextActionOnApproval);
  const proposedComment = normalizeOptionalText(payload.proposedComment);
  const risks = normalizeRisks(payload.risks);
  const repoContext = payload.repoContext;
  const identifier = normalizeOptionalText(payload.identifier);
  const specRevisionId = normalizeOptionalText(payload.specRevisionId);
  const testPlanRevisionId = normalizeOptionalText(payload.testPlanRevisionId);

  return {
    kind: "issue_plan_approval",
    title: payload.title.trim(),
    summary: payload.summary.trim(),
    issueId: payload.issueId,
    issueTitle: payload.issueTitle.trim(),
    planRevisionId: payload.planRevisionId,
    ...(identifier ? { identifier } : {}),
    ...(specRevisionId ? { specRevisionId } : {}),
    ...(testPlanRevisionId ? { testPlanRevisionId } : {}),
    ...(recommendedAction ? { recommendedAction } : {}),
    ...(nextActionOnApproval ? { nextActionOnApproval } : {}),
    ...(risks ? { risks } : {}),
    ...(proposedComment ? { proposedComment } : {}),
    ...(repoContext ? { repoContext } : {}),
    decisionTier: "board",
  };
});

export const requestBoardApprovalPayloadSchema = z.union([
  companyConferenceRoomApprovalPayloadSchema,
  legacyIssueBoardRoomApprovalPayloadSchema,
  issuePlanApprovalPayloadSchema,
]);

export function normalizeRequestBoardApprovalPayload(
  payload: unknown,
): RequestBoardApprovalPayload {
  return requestBoardApprovalPayloadSchema.parse(payload);
}

export const createApprovalSchema = z.object({
  type: z.enum(APPROVAL_TYPES),
  requestedByAgentId: z.string().uuid().optional().nullable(),
  payload: z.record(z.unknown()),
  issueIds: z.array(z.string().uuid()).optional(),
});

export type CreateApproval = z.infer<typeof createApprovalSchema>;

export const resolveApprovalSchema = z.object({
  decisionNote: multilineTextSchema.optional().nullable(),
  decidedByUserId: z.string().optional().default("board"),
});

export type ResolveApproval = z.infer<typeof resolveApprovalSchema>;

export const requestApprovalRevisionSchema = z.object({
  decisionNote: multilineTextSchema.optional().nullable(),
  decidedByUserId: z.string().optional().default("board"),
});

export type RequestApprovalRevision = z.infer<typeof requestApprovalRevisionSchema>;

export const resubmitApprovalSchema = z.object({
  payload: z.record(z.unknown()).optional(),
});

export type ResubmitApproval = z.infer<typeof resubmitApprovalSchema>;

export const addApprovalCommentSchema = z.object({
  body: multilineTextSchema.pipe(z.string().min(1)),
});

export type AddApprovalComment = z.infer<typeof addApprovalCommentSchema>;
export type RequestBoardApprovalPayloadInput = z.input<typeof requestBoardApprovalPayloadSchema>;
