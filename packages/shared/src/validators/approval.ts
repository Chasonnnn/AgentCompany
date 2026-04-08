import { z } from "zod";
import { APPROVAL_TYPES } from "../constants.js";
import type { RequestBoardApprovalPayload } from "../types/approval.js";

function normalizeOptionalText(value: string | undefined): string | undefined {
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

export const requestBoardApprovalPayloadSchema = z.object({
  title: z.string().trim().min(1, "Title is required"),
  summary: z.string().trim().min(1, "Summary is required"),
  recommendedAction: z.string().optional(),
  nextActionOnApproval: z.string().optional(),
  risks: z.union([z.string(), z.array(z.string())]).optional(),
  proposedComment: z.string().optional(),
  decisionTier: z.literal("board").optional(),
  roomKind: z.literal("issue_board_room").optional(),
}).transform((payload): RequestBoardApprovalPayload => {
  const recommendedAction = normalizeOptionalText(payload.recommendedAction);
  const nextActionOnApproval = normalizeOptionalText(payload.nextActionOnApproval);
  const proposedComment = normalizeOptionalText(payload.proposedComment);
  const risks = normalizeRisks(payload.risks);

  return {
    title: payload.title.trim(),
    summary: payload.summary.trim(),
    ...(recommendedAction ? { recommendedAction } : {}),
    ...(nextActionOnApproval ? { nextActionOnApproval } : {}),
    ...(risks ? { risks } : {}),
    ...(proposedComment ? { proposedComment } : {}),
    decisionTier: "board",
    roomKind: "issue_board_room",
  };
});

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
  decisionNote: z.string().optional().nullable(),
  decidedByUserId: z.string().optional().default("board"),
});

export type ResolveApproval = z.infer<typeof resolveApprovalSchema>;

export const requestApprovalRevisionSchema = z.object({
  decisionNote: z.string().optional().nullable(),
  decidedByUserId: z.string().optional().default("board"),
});

export type RequestApprovalRevision = z.infer<typeof requestApprovalRevisionSchema>;

export const resubmitApprovalSchema = z.object({
  payload: z.record(z.unknown()).optional(),
});

export type ResubmitApproval = z.infer<typeof resubmitApprovalSchema>;

export const addApprovalCommentSchema = z.object({
  body: z.string().min(1),
});

export type AddApprovalComment = z.infer<typeof addApprovalCommentSchema>;
export type RequestBoardApprovalPayloadInput = z.input<typeof requestBoardApprovalPayloadSchema>;
