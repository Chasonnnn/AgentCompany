import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  DEFAULT_FEEDBACK_DATA_SHARING_TERMS_VERSION,
  agentDepartmentKeySchema,
  companyReservedDocumentKeySchema,
  companyPortabilityExportSchema,
  companyPortabilityImportSchema,
  companyPortabilityPreviewSchema,
  createCompanySchema,
  feedbackTargetTypeSchema,
  feedbackTraceStatusSchema,
  feedbackVoteValueSchema,
  restoreProjectDocumentRevisionSchema,
  teamReservedDocumentKeySchema,
  upsertMemoryFileSchema,
  upsertProjectDocumentSchema,
  updateCompanyBrandingSchema,
  updateCompanySchema,
} from "@paperclipai/shared";
import { badRequest, forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import {
  accessService,
  agentService,
  agentTemplateService,
  budgetService,
  companyPortabilityService,
  companyService,
  documentService,
  feedbackService,
  logActivity,
} from "../services/index.js";
import { memoryService } from "../services/memory.js";
import { productivityService } from "../services/productivity.js";
import type { StorageService } from "../storage/types.js";
import { assertBoard, assertCompanyAccess, assertInstanceAdmin, getActorInfo } from "./authz.js";
import { agentHasCreatePermission } from "../services/agent-permissions.js";
import { loadDefaultAgentTemplatePack } from "../services/default-agent-templates.js";

export function companyRoutes(db: Db, storage?: StorageService) {
  const router = Router();
  const svc = companyService(db);
  const agents = agentService(db);
  const templates = agentTemplateService(db);
  const portability = companyPortabilityService(db, storage);
  const access = accessService(db);
  const budgets = budgetService(db);
  const documents = documentService(db);
  const feedback = feedbackService(db);
  const productivity = productivityService(db);
  const memory = memoryService();

  function parseBooleanQuery(value: unknown) {
    return value === true || value === "true" || value === "1";
  }

  function parseDateQuery(value: unknown, field: string) {
    if (typeof value !== "string" || value.trim().length === 0) return undefined;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw badRequest(`Invalid ${field} query value`);
    }
    return parsed;
  }

  function parseProductivityWindow(value: unknown) {
    return value === "30d" || value === "all" ? value : "7d";
  }

  async function assertCanUpdateBranding(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "board") return;
    if (!req.actor.agentId) throw forbidden("Agent authentication required");

    const actorAgent = await agents.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== companyId) {
      throw forbidden("Agent key cannot access another company");
    }
    if (!agentHasCreatePermission(actorAgent)) {
      throw forbidden("Only agents with create authority can update company branding");
    }
  }

  async function assertCanManagePortability(req: Request, companyId: string, capability: "imports" | "exports") {
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "board") return;
    if (!req.actor.agentId) throw forbidden("Agent authentication required");

    const actorAgent = await agents.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== companyId) {
      throw forbidden("Agent key cannot access another company");
    }
    if (!agentHasCreatePermission(actorAgent)) {
      throw forbidden(`Only agents with create authority can manage company ${capability}`);
    }
  }

  function assertImportTargetAccess(
    req: Request,
    target: { mode: "new_company" } | { mode: "existing_company"; companyId: string },
  ) {
    if (target.mode === "new_company") {
      assertInstanceAdmin(req);
      return;
    }
    assertCompanyAccess(req, target.companyId);
  }

  router.get("/", async (req, res) => {
    assertBoard(req);
    const result = await svc.list();
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
      res.json(result);
      return;
    }
    const allowed = new Set(req.actor.companyIds ?? []);
    res.json(result.filter((company) => allowed.has(company.id)));
  });

  router.get("/stats", async (req, res) => {
    assertBoard(req);
    const allowed = req.actor.source === "local_implicit" || req.actor.isInstanceAdmin
      ? null
      : new Set(req.actor.companyIds ?? []);
    const stats = await svc.stats();
    if (!allowed) {
      res.json(stats);
      return;
    }
    const filtered = Object.fromEntries(Object.entries(stats).filter(([companyId]) => allowed.has(companyId)));
    res.json(filtered);
  });

  // Common malformed path when companyId is empty in "/api/companies/{companyId}/issues".
  router.get("/issues", (_req, res) => {
    res.status(400).json({
      error: "Missing companyId in path. Use /api/companies/{companyId}/issues.",
    });
  });

  router.get("/:companyId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    // Allow agents (CEO) to read their own company; board always allowed
    if (req.actor.type !== "agent") {
      assertBoard(req);
    }
    const company = await svc.getById(companyId);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    res.json(company);
  });

  router.get("/:companyId/memory", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const company = await svc.getById(companyId);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    res.json(await memory.getCompanyMemory(companyId));
  });

  router.get("/:companyId/productivity", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const company = await svc.getById(companyId);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    res.json(await productivity.companySummary(companyId, { window: parseProductivityWindow(req.query.window) }));
  });

  router.get("/:companyId/memory/file", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const relativePath = typeof req.query.path === "string" ? req.query.path : "";
    if (!relativePath.trim()) {
      res.status(422).json({ error: "Query parameter 'path' is required" });
      return;
    }
    const company = await svc.getById(companyId);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    res.json(await memory.readCompanyMemoryFile(companyId, relativePath));
  });

  router.put("/:companyId/memory/file", validate(upsertMemoryFileSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const company = await svc.getById(companyId);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    const actor = getActorInfo(req);
    const result = await memory.writeCompanyMemoryFile(companyId, req.body.path, req.body.content);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.memory_file_updated",
      entityType: "company",
      entityId: companyId,
      details: {
        path: result.file.path,
        size: result.file.size,
        layer: result.file.layer,
      },
    });
    res.json(result.file);
  });

  function assertCompanyDocumentKey(rawKey: string) {
    return companyReservedDocumentKeySchema.parse(rawKey);
  }

  function assertTeamDocumentKey(rawKey: string) {
    return teamReservedDocumentKeySchema.parse(rawKey);
  }

  function parseDepartmentScope(req: Request) {
    const departmentKey = agentDepartmentKeySchema.parse(req.params.departmentKey as string);
    const departmentNameRaw = typeof req.query.departmentName === "string" ? req.query.departmentName : null;
    const departmentName = departmentNameRaw?.trim() ? departmentNameRaw.trim() : null;
    return { departmentKey, departmentName };
  }

  router.get("/:companyId/documents", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    res.json(await documents.listCompanyDocuments(companyId));
  });

  router.get("/:companyId/documents/:key", async (req, res) => {
    const companyId = req.params.companyId as string;
    const key = assertCompanyDocumentKey(req.params.key as string);
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const document = await documents.getCompanyDocumentByKey(companyId, key);
    if (!document) {
      res.status(404).json({ error: "Company document not found" });
      return;
    }
    res.json(document);
  });

  router.put("/:companyId/documents/:key", validate(upsertProjectDocumentSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const key = assertCompanyDocumentKey(req.params.key as string);
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const actor = getActorInfo(req);
    const result = await documents.upsertCompanyDocument({
      companyId,
      key,
      ...req.body,
      createdByAgentId: actor.agentId,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      createdByRunId: actor.runId,
    });
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: result.created ? "company.document_created" : "company.document_updated",
      entityType: "company",
      entityId: companyId,
      details: {
        key,
        revisionNumber: result.document.latestRevisionNumber,
      },
    });
    res.status(result.created ? 201 : 200).json(result.document);
  });

  router.get("/:companyId/documents/:key/revisions", async (req, res) => {
    const companyId = req.params.companyId as string;
    const key = assertCompanyDocumentKey(req.params.key as string);
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    res.json(await documents.listCompanyDocumentRevisions(companyId, key));
  });

  router.post(
    "/:companyId/documents/:key/revisions/:revisionId/restore",
    validate(restoreProjectDocumentRevisionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const key = assertCompanyDocumentKey(req.params.key as string);
      const revisionId = req.params.revisionId as string;
      assertCompanyAccess(req, companyId);
      assertBoard(req);
      const actor = getActorInfo(req);
      const result = await documents.restoreCompanyDocumentRevision({
        companyId,
        key,
        revisionId,
        createdByAgentId: actor.agentId,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      });
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.document_restored",
        entityType: "company",
        entityId: companyId,
        details: {
          key,
          revisionId,
          restoredFromRevisionNumber: result.restoredFromRevisionNumber,
        },
      });
      res.json(result.document);
    },
  );

  router.delete("/:companyId/documents/:key", async (req, res) => {
    const companyId = req.params.companyId as string;
    const key = assertCompanyDocumentKey(req.params.key as string);
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const deleted = await documents.deleteCompanyDocument(companyId, key);
    if (!deleted) {
      res.status(404).json({ error: "Company document not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.document_deleted",
      entityType: "company",
      entityId: companyId,
      details: { key },
    });
    res.json(deleted);
  });

  router.get("/:companyId/team-documents", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    res.json(await documents.listTeamDocuments(companyId));
  });

  router.get("/:companyId/team-documents/:departmentKey/:key", async (req, res) => {
    const companyId = req.params.companyId as string;
    const { departmentKey, departmentName } = parseDepartmentScope(req);
    const key = assertTeamDocumentKey(req.params.key as string);
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const document = await documents.getTeamDocumentByScope({
      companyId,
      departmentKey,
      departmentName,
      key,
    });
    if (!document) {
      res.status(404).json({ error: "Team document not found" });
      return;
    }
    res.json(document);
  });

  router.put("/:companyId/team-documents/:departmentKey/:key", validate(upsertProjectDocumentSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const { departmentKey, departmentName } = parseDepartmentScope(req);
    const key = assertTeamDocumentKey(req.params.key as string);
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const actor = getActorInfo(req);
    const result = await documents.upsertTeamDocument({
      companyId,
      departmentKey,
      departmentName,
      key,
      ...req.body,
      createdByAgentId: actor.agentId,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      createdByRunId: actor.runId,
    });
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: result.created ? "team.document_created" : "team.document_updated",
      entityType: "company",
      entityId: companyId,
      details: {
        departmentKey,
        departmentName,
        key,
        revisionNumber: result.document.latestRevisionNumber,
      },
    });
    res.status(result.created ? 201 : 200).json(result.document);
  });

  router.get("/:companyId/team-documents/:departmentKey/:key/revisions", async (req, res) => {
    const companyId = req.params.companyId as string;
    const { departmentKey, departmentName } = parseDepartmentScope(req);
    const key = assertTeamDocumentKey(req.params.key as string);
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    res.json(await documents.listTeamDocumentRevisions({ companyId, departmentKey, departmentName, key }));
  });

  router.post(
    "/:companyId/team-documents/:departmentKey/:key/revisions/:revisionId/restore",
    validate(restoreProjectDocumentRevisionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const { departmentKey, departmentName } = parseDepartmentScope(req);
      const key = assertTeamDocumentKey(req.params.key as string);
      const revisionId = req.params.revisionId as string;
      assertCompanyAccess(req, companyId);
      assertBoard(req);
      const actor = getActorInfo(req);
      const result = await documents.restoreTeamDocumentRevision({
        companyId,
        departmentKey,
        departmentName,
        key,
        revisionId,
        createdByAgentId: actor.agentId,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      });
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "team.document_restored",
        entityType: "company",
        entityId: companyId,
        details: {
          departmentKey,
          departmentName,
          key,
          revisionId,
          restoredFromRevisionNumber: result.restoredFromRevisionNumber,
        },
      });
      res.json(result.document);
    },
  );

  router.delete("/:companyId/team-documents/:departmentKey/:key", async (req, res) => {
    const companyId = req.params.companyId as string;
    const { departmentKey, departmentName } = parseDepartmentScope(req);
    const key = assertTeamDocumentKey(req.params.key as string);
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const deleted = await documents.deleteTeamDocument({ companyId, departmentKey, departmentName, key });
    if (!deleted) {
      res.status(404).json({ error: "Team document not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "team.document_deleted",
      entityType: "company",
      entityId: companyId,
      details: {
        departmentKey,
        departmentName,
        key,
      },
    });
    res.json(deleted);
  });

  router.get("/:companyId/feedback-traces", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);

    const targetTypeRaw = typeof req.query.targetType === "string" ? req.query.targetType : undefined;
    const voteRaw = typeof req.query.vote === "string" ? req.query.vote : undefined;
    const statusRaw = typeof req.query.status === "string" ? req.query.status : undefined;
    const issueId = typeof req.query.issueId === "string" && req.query.issueId.trim().length > 0 ? req.query.issueId : undefined;
    const projectId = typeof req.query.projectId === "string" && req.query.projectId.trim().length > 0
      ? req.query.projectId
      : undefined;

    const traces = await feedback.listFeedbackTraces({
      companyId,
      issueId,
      projectId,
      targetType: targetTypeRaw ? feedbackTargetTypeSchema.parse(targetTypeRaw) : undefined,
      vote: voteRaw ? feedbackVoteValueSchema.parse(voteRaw) : undefined,
      status: statusRaw ? feedbackTraceStatusSchema.parse(statusRaw) : undefined,
      from: parseDateQuery(req.query.from, "from"),
      to: parseDateQuery(req.query.to, "to"),
      sharedOnly: parseBooleanQuery(req.query.sharedOnly),
      includePayload: parseBooleanQuery(req.query.includePayload),
    });
    res.json(traces);
  });

  router.post("/:companyId/export", validate(companyPortabilityExportSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await portability.exportBundle(companyId, req.body);
    res.json(result);
  });

  router.post("/import/preview", validate(companyPortabilityPreviewSchema), async (req, res) => {
    assertBoard(req);
    assertImportTargetAccess(req, req.body.target);
    const preview = await portability.previewImport(req.body);
    res.json(preview);
  });

  router.post("/import", validate(companyPortabilityImportSchema), async (req, res) => {
    assertBoard(req);
    assertImportTargetAccess(req, req.body.target);
    const actor = getActorInfo(req);
    const result = await portability.importBundle(req.body, req.actor.type === "board" ? req.actor.userId : null);
    await logActivity(db, {
      companyId: result.company.id,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "company.imported",
      entityType: "company",
      entityId: result.company.id,
      agentId: actor.agentId,
      runId: actor.runId,
      details: {
        include: req.body.include ?? null,
        agentCount: result.agents.length,
        warningCount: result.warnings.length,
        companyAction: result.company.action,
      },
    });
    res.json(result);
  });

  router.post("/:companyId/exports/preview", validate(companyPortabilityExportSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanManagePortability(req, companyId, "exports");
    const preview = await portability.previewExport(companyId, req.body);
    res.json(preview);
  });

  router.post("/:companyId/exports", validate(companyPortabilityExportSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanManagePortability(req, companyId, "exports");
    const result = await portability.exportBundle(companyId, req.body);
    res.json(result);
  });

  router.post("/:companyId/imports/preview", validate(companyPortabilityPreviewSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanManagePortability(req, companyId, "imports");
    if (req.body.target.mode === "existing_company" && req.body.target.companyId !== companyId) {
      throw forbidden("Safe import route can only target the route company");
    }
    if (req.body.collisionStrategy === "replace") {
      throw forbidden("Safe import route does not allow replace collision strategy");
    }
    const preview = await portability.previewImport(req.body, {
      mode: "agent_safe",
      sourceCompanyId: companyId,
    });
    res.json(preview);
  });

  router.post("/:companyId/imports/apply", validate(companyPortabilityImportSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanManagePortability(req, companyId, "imports");
    if (req.body.target.mode === "existing_company" && req.body.target.companyId !== companyId) {
      throw forbidden("Safe import route can only target the route company");
    }
    if (req.body.collisionStrategy === "replace") {
      throw forbidden("Safe import route does not allow replace collision strategy");
    }
    const actor = getActorInfo(req);
    const result = await portability.importBundle(req.body, req.actor.type === "board" ? req.actor.userId : null, {
      mode: "agent_safe",
      sourceCompanyId: companyId,
    });
    await logActivity(db, {
      companyId: result.company.id,
      actorType: actor.actorType,
      actorId: actor.actorId,
      entityType: "company",
      entityId: result.company.id,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.imported",
      details: {
        include: req.body.include ?? null,
        agentCount: result.agents.length,
        warningCount: result.warnings.length,
        companyAction: result.company.action,
        importMode: "agent_safe",
      },
    });
    res.json(result);
  });

  router.post("/", validate(createCompanySchema), async (req, res) => {
    assertBoard(req);
    if (!(req.actor.source === "local_implicit" || req.actor.isInstanceAdmin)) {
      throw forbidden("Instance admin required");
    }
    const company = await svc.create(req.body);
    await access.ensureMembership(company.id, "user", req.actor.userId ?? "local-board", "owner", "active");
    await logActivity(db, {
      companyId: company.id,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "company.created",
      entityType: "company",
      entityId: company.id,
      details: { name: company.name },
    });
    if (company.budgetMonthlyCents > 0) {
      await budgets.upsertPolicy(
        company.id,
        {
          scopeType: "company",
          scopeId: company.id,
          amount: company.budgetMonthlyCents,
          windowKind: "calendar_month_utc",
        },
        req.actor.userId ?? "board",
      );
    }
    await templates.importPack(company.id, await loadDefaultAgentTemplatePack(), {
      createdByUserId: req.actor.userId ?? "local-board",
    });
    res.status(201).json(company);
  });

  router.patch("/:companyId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const actor = getActorInfo(req);
    const existingCompany = await svc.getById(companyId);
    if (!existingCompany) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    let body: Record<string, unknown>;

    if (req.actor.type === "agent") {
      const agentSvc = agentService(db);
      const actorAgent = req.actor.agentId ? await agentSvc.getById(req.actor.agentId) : null;
      if (!actorAgent || !agentHasCreatePermission(actorAgent)) {
        throw forbidden("Only agents with create authority or board users may update company settings");
      }
      if (actorAgent.companyId !== companyId) {
        throw forbidden("Agent key cannot access another company");
      }
      body = updateCompanyBrandingSchema.parse(req.body);
    } else {
      assertBoard(req);
      body = updateCompanySchema.parse(req.body);

      if (body.feedbackDataSharingEnabled === true && !existingCompany.feedbackDataSharingEnabled) {
        body = {
          ...body,
          feedbackDataSharingConsentAt: new Date(),
          feedbackDataSharingConsentByUserId: req.actor.userId ?? "local-board",
          feedbackDataSharingTermsVersion:
            typeof body.feedbackDataSharingTermsVersion === "string" && body.feedbackDataSharingTermsVersion.length > 0
              ? body.feedbackDataSharingTermsVersion
              : DEFAULT_FEEDBACK_DATA_SHARING_TERMS_VERSION,
        };
      }
    }

    const company = await svc.update(companyId, body);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.updated",
      entityType: "company",
      entityId: companyId,
      details: body,
    });
    res.json(company);
  });

  router.patch("/:companyId/branding", validate(updateCompanyBrandingSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanUpdateBranding(req, companyId);
    const company = await svc.update(companyId, req.body);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.branding_updated",
      entityType: "company",
      entityId: companyId,
      details: req.body,
    });
    res.json(company);
  });

  router.post("/:companyId/archive", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const company = await svc.archive(companyId);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "company.archived",
      entityType: "company",
      entityId: companyId,
    });
    res.json(company);
  });

  router.delete("/:companyId", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const company = await svc.remove(companyId);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    res.json({ ok: true });
  });

  return router;
}
