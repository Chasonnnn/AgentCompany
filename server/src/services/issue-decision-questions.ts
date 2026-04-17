import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueDecisionQuestions, issues } from "@paperclipai/db";
import {
  answerIssueDecisionQuestionSchema,
  createIssueDecisionQuestionSchema,
  dismissIssueDecisionQuestionSchema,
  escalateIssueDecisionQuestionSchema,
  issueDecisionQuestionSchema,
  normalizeRequestBoardApprovalPayload,
  type AnswerIssueDecisionQuestion,
  type CreateIssueDecisionQuestion,
  type DismissIssueDecisionQuestion,
  type EscalateIssueDecisionQuestion,
  type IssueDecisionQuestion,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { approvalService } from "./approvals.js";
import { issueApprovalService } from "./issue-approvals.js";
import { issueContinuityService } from "./issue-continuity.js";
import { issueService } from "./issues.js";

type QuestionActor = {
  agentId?: string | null;
  userId?: string | null;
  runId?: string | null;
};

function toDecisionQuestion(row: typeof issueDecisionQuestions.$inferSelect): IssueDecisionQuestion {
  return issueDecisionQuestionSchema.parse({
    ...row,
    recommendedOptions: Array.isArray(row.recommendedOptions) ? row.recommendedOptions : [],
    answer: row.answer ?? null,
  });
}

export function issueDecisionQuestionService(db: Db) {
  const issuesSvc = issueService(db);
  const approvalsSvc = approvalService(db);
  const issueApprovalsSvc = issueApprovalService(db);
  const continuitySvc = issueContinuityService(db);

  async function getIssueOrThrow(issueId: string) {
    const issue = await issuesSvc.getById(issueId);
    if (!issue) throw notFound("Issue not found");
    return issue;
  }

  async function getQuestionOrThrow(questionId: string) {
    const row = await db
      .select()
      .from(issueDecisionQuestions)
      .where(eq(issueDecisionQuestions.id, questionId))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Decision question not found");
    return row;
  }

  async function touchIssue(issueId: string) {
    await db.update(issues).set({ updatedAt: new Date() }).where(eq(issues.id, issueId));
  }

  async function recompute(questionIssueId: string) {
    const continuityState = await continuitySvc.recomputeIssueContinuityState(questionIssueId);
    const continuityBundle = await continuitySvc.buildIssueContinuityBundle(questionIssueId);
    return { continuityState, continuityBundle };
  }

  return {
    listForIssue: async (issueId: string) => {
      const issue = await getIssueOrThrow(issueId);
      const rows = await db
        .select()
        .from(issueDecisionQuestions)
        .where(and(eq(issueDecisionQuestions.companyId, issue.companyId), eq(issueDecisionQuestions.issueId, issue.id)))
        .orderBy(desc(issueDecisionQuestions.createdAt));
      return rows.map(toDecisionQuestion);
    },

    listOpenForCompany: async (companyId: string, limit = 25) => {
      const rows = await db
        .select()
        .from(issueDecisionQuestions)
        .where(and(eq(issueDecisionQuestions.companyId, companyId), eq(issueDecisionQuestions.status, "open")))
        .orderBy(desc(issueDecisionQuestions.createdAt))
        .limit(limit);
      return rows.map(toDecisionQuestion);
    },

    create: async (
      issueId: string,
      input: CreateIssueDecisionQuestion,
      actor: QuestionActor = {},
    ) => {
      const parsed = createIssueDecisionQuestionSchema.parse(input);
      const issue = await getIssueOrThrow(issueId);
      const inserted = await db
        .insert(issueDecisionQuestions)
        .values({
          companyId: issue.companyId,
          issueId: issue.id,
          target: "board",
          requestedByAgentId: actor.agentId ?? null,
          requestedByUserId: actor.userId ?? null,
          status: "open",
          blocking: parsed.blocking,
          title: parsed.title,
          question: parsed.question,
          whyBlocked: parsed.whyBlocked ?? null,
          recommendedOptions: parsed.recommendedOptions,
          suggestedDefault: parsed.suggestedDefault ?? null,
          linkedApprovalId: parsed.linkedApprovalId ?? null,
          updatedAt: new Date(),
        })
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!inserted) throw conflict("Failed to create decision question");
      await touchIssue(issue.id);
      const { continuityState, continuityBundle } = await recompute(issue.id);
      return {
        question: toDecisionQuestion(inserted),
        continuityState,
        continuityBundle,
      };
    },

    answer: async (
      questionId: string,
      input: AnswerIssueDecisionQuestion,
      actor: Required<Pick<QuestionActor, "userId">>,
    ) => {
      const parsed = answerIssueDecisionQuestionSchema.parse(input);
      const existing = await getQuestionOrThrow(questionId);
      if (existing.status !== "open") {
        throw unprocessable("Only open decision questions can be answered");
      }
      const updated = await db
        .update(issueDecisionQuestions)
        .set({
          status: "answered",
          answer: {
            selectedOptionKey: parsed.selectedOptionKey ?? null,
            answer: parsed.answer,
            note: parsed.note ?? null,
          },
          answeredByUserId: actor.userId,
          answeredAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(issueDecisionQuestions.id, questionId))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!updated) throw notFound("Decision question not found");
      await touchIssue(updated.issueId);
      const { continuityState, continuityBundle } = await recompute(updated.issueId);
      return {
        question: toDecisionQuestion(updated),
        continuityState,
        continuityBundle,
        shouldEscalateToApproval: parsed.escalateToApproval === true,
      };
    },

    dismiss: async (
      questionId: string,
      input: DismissIssueDecisionQuestion,
      actor: Required<Pick<QuestionActor, "userId">>,
    ) => {
      const parsed = dismissIssueDecisionQuestionSchema.parse(input);
      const existing = await getQuestionOrThrow(questionId);
      if (existing.status !== "open") {
        throw unprocessable("Only open decision questions can be dismissed");
      }
      const updated = await db
        .update(issueDecisionQuestions)
        .set({
          status: "dismissed",
          answer: parsed.note ? { answer: parsed.note, note: parsed.note } : existing.answer,
          answeredByUserId: actor.userId,
          answeredAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(issueDecisionQuestions.id, questionId))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!updated) throw notFound("Decision question not found");
      await touchIssue(updated.issueId);
      const { continuityState, continuityBundle } = await recompute(updated.issueId);
      return {
        question: toDecisionQuestion(updated),
        continuityState,
        continuityBundle,
      };
    },

    escalateToApproval: async (
      questionId: string,
      input: EscalateIssueDecisionQuestion,
      actor: QuestionActor = {},
    ) => {
      const parsed = escalateIssueDecisionQuestionSchema.parse(input);
      const existing = await getQuestionOrThrow(questionId);
      if (existing.linkedApprovalId) {
        throw conflict("Decision question is already linked to an approval");
      }
      if (!["open", "answered"].includes(existing.status)) {
        throw unprocessable("Only open or answered decision questions can be escalated to approval");
      }
      const approvalPayload = normalizeRequestBoardApprovalPayload({
        title: existing.title,
        summary: parsed.summary ?? existing.question,
        recommendedAction: parsed.recommendedAction ?? existing.suggestedDefault ?? undefined,
        nextActionOnApproval: parsed.nextActionOnApproval ?? undefined,
        risks: parsed.risks,
        proposedComment: parsed.proposedComment ?? undefined,
        decisionTier: "board",
        roomKind: "issue_board_room",
      });
      const approval = await approvalsSvc.create(existing.companyId, {
        type: "request_board_approval",
        requestedByAgentId: existing.requestedByAgentId ?? actor.agentId ?? null,
        requestedByUserId: existing.requestedByUserId ?? actor.userId ?? null,
        payload: approvalPayload as unknown as Record<string, unknown>,
      });
      await issueApprovalsSvc.linkManyForApproval(approval.id, [existing.issueId], {
        agentId: actor.agentId ?? null,
        userId: actor.userId ?? null,
      });
      const updated = await db
        .update(issueDecisionQuestions)
        .set({
          status: "escalated_to_approval",
          linkedApprovalId: approval.id,
          updatedAt: new Date(),
        })
        .where(eq(issueDecisionQuestions.id, questionId))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!updated) throw notFound("Decision question not found");
      await touchIssue(updated.issueId);
      const { continuityState, continuityBundle } = await recompute(updated.issueId);
      return {
        question: toDecisionQuestion(updated),
        approvalId: approval.id,
        continuityState,
        continuityBundle,
      };
    },
  };
}
