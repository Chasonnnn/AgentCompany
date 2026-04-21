import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  bulkSkillGrantApplyRequestSchema,
  bulkSkillGrantRequestSchema,
  companySkillCreateSchema,
  companySkillCoverageRepairApplyRequestSchema,
  companySkillFileUpdateSchema,
  companySkillImportSchema,
  companySkillInstallGlobalSchema,
  companySkillProjectScanRequestSchema,
} from "@paperclipai/shared";
import { trackSkillImported } from "@paperclipai/shared/telemetry";
import { validate } from "../middleware/validate.js";
import { accessService, agentService, agentSkillService, companySkillService, logActivity } from "../services/index.js";
import { forbidden } from "../errors.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { getTelemetryClient } from "../telemetry.js";
import { agentHasCreatePermission } from "../services/agent-permissions.js";

type SkillTelemetryInput = {
  key: string;
  slug: string;
  sourceType: string;
  sourceLocator: string | null;
  metadata: Record<string, unknown> | null;
};

type CompanySkillRouteDeps = {
  accessService: ReturnType<typeof accessService>;
  agentService: ReturnType<typeof agentService>;
  agentSkillService: ReturnType<typeof agentSkillService>;
  companySkillService: ReturnType<typeof companySkillService>;
  logActivity: typeof logActivity;
};

