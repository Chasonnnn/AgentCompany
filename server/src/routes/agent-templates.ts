import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { agentTemplateImportPackRequestSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { agentTemplateService, logActivity } from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

export function agentTemplateRoutes(db: Db) {
  const router = Router();
  const svc = agentTemplateService(db);

  router.get("/companies/:companyId/agent-templates", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    res.json(await svc.list(companyId));
  });

  router.post(
    "/companies/:companyId/agent-templates/import-pack",
    validate(agentTemplateImportPackRequestSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertBoard(req);
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);
      const result = await svc.importPack(companyId, req.body, {
        createdByAgentId: actor.agentId,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      });

      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "agent_template.pack_imported",
        entityType: "company",
        entityId: companyId,
        details: {
          itemCount: result.items.length,
          warningCount: result.warnings.length,
          paths: result.items.map((item) => item.path),
        },
      });

      res.status(201).json(result);
    },
  );

  router.get("/agent-templates/:id/revisions", async (req, res) => {
    const template = await svc.getTemplate(req.params.id as string);
    if (!template) {
      res.status(404).json({ error: "Agent template not found" });
      return;
    }
    assertBoard(req);
    assertCompanyAccess(req, template.companyId);
    res.json(await svc.listRevisions(template.id));
  });

  return router;
}
