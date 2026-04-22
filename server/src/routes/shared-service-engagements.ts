import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import {
  ADVISOR_KINDS,
  createSharedServiceEngagementSchema,
  updateSharedServiceEngagementSchema,
} from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import {
  heartbeatService,
  logActivity as baseLogActivity,
  officeCoordinationService,
  sharedServiceEngagementService,
} from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { wakeCompanyOfficeOperatorSafely } from "../services/office-coordination-wakeup.js";

const closeSharedServiceEngagementSchema = z.object({
  outcomeSummary: z.string().optional().nullable(),
}).strict();

const createSharedServiceEngagementRouteSchema = createSharedServiceEngagementSchema.extend({
  advisorKind: z.enum(ADVISOR_KINDS).optional().nullable(),
  advisorEnabled: z.boolean().optional().default(false),
});

const updateSharedServiceEngagementRouteSchema = updateSharedServiceEngagementSchema.extend({
  advisorKind: z.enum(ADVISOR_KINDS).optional().nullable(),
  advisorEnabled: z.boolean().optional(),
});

const recommendSharedServiceSurfaceSchema = z.object({
  title: z.string().trim().max(200).optional().nullable(),
  summary: z.string().trim().max(4_000).optional().nullable(),
  advisorKind: z.enum(ADVISOR_KINDS).optional().nullable(),
  requiresGovernance: z.boolean().optional().default(false),
  requestsBoardAnswer: z.boolean().optional().default(false),
  blocksExecution: z.boolean().optional().default(false),
  needsCrossFunctionalCoordination: z.boolean().optional().default(false),
  participantAgentIds: z.array(z.string().trim().min(1)).optional().default([]),
}).strict();

type SharedServiceEngagementRouteDeps = {
  engagements: ReturnType<typeof sharedServiceEngagementService>;
  heartbeatService: ReturnType<typeof heartbeatService>;
  logActivity: typeof baseLogActivity;
  officeCoordinationService: ReturnType<typeof officeCoordinationService>;
};

export function sharedServiceEngagementRoutes(
  db: Db,
  deps?: Partial<SharedServiceEngagementRouteDeps>,
) {
  const router = Router();
  const engagements = deps?.engagements ?? sharedServiceEngagementService(db);
  const heartbeat = deps?.heartbeatService ?? heartbeatService(db);
  const logActivity = deps?.logActivity ?? baseLogActivity;
  const officeCoordination = deps?.officeCoordinationService ?? officeCoordinationService(db);

  router.get("/companies/:companyId/shared-service-engagements", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await engagements.listForCompany(companyId));
  });

  router.get("/companies/:companyId/shared-service-engagements/advisor-templates", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await engagements.listAdvisorTemplates());
  });

  router.post(
    "/companies/:companyId/shared-service-engagements/recommend-surface",
    validate(recommendSharedServiceSurfaceSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      res.json(await engagements.recommendSurface(req.body));
    },
  );

  router.post(
    "/companies/:companyId/shared-service-engagements",
    validate(createSharedServiceEngagementRouteSchema),
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

      void wakeCompanyOfficeOperatorSafely({
        officeCoordination,
        heartbeat,
        companyId,
        reason: "shared_service_engagement_requested",
        entityType: "shared_service_engagement",
        entityId: created.id,
        summary: created.title,
        requestedByActorType: actor.actorType,
        requestedByActorId: actor.actorId,
        skipIfActorAgentId: actor.agentId ?? null,
        logContext: { engagementId: created.id },
      });
      res.status(201).json(created);
    },
  );

  router.patch(
    "/shared-service-engagements/:id",
    validate(updateSharedServiceEngagementRouteSchema),
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

      void wakeCompanyOfficeOperatorSafely({
        officeCoordination,
        heartbeat,
        companyId: updated.companyId,
        reason: "shared_service_engagement_closed",
        entityType: "shared_service_engagement",
        entityId: updated.id,
        summary: updated.title,
        requestedByActorType: actor.actorType,
        requestedByActorId: actor.actorId,
        skipIfActorAgentId: actor.agentId ?? null,
        logContext: { engagementId: updated.id },
      });
      res.status(201).json(updated);
    },
  );

  return router;
}
