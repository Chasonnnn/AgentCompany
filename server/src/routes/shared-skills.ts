import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  sharedSkillMirrorSyncRequestSchema,
  sharedSkillProposalCommentCreateSchema,
  sharedSkillProposalCreateSchema,
  sharedSkillProposalDecisionSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import {
  heartbeatService,
  logActivity as baseLogActivity,
  officeCoordinationService,
  sharedSkillService,
} from "../services/index.js";
import { assertCompanyAccess, assertInstanceAdmin, getActorInfo } from "./authz.js";
import { forbidden, unprocessable } from "../errors.js";
import { wakeCompanyOfficeOperatorSafely } from "../services/office-coordination-wakeup.js";

type SharedSkillRouteDeps = {
  heartbeatService: ReturnType<typeof heartbeatService>;
  sharedSkillService: ReturnType<typeof sharedSkillService>;
  logActivity: typeof baseLogActivity;
  officeCoordinationService: ReturnType<typeof officeCoordinationService>;
};

export function sharedSkillRoutes(db: Db, deps?: Partial<SharedSkillRouteDeps>) {
  const router = Router();
  const heartbeat = deps?.heartbeatService ?? heartbeatService(db);
  const svc = deps?.sharedSkillService ?? sharedSkillService(db);
  const logActivity = deps?.logActivity ?? baseLogActivity;
  const officeCoordination = deps?.officeCoordinationService ?? officeCoordinationService(db);

  async function logInstanceMutation(sharedSkillId: string, action: string, details: Record<string, unknown>) {
    const companyIds = await svc.listLinkedCompanyIds(sharedSkillId);
    await Promise.all(companyIds.map((companyId) =>
      logActivity(db, {
        companyId,
        actorType: "system",
        actorId: "shared-skills",
        agentId: null,
        runId: null,
        action,
        entityType: "shared_skill",
        entityId: sharedSkillId,
        details,
      })));
  }

  router.get("/instance/shared-skills", async (req, res) => {
    assertInstanceAdmin(req);
    res.json(await svc.list());
  });

  router.post(
    "/instance/shared-skills/mirror-sync",
    validate(sharedSkillMirrorSyncRequestSchema),
    async (req, res) => {
      assertInstanceAdmin(req);
      const result = await svc.syncMirrors(req.body);
      const affectedCompanyIds = new Map<string, number>();
      for (const item of result.items) {
        if (
          item.sourceDriftState !== "upstream_update_available" &&
          item.sourceDriftState !== "diverged_needs_review"
        ) {
          continue;
        }
        const companyIds = await svc.listLinkedCompanyIds(item.sharedSkillId);
        for (const companyId of companyIds) {
          affectedCompanyIds.set(companyId, (affectedCompanyIds.get(companyId) ?? 0) + 1);
        }
      }
      await Promise.all(
        [...affectedCompanyIds.entries()].map(async ([companyId, count]) =>
          wakeCompanyOfficeOperatorSafely({
            officeCoordination,
            heartbeat,
            companyId,
            reason: "shared_skill_source_drift_detected",
            entityType: "shared_skill",
            summary: `${count} shared skill drift item${count === 1 ? "" : "s"} need coordination`,
            requestedByActorType: "system",
            requestedByActorId: "shared_skill_mirror_sync",
            logContext: { driftCount: count },
          }),
        ),
      );
      res.json(result);
    },
  );

  router.get("/instance/shared-skills/proposals", async (req, res) => {
    assertInstanceAdmin(req);
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    res.json(await svc.listProposals(status as any));
  });

  router.get("/instance/shared-skills/proposals/:proposalId", async (req, res) => {
    assertInstanceAdmin(req);
    const result = await svc.proposalDetail(req.params.proposalId);
    if (!result) {
      res.status(404).json({ error: "Shared skill proposal not found" });
      return;
    }
    res.json(result);
  });

  router.post(
    "/instance/shared-skills/proposals/:proposalId/approve",
    validate(sharedSkillProposalDecisionSchema),
    async (req, res) => {
      assertInstanceAdmin(req);
      const actor = getActorInfo(req);
      const proposalId = String(req.params.proposalId);
      const proposal = await svc.approveProposal(proposalId, actor.actorId, req.body.decisionNote ?? null);
      await logInstanceMutation(proposal.sharedSkillId, "shared_skill.proposal_approved", {
        proposalId: proposal.id,
        kind: proposal.kind,
        status: proposal.status,
      });
      res.json(proposal);
    },
  );

  router.post(
    "/instance/shared-skills/proposals/:proposalId/reject",
    validate(sharedSkillProposalDecisionSchema),
    async (req, res) => {
      assertInstanceAdmin(req);
      const actor = getActorInfo(req);
      const proposalId = String(req.params.proposalId);
      const proposal = await svc.rejectProposal(proposalId, actor.actorId, "rejected", req.body.decisionNote ?? null);
      await logInstanceMutation(proposal.sharedSkillId, "shared_skill.proposal_rejected", {
        proposalId: proposal.id,
        kind: proposal.kind,
        status: proposal.status,
      });
      res.json(proposal);
    },
  );

  router.post(
    "/instance/shared-skills/proposals/:proposalId/request-revision",
    validate(sharedSkillProposalDecisionSchema),
    async (req, res) => {
      assertInstanceAdmin(req);
      const actor = getActorInfo(req);
      const proposalId = String(req.params.proposalId);
      const proposal = await svc.rejectProposal(
        proposalId,
        actor.actorId,
        "revision_requested",
        req.body.decisionNote ?? null,
      );
      await logInstanceMutation(proposal.sharedSkillId, "shared_skill.proposal_revision_requested", {
        proposalId: proposal.id,
        kind: proposal.kind,
        status: proposal.status,
      });
      res.json(proposal);
    },
  );

  router.post(
    "/instance/shared-skills/proposals/:proposalId/comments",
    validate(sharedSkillProposalCommentCreateSchema),
    async (req, res) => {
      assertInstanceAdmin(req);
      const actor = getActorInfo(req);
      const proposalId = String(req.params.proposalId);
      const comment = await svc.addComment(proposalId, {
        actorType: actor.actorType,
        actorId: actor.actorId,
        companyId: null,
        runId: actor.runId,
      }, req.body.body);
      res.status(201).json(comment);
    },
  );

  router.get("/instance/shared-skills/:sharedSkillId/drift", async (req, res) => {
    assertInstanceAdmin(req);
    const result = await svc.drift(req.params.sharedSkillId);
    if (!result) {
      res.status(404).json({ error: "Shared skill not found" });
      return;
    }
    res.json(result);
  });

  router.get("/instance/shared-skills/:sharedSkillId", async (req, res) => {
    assertInstanceAdmin(req);
    const result = await svc.detail(req.params.sharedSkillId);
    if (!result) {
      res.status(404).json({ error: "Shared skill not found" });
      return;
    }
    res.json(result);
  });

  router.post(
    "/companies/:companyId/shared-skills/:sharedSkillId/proposals",
    validate(sharedSkillProposalCreateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const sharedSkillId = req.params.sharedSkillId as string;
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);
      const runId = req.body.evidence.runId ?? actor.runId ?? null;
      const officeOperatorActor =
        actor.agentId ? await officeCoordination.isOfficeOperatorAgent(actor.agentId, companyId) : false;
      if (!runId && !officeOperatorActor) {
        throw unprocessable("Shared skill proposals require run evidence.");
      }
      const proposalAllowed = runId
        ? await svc.isSkillAvailableForRun(runId, sharedSkillId, companyId)
        : false;
      const companyVisible = officeOperatorActor
        ? await svc.isSkillVisibleToCompany(sharedSkillId, companyId)
        : false;
      if (!proposalAllowed) {
        if (!companyVisible) {
          throw forbidden("Shared skill proposal target was not available in this run's runtime skill set.");
        }
      }
      const proposal = await svc.createProposal(
        companyId,
        sharedSkillId,
        {
          ...req.body,
          evidence: {
            ...req.body.evidence,
            ...(runId ? { runId } : {}),
          },
        },
        {
          actorType: actor.actorType,
          actorId: actor.actorId,
          companyId,
          runId,
        },
      );

      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId,
        action: "shared_skill.proposal_created",
        entityType: "shared_skill",
        entityId: sharedSkillId,
        details: {
          proposalId: proposal.id,
          kind: proposal.kind,
          status: proposal.status,
          summary: proposal.summary,
        },
      });

      void wakeCompanyOfficeOperatorSafely({
        officeCoordination,
        heartbeat,
        companyId,
        reason: "shared_skill_proposal_created",
        entityType: "shared_skill",
        entityId: sharedSkillId,
        summary: proposal.summary,
        requestedByActorType: actor.actorType,
        requestedByActorId: actor.actorId,
        skipIfActorAgentId: actor.agentId ?? null,
        logContext: { proposalId: proposal.id, sharedSkillId },
      });

      res.status(201).json(proposal);
    },
  );

  return router;
}
