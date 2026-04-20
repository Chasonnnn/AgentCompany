import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  addApprovalCommentSchema,
  createApprovalSchema,
  requestApprovalRevisionSchema,
  resolveApprovalSchema,
  resubmitApprovalSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logger } from "../middleware/logger.js";
import {
  approvalService,
  conferenceApprovalService,
  heartbeatService,
  issueApprovalService,
  logActivity,
  secretService,
} from "../services/index.js";
import * as serviceRegistry from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { serializeApprovalForActor } from "../services/conference-context.js";

export function approvalRoutes(db: Db) {
  const router = Router();
  const svc = approvalService(db);
  const conferenceApprovals = conferenceApprovalService(db);
  const heartbeat = heartbeatService(db);
  const issueApprovalsSvc = issueApprovalService(db);
  const continuitySvc = serviceRegistry.issueContinuityService
    ? serviceRegistry.issueContinuityService(db)
    : { recomputeIssueContinuityState: async () => null };
  const secretsSvc = secretService(db);
  const strictSecretsMode = process.env.PAPERCLIP_SECRETS_STRICT_MODE === "true";

  async function requireApprovalAccess(req: Request, id: string) {
    const approval = await svc.getById(id);
    if (!approval) {
      return null;
    }
    assertCompanyAccess(req, approval.companyId);
    return approval;
  }

  function getConferenceActor(req: Parameters<typeof assertCompanyAccess>[0]) {
    return req.actor.type === "agent" ? "agent" : "board";
  }

  async function recomputeLinkedIssueContinuity(approvalId: string) {
    const linkedIssues = await issueApprovalsSvc.listIssuesForApproval(approvalId);
    await Promise.all(linkedIssues.map((issue) => continuitySvc.recomputeIssueContinuityState(issue.id)));
    return linkedIssues;
  }

  async function queueRequesterWakeup(input: {
    approval: Awaited<ReturnType<typeof svc.getById>>;
    linkedIssues: Awaited<ReturnType<typeof issueApprovalsSvc.listIssuesForApproval>>;
    reason: "approval_approved" | "approval_revision_requested" | "approval_resubmitted";
    requestedByActorType: "user" | "agent";
    requestedByActorId: string;
    decisionNote?: string | null;
  }) {
    const approval = input.approval;
    if (!approval?.requestedByAgentId) return;

    const linkedIssueIds = input.linkedIssues.map((issue) => issue.id);
    const primaryIssueId = linkedIssueIds[0] ?? null;

    try {
      const wakeRun = await heartbeat.wakeup(approval.requestedByAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason: input.reason,
        payload: {
          approvalId: approval.id,
          approvalStatus: approval.status,
          issueId: primaryIssueId,
          issueIds: linkedIssueIds,
          ...(input.decisionNote ? { decisionNote: input.decisionNote } : {}),
        },
        requestedByActorType: input.requestedByActorType,
        requestedByActorId: input.requestedByActorId,
        contextSnapshot: {
          source:
            input.reason === "approval_revision_requested"
              ? "approval.revision_requested"
              : input.reason === "approval_resubmitted"
                ? "approval.resubmitted"
                : "approval.approved",
          approvalId: approval.id,
          approvalStatus: approval.status,
          ...(input.decisionNote ? { approvalDecisionNote: input.decisionNote } : {}),
          issueId: primaryIssueId,
          issueIds: linkedIssueIds,
          taskId: primaryIssueId,
          wakeReason: input.reason,
        },
      });

      await logActivity(db, {
        companyId: approval.companyId,
        actorType: input.requestedByActorType,
        actorId: input.requestedByActorId,
        action: "approval.requester_wakeup_queued",
        entityType: "approval",
        entityId: approval.id,
        details: {
          requesterAgentId: approval.requestedByAgentId,
          wakeReason: input.reason,
          wakeRunId: wakeRun?.id ?? null,
          linkedIssueIds,
        },
      });
    } catch (err) {
      logger.warn(
        {
          err,
          approvalId: approval.id,
          requestedByAgentId: approval.requestedByAgentId,
          wakeReason: input.reason,
        },
        "failed to queue requester wakeup after approval state change",
      );
      await logActivity(db, {
        companyId: approval.companyId,
        actorType: input.requestedByActorType,
        actorId: input.requestedByActorId,
        action: "approval.requester_wakeup_failed",
        entityType: "approval",
        entityId: approval.id,
        details: {
          requesterAgentId: approval.requestedByAgentId,
          wakeReason: input.reason,
          linkedIssueIds,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  router.get("/companies/:companyId/approvals", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const status = req.query.status as string | undefined;
    const result = await svc.list(companyId, status);
    const actor = getConferenceActor(req);
    res.json(result.map((approval) => serializeApprovalForActor(approval, actor)));
  });

  router.get("/approvals/:id", async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, approval.companyId);
    res.json(serializeApprovalForActor(approval, getConferenceActor(req)));
  });

  router.post("/companies/:companyId/approvals", validate(createApprovalSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const rawIssueIds = req.body.issueIds;
    const issueIds = Array.isArray(rawIssueIds)
      ? rawIssueIds.filter((value: unknown): value is string => typeof value === "string")
      : [];
    const uniqueIssueIds = Array.from(new Set(issueIds));
    const { issueIds: _issueIds, ...approvalInput } = req.body;
    const actor = getActorInfo(req);
    const requestedByAgentId =
      approvalInput.requestedByAgentId ?? (actor.actorType === "agent" ? actor.actorId : null);

    if (approvalInput.type === "request_board_approval") {
      if (uniqueIssueIds.length !== 1) {
        res.status(422).json({ error: "Conference approvals require exactly one linked issue" });
        return;
      }

      const approval = await conferenceApprovals.createRequestBoardApproval({
        companyId,
        issueId: uniqueIssueIds[0]!,
        payload: approvalInput.payload,
        requestedByAgentId,
        requestedByUserId: actor.actorType === "user" ? actor.actorId : null,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId ?? null,
        runId: actor.runId ?? null,
      });

      res.status(201).json(serializeApprovalForActor(approval, getConferenceActor(req)));
      return;
    }

    const normalizedPayload =
      approvalInput.type === "hire_agent"
        ? await secretsSvc.normalizeHireApprovalPayloadForPersistence(
            companyId,
            approvalInput.payload,
            { strictMode: strictSecretsMode },
          )
        : approvalInput.payload;

    const approval = await svc.create(companyId, {
      ...approvalInput,
      payload: normalizedPayload,
      requestedByUserId: actor.actorType === "user" ? actor.actorId : null,
      requestedByAgentId,
      status: "pending",
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      updatedAt: new Date(),
    });

    if (uniqueIssueIds.length > 0) {
      await issueApprovalsSvc.linkManyForApproval(approval.id, uniqueIssueIds, {
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
      });
    }

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "approval.created",
      entityType: "approval",
      entityId: approval.id,
      details: { type: approval.type, issueIds: uniqueIssueIds },
    });

    res.status(201).json(serializeApprovalForActor(approval, getConferenceActor(req)));
  });

  router.get("/approvals/:id/issues", async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, approval.companyId);
    const issues = await issueApprovalsSvc.listIssuesForApproval(id);
    res.json(issues);
  });

  router.post("/approvals/:id/approve", validate(resolveApprovalSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    if (!(await requireApprovalAccess(req, id))) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    const decidedByUserId = req.actor.userId ?? "board";
    const { approval, applied } = await svc.approve(
      id,
      decidedByUserId,
      req.body.decisionNote,
    );

    if (applied) {
      const linkedIssues = await recomputeLinkedIssueContinuity(approval.id);
      const linkedIssueIds = linkedIssues.map((issue) => issue.id);

      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "approval.approved",
        entityType: "approval",
        entityId: approval.id,
        details: {
          type: approval.type,
          requestedByAgentId: approval.requestedByAgentId,
          linkedIssueIds,
        },
      });

      await queueRequesterWakeup({
        approval,
        linkedIssues,
        reason: "approval_approved",
        requestedByActorType: "user",
        requestedByActorId: req.actor.userId ?? "board",
        decisionNote: approval.decisionNote,
      });
    }

    res.json(serializeApprovalForActor(approval, getConferenceActor(req)));
  });

  router.post("/approvals/:id/reject", validate(resolveApprovalSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    if (!(await requireApprovalAccess(req, id))) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    const decidedByUserId = req.actor.userId ?? "board";
    const { approval, applied } = await svc.reject(
      id,
      decidedByUserId,
      req.body.decisionNote,
    );

    if (applied) {
      await recomputeLinkedIssueContinuity(approval.id);
      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "approval.rejected",
        entityType: "approval",
        entityId: approval.id,
        details: { type: approval.type },
      });
    }

    res.json(serializeApprovalForActor(approval, getConferenceActor(req)));
  });

  router.post(
    "/approvals/:id/request-revision",
    validate(requestApprovalRevisionSchema),
    async (req, res) => {
      assertBoard(req);
      const id = req.params.id as string;
      if (!(await requireApprovalAccess(req, id))) {
        res.status(404).json({ error: "Approval not found" });
        return;
      }
      const decidedByUserId = req.actor.userId ?? "board";
      const approval = await svc.requestRevision(
        id,
        decidedByUserId,
        req.body.decisionNote,
      );

      const linkedIssues = await recomputeLinkedIssueContinuity(approval.id);

      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "approval.revision_requested",
        entityType: "approval",
        entityId: approval.id,
        details: { type: approval.type },
      });

      await queueRequesterWakeup({
        approval,
        linkedIssues,
        reason: "approval_revision_requested",
        requestedByActorType: "user",
        requestedByActorId: req.actor.userId ?? "board",
        decisionNote: approval.decisionNote,
      });

      res.json(serializeApprovalForActor(approval, getConferenceActor(req)));
    },
  );

  router.post("/approvals/:id/resubmit", validate(resubmitApprovalSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    if (req.actor.type === "agent" && req.actor.agentId !== existing.requestedByAgentId) {
      res.status(403).json({ error: "Only requesting agent can resubmit this approval" });
      return;
    }

    const normalizedPayload = req.body.payload
      ? existing.type === "hire_agent"
        ? await secretsSvc.normalizeHireApprovalPayloadForPersistence(
            existing.companyId,
            req.body.payload,
            { strictMode: strictSecretsMode },
          )
        : req.body.payload
      : undefined;
    const approval = await svc.resubmit(id, normalizedPayload);
    const linkedIssues = await recomputeLinkedIssueContinuity(approval.id);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: approval.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "approval.resubmitted",
      entityType: "approval",
      entityId: approval.id,
      details: { type: approval.type },
    });
    await queueRequesterWakeup({
      approval,
      linkedIssues,
      reason: "approval_resubmitted",
      requestedByActorType: actor.actorType === "agent" ? "agent" : "user",
      requestedByActorId: actor.actorId,
    });
    res.json(serializeApprovalForActor(approval, getConferenceActor(req)));
  });

  router.get("/approvals/:id/comments", async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, approval.companyId);
    const comments = await svc.listComments(id);
    res.json(comments);
  });

  router.post("/approvals/:id/comments", validate(addApprovalCommentSchema), async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, approval.companyId);
    const actor = getActorInfo(req);
    const comment = await svc.addComment(id, req.body.body, {
      agentId: actor.agentId ?? undefined,
      userId: actor.actorType === "user" ? actor.actorId : undefined,
    });

    await logActivity(db, {
      companyId: approval.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "approval.comment_added",
      entityType: "approval",
      entityId: approval.id,
      details: { commentId: comment.id },
    });

    res.status(201).json(comment);
  });

  return router;
}
