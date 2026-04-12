import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { createPortfolioClusterSchema, updatePortfolioClusterSchema } from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { logActivity as baseLogActivity, portfolioClusterService } from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

type PortfolioClusterRouteDeps = {
  portfolioClusterService: ReturnType<typeof portfolioClusterService>;
  logActivity: typeof baseLogActivity;
};

export function portfolioClusterRoutes(db: Db, deps?: Partial<PortfolioClusterRouteDeps>) {
  const router = Router();
  const clusters = deps?.portfolioClusterService ?? portfolioClusterService(db);
  const logActivity = deps?.logActivity ?? baseLogActivity;

  router.get("/companies/:companyId/portfolio-clusters", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await clusters.listForCompany(companyId));
  });

  router.post("/companies/:companyId/portfolio-clusters", validate(createPortfolioClusterSchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const created = await clusters.create(companyId, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "portfolio_cluster.created",
      entityType: "portfolio_cluster",
      entityId: created.id,
      details: {
        name: created.name,
        slug: created.slug,
        executiveSponsorAgentId: created.executiveSponsorAgentId,
        portfolioDirectorAgentId: created.portfolioDirectorAgentId,
      },
    });
    res.status(201).json(created);
  });

  router.patch("/portfolio-clusters/:id", validate(updatePortfolioClusterSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await clusters.getById(id);
    if (!existing) throw notFound("Portfolio cluster not found");
    assertCompanyAccess(req, existing.companyId);
    const updated = await clusters.update(id, req.body);
    if (!updated) throw notFound("Portfolio cluster not found");
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: updated.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "portfolio_cluster.updated",
      entityType: "portfolio_cluster",
      entityId: updated.id,
      details: {
        changedKeys: Object.keys(req.body).sort(),
      },
    });
    res.json(updated);
  });

  return router;
}