export function companySkillRoutes(
  db: Db,
  opts?: {
    services?: Partial<CompanySkillRouteDeps>;
    telemetry?: {
      getTelemetryClient?: typeof getTelemetryClient;
      trackSkillImported?: typeof trackSkillImported;
      agentHasCreatePermission?: typeof agentHasCreatePermission;
    };
  },
) {
  const router = Router();
  const agents = opts?.services?.agentService ?? agentService(db);
  const access = opts?.services?.accessService ?? accessService(db);
  const svc = opts?.services?.companySkillService ?? companySkillService(db);
  const skillGrants = opts?.services?.agentSkillService ?? agentSkillService(db);
  const logActivityFn = opts?.services?.logActivity ?? logActivity;
  const getTelemetryClientFn = opts?.telemetry?.getTelemetryClient ?? getTelemetryClient;
  const trackSkillImportedFn = opts?.telemetry?.trackSkillImported ?? trackSkillImported;
  const agentHasCreatePermissionFn =
    opts?.telemetry?.agentHasCreatePermission ?? agentHasCreatePermission;

  function asString(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  function deriveTrackedSkillRef(skill: SkillTelemetryInput): string | null {
    if (skill.sourceType === "skills_sh") {
      return skill.key;
    }
    if (skill.sourceType !== "github") {
      return null;
    }
    const hostname = asString(skill.metadata?.hostname);
    if (hostname !== "github.com") {
      return null;
    }
    return skill.key;
  }

  async function assertCanMutateCompanySkills(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);

    if (req.actor.type === "board") {
      if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
      const allowed = await access.canUser(companyId, req.actor.userId, "agents:create");
      if (!allowed) {
        throw forbidden("Missing permission: agents:create");
      }
      return;
    }

    if (!req.actor.agentId) {
      throw forbidden("Agent authentication required");
    }

    const actorAgent = await agents.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== companyId) {
      throw forbidden("Agent key cannot access another company");
    }

    const allowedByGrant = await access.hasPermission(companyId, "agent", actorAgent.id, "agents:create");
    if (allowedByGrant || agentHasCreatePermissionFn(actorAgent)) {
      return;
    }

    throw forbidden("Missing permission: can create agents");
  }

  router.get("/companies/:companyId/skills", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.list(companyId);
    res.json(result);
  });

  router.get("/companies/:companyId/skills/global-catalog", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanMutateCompanySkills(req, companyId);
    const result = await svc.listGlobalCatalog(companyId);
    res.json(result);
  });

  router.get("/companies/:companyId/skills/coverage-audit", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await skillGrants.coverageAudit(companyId);
    res.json(result);
  });

  router.post("/companies/:companyId/skills/coverage-audit/repair-preview", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    await assertCanMutateCompanySkills(req, companyId);
    const result = await skillGrants.previewCoverageRepair(companyId);
    res.json(result);
  });

  router.post(
    "/companies/:companyId/skills/coverage-audit/repair-apply",
    validate(companySkillCoverageRepairApplyRequestSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertBoard(req);
      await assertCanMutateCompanySkills(req, companyId);
      const actor = getActorInfo(req);
      const result = await skillGrants.applyCoverageRepair(companyId, req.body, actor);

      await logActivityFn(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.skill_coverage_repair_applied",
        entityType: "company",
        entityId: companyId,
        details: {
          changedAgentCount: result.changedAgentCount,
          appliedAgentIds: result.appliedAgentIds,
          importedSkillKeys: result.importedSkills.map((skill) => skill.key),
          rollbackPerformed: result.rollbackPerformed,
        },
      });

      res.json(result);
    },
  );

  router.get("/companies/:companyId/skills/:skillId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.detail(companyId, skillId);
    if (!result) {
      res.status(404).json({ error: "Skill not found" });
      return;
    }
    res.json(result);
  });

  router.post(
    "/companies/:companyId/skills/:skillId/bulk-preview",
    validate(bulkSkillGrantRequestSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const skillId = req.params.skillId as string;
      assertBoard(req);
      await assertCanMutateCompanySkills(req, companyId);
      const result = await skillGrants.previewBulkSkillGrant(companyId, skillId, req.body);
      res.json(result);
    },
  );

  router.post(
    "/companies/:companyId/skills/:skillId/bulk-apply",
    validate(bulkSkillGrantApplyRequestSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const skillId = req.params.skillId as string;
      assertBoard(req);
      await assertCanMutateCompanySkills(req, companyId);
      const actor = getActorInfo(req);
      const result = await skillGrants.applyBulkSkillGrant(companyId, skillId, req.body, actor);

      await logActivityFn(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.skill_bulk_grant_applied",
        entityType: "company_skill",
        entityId: skillId,
        details: {
          skillKey: result.skillKey,
          skillName: result.skillName,
          target: result.target,
          tier: result.tier,
          mode: result.mode,
          appliedAgentIds: result.appliedAgentIds,
          matchedAgentCount: result.matchedAgentCount,
          changedAgentCount: result.changedAgentCount,
          rollbackPerformed: result.rollbackPerformed,
        },
      });

      res.json(result);
    },
  );

  router.get("/companies/:companyId/skills/:skillId/update-status", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.updateStatus(companyId, skillId);
    if (!result) {
      res.status(404).json({ error: "Skill not found" });
      return;
    }
    res.json(result);
  });

  router.get("/companies/:companyId/skills/:skillId/files", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    const relativePath = String(req.query.path ?? "SKILL.md");
    assertCompanyAccess(req, companyId);
    const result = await svc.readFile(companyId, skillId, relativePath);
    if (!result) {
      res.status(404).json({ error: "Skill not found" });
      return;
    }
    res.json(result);
  });

  router.post(
    "/companies/:companyId/skills",
    validate(companySkillCreateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCanMutateCompanySkills(req, companyId);
      const result = await svc.createLocalSkill(companyId, req.body);

      const actor = getActorInfo(req);
      await logActivityFn(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.skill_created",
        entityType: "company_skill",
        entityId: result.id,
        details: {
          slug: result.slug,
          name: result.name,
        },
      });

      res.status(201).json(result);
    },
  );

  router.patch(
    "/companies/:companyId/skills/:skillId/files",
    validate(companySkillFileUpdateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const skillId = req.params.skillId as string;
      await assertCanMutateCompanySkills(req, companyId);
      const result = await svc.updateFile(
        companyId,
        skillId,
        String(req.body.path ?? ""),
        String(req.body.content ?? ""),
      );

      const actor = getActorInfo(req);
      await logActivityFn(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.skill_file_updated",
        entityType: "company_skill",
        entityId: skillId,
        details: {
          path: result.path,
          markdown: result.markdown,
        },
      });

      res.json(result);
    },
  );

  router.post(
    "/companies/:companyId/skills/install-global",
    validate(companySkillInstallGlobalSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCanMutateCompanySkills(req, companyId);
      const result = await svc.installGlobalCatalogSkill(companyId, req.body);

      const actor = getActorInfo(req);
      await logActivityFn(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.skill_global_installed",
        entityType: "company_skill",
        entityId: result.id,
        details: {
          key: result.key,
          slug: result.slug,
          sourceType: result.sourceType,
          catalogKey: typeof result.metadata?.catalogKey === "string" ? result.metadata.catalogKey : null,
          catalogSourceRoot:
            typeof result.metadata?.catalogSourceRoot === "string" ? result.metadata.catalogSourceRoot : null,
        },
      });

      res.status(201).json(result);
    },
  );

  router.post(
    "/companies/:companyId/skills/install-global-all",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCanMutateCompanySkills(req, companyId);
      const result = await svc.installAllGlobalCatalogSkills(companyId);

      const actor = getActorInfo(req);
      await logActivityFn(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.skills_global_installed_all",
        entityType: "company",
        entityId: companyId,
        details: {
          discoverableCount: result.discoverableCount,
          installedCount: result.installedCount,
          alreadyInstalledCount: result.alreadyInstalledCount,
          skippedCount: result.skipped.length,
          installedSkillIds: result.installed.map((skill) => skill.id),
          skippedCatalogKeys: result.skipped.map((item) => item.catalogKey),
        },
      });

      res.status(201).json(result);
    },
  );

  router.post(
    "/companies/:companyId/skills/import",
    validate(companySkillImportSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCanMutateCompanySkills(req, companyId);
      const source = String(req.body.source ?? "");
      const result = await svc.importFromSource(companyId, source);

      const actor = getActorInfo(req);
      await logActivityFn(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.skills_imported",
        entityType: "company",
        entityId: companyId,
        details: {
          source,
          importedCount: result.imported.length,
          importedSlugs: result.imported.map((skill) => skill.slug),
          warningCount: result.warnings.length,
        },
      });
      const telemetryClient = getTelemetryClientFn();
      if (telemetryClient) {
        for (const skill of result.imported) {
          trackSkillImportedFn(telemetryClient, {
            sourceType: skill.sourceType,
            skillRef: deriveTrackedSkillRef(skill),
          });
        }
      }

      res.status(201).json(result);
    },
  );

  router.post(
    "/companies/:companyId/skills/scan-projects",
    validate(companySkillProjectScanRequestSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCanMutateCompanySkills(req, companyId);
      const result = await svc.scanProjectWorkspaces(companyId, req.body);

      const actor = getActorInfo(req);
      await logActivityFn(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.skills_scanned",
        entityType: "company",
        entityId: companyId,
        details: {
          scannedProjects: result.scannedProjects,
          scannedWorkspaces: result.scannedWorkspaces,
          discovered: result.discovered,
          importedCount: result.imported.length,
          updatedCount: result.updated.length,
          conflictCount: result.conflicts.length,
          warningCount: result.warnings.length,
        },
      });

      res.json(result);
    },
  );

  router.delete("/companies/:companyId/skills/:skillId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    await assertCanMutateCompanySkills(req, companyId);
    const result = await svc.deleteSkill(companyId, skillId);
    if (!result) {
      res.status(404).json({ error: "Skill not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivityFn(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.skill_deleted",
      entityType: "company_skill",
      entityId: result.id,
      details: {
        slug: result.slug,
        name: result.name,
      },
    });

    res.json(result);
  });

  router.post("/companies/:companyId/skills/:skillId/install-update", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    await assertCanMutateCompanySkills(req, companyId);
    const result = await svc.installUpdate(companyId, skillId);
    if (!result) {
      res.status(404).json({ error: "Skill not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivityFn(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.skill_update_installed",
      entityType: "company_skill",
      entityId: result.id,
      details: {
        slug: result.slug,
        sourceRef: result.sourceRef,
      },
    });

    res.json(result);
  });

  return router;
}
