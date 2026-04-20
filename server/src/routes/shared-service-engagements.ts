import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import {
  createSharedServiceEngagementSchema,
  updateSharedServiceEngagementSchema,
} from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import {
  logActivity as baseLogActivity,
  sharedServiceEngagementService,
} from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

const closeSharedServiceEngagementSchema = z.object({
  outcomeSummary: z.string().optional().nullable(),
}).strict();

type SharedServiceEngagementRouteDeps = {
  engagements: ReturnType<typeof sharedServiceEngagementService>;
  logActivity: typeof baseLogActivity;
};

export function sharedServiceEngagementRoutes(
  db: Db,
  deps?: Partial<SharedServiceEngagementRouteDeps>,
) {
  const router = Router();
  const engagements = deps?.engagements ?? sharedServiceEngagementService(db);
  const logActivity = deps?.logActivity ?? baseLogActivity;

  router.get("/companies/:companyId/shared-service-engagements", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await engagements.listForCompany(companyId));
  });

  router.post(
    "/companies/:companyId/shared-service-engagements",
    validate(createSharedServiceEngagementSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);
      const created = await engagements.create(companyId, req.body, {
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId ?? null,
      });
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "shared_service_engagement.created",
        entityType: "shared_service_engagement",
        entityId: created.id,
        details: {
          targetProjectId: created.targetProjectId,
          serviceAreaKey: created.serviceAreaKey,
          assignedAgentIds: created.assignments.map((assignment) => assignment.agentId),
        },
      });
      res.status(201).json(created);
    },
  );

  router.patch(
    "/shared-service-engagements/:id",
    validate(updateSharedServiceEngagementSchema),
    async (req, res) => {
      const existing = await engagements.getById(req.params.id as string);
      if (!existing) throw notFound("Shared-service engagement not found");
      assertCompanyAccess(req, existing.companyId);
      const updated = await engagements.update(existing.id, req.body);
      if (!updated) throw notFound("Shared-service engagement not found");
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: updated.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "shared_service_engagement.updated",
        entityType: "shared_service_engagement",
        entityId: updated.id,
        details: {
          changedKeys: Object.keys(req.body).sort(),
        },
      });
      res.json(updated);
    },
  );

  router.post("/shared-service-engagements/:id/approve", async (req, res) => {
    assertBoard(req);
    const existing = await engagements.getById(req.params.id as string);
    if (!existing) throw notFound("Shared-service engagement not found");
    assertCompanyAccess(req, existing.companyId);
    const actor = getActorInfo(req);
    const updated = await engagements.approve(existing.id, {
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId ?? null,
    });
    if (!updated) throw notFound("Shared-service engagement not found");
    await logActivity(db, {
      companyId: updated.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "shared_service_engagement.approved",
      entityType: "shared_service_engagement",
      entityId: updated.id,
      details: {
        targetProjectId: updated.targetProjectId,
        assignedAgentIds: updated.assignments.map((assignment) => assignment.agentId),
      },
    });
    res.status(201).json(updated);
  });

  router.post(
    "/shared-service-engagements/:id/close",
    validate(closeSharedServiceEngagementSchema),
    async (req, res) => {
      assertBoard(req);
      const existing = await engagements.getById(req.params.id as string);
      if (!existing) throw notFound("Shared-service engagement not found");
      assertCompanyAccess(req, existing.companyId);
      const actor = getActorInfo(req);
      const updated = await engagements.close(existing.id, {
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId ?? null,
      }, req.body.outcomeSummary ?? null);
      if (!updated) throw notFound("Shared-service engagement not found");
      await logActivity(db, {
        companyId: updated.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "shared_service_engagement.closed",
        entityType: "shared_service_engagement",
        entityId: updated.id,
        details: {
          outcomeSummary: updated.outcomeSummary,
        },
      });
      res.status(201).json(updated);
    },
  );

  return router;
}
