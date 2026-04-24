import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { agentProjectScopes } from "@paperclipai/db";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import {
  createProjectSchema,
  createProjectWorkspaceSchema,
  isUuidLike,
  projectDocumentKeySchema,
  restoreProjectDocumentRevisionSchema,
  upsertProjectDocumentSchema,
  updateProjectSchema,
  updateProjectWorkspaceSchema,
} from "@paperclipai/shared";
import { trackProjectCreated } from "@paperclipai/shared/telemetry";
import { validate } from "../middleware/validate.js";
import {
  documentService,
  environmentService,
  heartbeatService,
  officeCoordinationService,
  projectService,
  logActivity as baseLogActivity,
  secretService,
  workspaceOperationService,
} from "../services/index.js";
import { conflict, forbidden } from "../errors.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { startRuntimeServicesForWorkspaceControl, stopRuntimeServicesForProjectWorkspace } from "../services/workspace-runtime.js";
import { getTelemetryClient } from "../telemetry.js";
import {
  assertNoAgentHostWorkspaceCommandMutation,
  collectProjectExecutionWorkspaceCommandPaths,
  collectProjectWorkspaceCommandPaths,
} from "./workspace-command-authz.js";
import { assertCanManageProjectWorkspaceRuntimeServices } from "./workspace-runtime-service-authz.js";
import { appendWithCap } from "../adapters/utils.js";
import { wakeCompanyOfficeOperatorSafely } from "../services/office-coordination-wakeup.js";
import { assertEnvironmentSelectionForCompany } from "./environment-selection.js";

const WORKSPACE_CONTROL_OUTPUT_MAX_CHARS = 256 * 1024;

type ProjectRouteDeps = {
  documentService: ReturnType<typeof documentService>;
  heartbeatService: ReturnType<typeof heartbeatService>;
  projectService: ReturnType<typeof projectService>;
  logActivity: typeof baseLogActivity;
  officeCoordinationService: ReturnType<typeof officeCoordinationService>;
  secretService: ReturnType<typeof secretService>;
  workspaceOperationService: ReturnType<typeof workspaceOperationService>;
};

export function projectRoutes(
  db: Db,
  opts?: {
    services?: Partial<ProjectRouteDeps>;
    telemetry?: {
      getTelemetryClient?: typeof getTelemetryClient;
      trackProjectCreated?: typeof trackProjectCreated;
    };
  },
) {
  const router = Router();
  const svc = opts?.services?.projectService ?? projectService(db);
  const documentsSvc = opts?.services?.documentService ?? documentService(db);
  const heartbeat = opts?.services?.heartbeatService ?? heartbeatService(db);
  const officeCoordinationSvc =
    opts?.services?.officeCoordinationService ?? officeCoordinationService(db);
  const secretsSvc = opts?.services?.secretService ?? secretService(db);
  const workspaceOperations =
    opts?.services?.workspaceOperationService ?? workspaceOperationService(db);
  const logActivity = opts?.services?.logActivity ?? baseLogActivity;
  const getTelemetryClientFn =
    opts?.telemetry?.getTelemetryClient ?? getTelemetryClient;
  const trackProjectCreatedFn =
    opts?.telemetry?.trackProjectCreated ?? trackProjectCreated;
  const strictSecretsMode = process.env.PAPERCLIP_SECRETS_STRICT_MODE === "true";
  const environmentsSvc = environmentService(db);

  async function assertProjectEnvironmentSelection(companyId: string, environmentId: string | null | undefined) {
    if (environmentId === undefined || environmentId === null) return;
    await assertEnvironmentSelectionForCompany(environmentsSvc, companyId, environmentId, {
      allowedDrivers: ["local", "ssh"],
    });
  }

  function readProjectPolicyEnvironmentId(policy: unknown): string | null | undefined {
    if (!policy || typeof policy !== "object" || !("environmentId" in policy)) {
      return undefined;
    }
    const environmentId = (policy as { environmentId?: unknown }).environmentId;
    return typeof environmentId === "string" || environmentId === null ? environmentId : undefined;
  }

  async function resolveCompanyIdForProjectReference(req: Request) {
    const companyIdQuery = req.query.companyId;
    const requestedCompanyId =
      typeof companyIdQuery === "string" && companyIdQuery.trim().length > 0
        ? companyIdQuery.trim()
        : null;
    if (requestedCompanyId) {
      assertCompanyAccess(req, requestedCompanyId);
      return requestedCompanyId;
    }
    if (req.actor.type === "agent" && req.actor.companyId) {
      return req.actor.companyId;
    }
    return null;
  }

  async function normalizeProjectReference(req: Request, rawId: string) {
    if (isUuidLike(rawId)) return rawId;
    const companyId = await resolveCompanyIdForProjectReference(req);
    if (!companyId) return rawId;
    const resolved = await svc.resolveByReference(companyId, rawId);
    if (resolved.ambiguous) {
      throw conflict("Project shortname is ambiguous in this company. Use the project ID.");
    }
    return resolved.project?.id ?? rawId;
  }

  async function hasActiveProjectScope(agentId: string, projectId: string, allowedRoles?: string[]) {
    const now = new Date();
    const conditions = [
      eq(agentProjectScopes.agentId, agentId),
      eq(agentProjectScopes.projectId, projectId),
      or(isNull(agentProjectScopes.activeTo), gt(agentProjectScopes.activeTo, now)),
    ];
    if (allowedRoles?.length) {
      conditions.push(or(...allowedRoles.map((role) => eq(agentProjectScopes.projectRole, role as any))));
    }
    const row = await db
      .select({ id: agentProjectScopes.id })
      .from(agentProjectScopes)
      .where(and(...conditions))
      .then((rows) => rows[0] ?? null);
    return !!row;
  }

  async function assertCanReadProjectDocuments(req: Request, project: { id: string; companyId: string }) {
    assertCompanyAccess(req, project.companyId);
    if (req.actor.type === "board") return;
    if (!req.actor.agentId) throw forbidden("Agent authentication required");
    const allowed = await hasActiveProjectScope(req.actor.agentId, project.id);
    if (!allowed) throw forbidden("Project scope required");
  }

  async function assertCanWriteProjectDocuments(req: Request, project: { id: string; companyId: string }) {
    assertCompanyAccess(req, project.companyId);
    if (req.actor.type === "board") return;
    if (!req.actor.agentId) throw forbidden("Agent authentication required");
    const allowed = await hasActiveProjectScope(req.actor.agentId, project.id, [
      "director",
      "product_manager",
      "engineering_manager",
      "functional_lead",
    ]);
    if (!allowed) throw forbidden("Project leadership scope required");
  }

  function assertProjectDocumentKey(rawKey: string) {
    return projectDocumentKeySchema.parse(rawKey);
  }

  router.param("id", async (req, _res, next, rawId) => {
    try {
      req.params.id = await normalizeProjectReference(req, rawId);
      next();
    } catch (err) {
      next(err);
    }
  });

  router.get("/companies/:companyId/projects", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.list(companyId);
    res.json(result);
  });

  router.get("/projects/:id", async (req, res) => {
    const id = req.params.id as string;
    const project = await svc.getById(id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertCompanyAccess(req, project.companyId);
    res.json(project);
  });

  router.get("/projects/:id/documents", async (req, res) => {
    const id = req.params.id as string;
    const project = await svc.getById(id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    await assertCanReadProjectDocuments(req, project);
    const documents = await documentsSvc.listProjectDocuments(id);
    res.json(documents);
  });

  router.get("/projects/:id/documents/:key", async (req, res) => {
    const id = req.params.id as string;
    const key = assertProjectDocumentKey(req.params.key as string);
    const project = await svc.getById(id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    await assertCanReadProjectDocuments(req, project);
    const document = await documentsSvc.getProjectDocumentByKey(id, key);
    if (!document) {
      res.status(404).json({ error: "Project document not found" });
      return;
    }
    res.json(document);
  });

  router.put("/projects/:id/documents/:key", validate(upsertProjectDocumentSchema), async (req, res) => {
    const id = req.params.id as string;
    const key = assertProjectDocumentKey(req.params.key as string);
    const project = await svc.getById(id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    await assertCanWriteProjectDocuments(req, project);
    const actor = getActorInfo(req);
    const result = await documentsSvc.upsertProjectDocument({
      projectId: id,
      key,
      ...req.body,
      createdByAgentId: actor.agentId,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      createdByRunId: actor.runId,
    });
    await logActivity(db, {
      companyId: project.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: result.created ? "project.document_created" : "project.document_updated",
      entityType: "project",
      entityId: id,
      details: {
        key,
        revisionNumber: result.document.latestRevisionNumber,
      },
    });
    res.status(result.created ? 201 : 200).json(result.document);
  });

  router.get("/projects/:id/documents/:key/revisions", async (req, res) => {
    const id = req.params.id as string;
    const key = assertProjectDocumentKey(req.params.key as string);
    const project = await svc.getById(id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    await assertCanReadProjectDocuments(req, project);
    res.json(await documentsSvc.listProjectDocumentRevisions(id, key));
  });

  router.post(
    "/projects/:id/documents/:key/revisions/:revisionId/restore",
    validate(restoreProjectDocumentRevisionSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const key = assertProjectDocumentKey(req.params.key as string);
      const revisionId = req.params.revisionId as string;
      const project = await svc.getById(id);
      if (!project) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      await assertCanWriteProjectDocuments(req, project);
      const actor = getActorInfo(req);
      const result = await documentsSvc.restoreProjectDocumentRevision({
        projectId: id,
        key,
        revisionId,
        createdByAgentId: actor.agentId,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      });
      await logActivity(db, {
        companyId: project.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "project.document_restored",
        entityType: "project",
        entityId: id,
        details: {
          key,
          revisionId,
          restoredFromRevisionNumber: result.restoredFromRevisionNumber,
        },
      });
      res.json(result.document);
    },
  );

  router.delete("/projects/:id/documents/:key", async (req, res) => {
    const id = req.params.id as string;
    const key = assertProjectDocumentKey(req.params.key as string);
    const project = await svc.getById(id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    await assertCanWriteProjectDocuments(req, project);
    const deleted = await documentsSvc.deleteProjectDocument(id, key);
    if (!deleted) {
      res.status(404).json({ error: "Project document not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: project.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "project.document_deleted",
      entityType: "project",
      entityId: id,
      details: { key },
    });
    res.json(deleted);
  });

  router.post("/companies/:companyId/projects", validate(createProjectSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    type CreateProjectPayload = Parameters<typeof svc.create>[1] & {
      workspace?: Parameters<typeof svc.createWorkspace>[1];
    };

    const { workspace, ...projectData } = req.body as CreateProjectPayload;
    await assertProjectEnvironmentSelection(
      companyId,
      readProjectPolicyEnvironmentId(projectData.executionWorkspacePolicy),
    );
    assertNoAgentHostWorkspaceCommandMutation(
      req,
      [
        ...collectProjectExecutionWorkspaceCommandPaths(projectData.executionWorkspacePolicy),
        ...collectProjectWorkspaceCommandPaths(workspace, "workspace"),
      ],
    );
    if (projectData.env !== undefined) {
      projectData.env = await secretsSvc.normalizeEnvBindingsForPersistence(
        companyId,
        projectData.env,
        { strictMode: strictSecretsMode, fieldPath: "env" },
      );
    }
    const project = await svc.create(companyId, projectData);
    let createdWorkspaceId: string | null = null;
    if (workspace) {
      const createdWorkspace = await svc.createWorkspace(project.id, workspace);
      if (!createdWorkspace) {
        await svc.remove(project.id);
        res.status(422).json({ error: "Invalid project workspace payload" });
        return;
      }
      createdWorkspaceId = createdWorkspace.id;
    }
    const hydratedProject = workspace ? await svc.getById(project.id) : project;

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "project.created",
      entityType: "project",
      entityId: project.id,
      details: {
        name: project.name,
        workspaceId: createdWorkspaceId,
        envKeys: project.env ? Object.keys(project.env).sort() : [],
      },
    });
    const telemetryClient = getTelemetryClientFn();
    if (telemetryClient) {
      trackProjectCreatedFn(telemetryClient);
    }

    void wakeCompanyOfficeOperatorSafely({
      officeCoordination: officeCoordinationSvc,
      heartbeat,
      companyId,
      reason: "project_created",
      entityType: "project",
      entityId: project.id,
      summary: project.name,
      requestedByActorType: actor.actorType,
      requestedByActorId: actor.actorId,
      skipIfActorAgentId: actor.agentId ?? null,
      logContext: { projectId: project.id },
    });

    res.status(201).json(hydratedProject ?? project);
  });

  router.patch("/projects/:id", validate(updateProjectSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const body = { ...req.body };
    assertNoAgentHostWorkspaceCommandMutation(
      req,
      collectProjectExecutionWorkspaceCommandPaths(body.executionWorkspacePolicy),
    );
    await assertProjectEnvironmentSelection(
      existing.companyId,
      readProjectPolicyEnvironmentId(body.executionWorkspacePolicy),
    );
    if (typeof body.archivedAt === "string") {
      body.archivedAt = new Date(body.archivedAt);
    }
    if (body.env !== undefined) {
      body.env = await secretsSvc.normalizeEnvBindingsForPersistence(existing.companyId, body.env, {
        strictMode: strictSecretsMode,
        fieldPath: "env",
      });
    }
    const project = await svc.update(id, body);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: project.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "project.updated",
      entityType: "project",
      entityId: project.id,
      details: {
        changedKeys: Object.keys(req.body).sort(),
        envKeys:
          body.env && typeof body.env === "object" && !Array.isArray(body.env)
            ? Object.keys(body.env as Record<string, unknown>).sort()
            : undefined,
      },
    });

    if (!project.leadAgentId) {
      void wakeCompanyOfficeOperatorSafely({
        officeCoordination: officeCoordinationSvc,
        heartbeat,
        companyId: project.companyId,
        reason: "project_staffing_gap_detected",
        entityType: "project",
        entityId: project.id,
        summary: project.name,
        requestedByActorType: actor.actorType,
        requestedByActorId: actor.actorId,
        skipIfActorAgentId: actor.agentId ?? null,
        logContext: { projectId: project.id },
      });
    }

    res.json(project);
  });

  router.get("/projects/:id/workspaces", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const workspaces = await svc.listWorkspaces(id);
    res.json(workspaces);
  });

  router.post("/projects/:id/workspaces", validate(createProjectWorkspaceSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    assertNoAgentHostWorkspaceCommandMutation(
      req,
      collectProjectWorkspaceCommandPaths(req.body),
    );
    const workspace = await svc.createWorkspace(id, req.body);
    if (!workspace) {
      res.status(422).json({ error: "Invalid project workspace payload" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "project.workspace_created",
      entityType: "project",
      entityId: id,
      details: {
        workspaceId: workspace.id,
        name: workspace.name,
        cwd: workspace.cwd,
        isPrimary: workspace.isPrimary,
      },
    });

    res.status(201).json(workspace);
  });

  router.patch(
    "/projects/:id/workspaces/:workspaceId",
    validate(updateProjectWorkspaceSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const workspaceId = req.params.workspaceId as string;
      const existing = await svc.getById(id);
      if (!existing) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      assertCompanyAccess(req, existing.companyId);
      assertNoAgentHostWorkspaceCommandMutation(
        req,
        collectProjectWorkspaceCommandPaths(req.body),
      );
      const workspaceExists = (await svc.listWorkspaces(id)).some((workspace) => workspace.id === workspaceId);
      if (!workspaceExists) {
        res.status(404).json({ error: "Project workspace not found" });
        return;
      }
      const workspace = await svc.updateWorkspace(id, workspaceId, req.body);
      if (!workspace) {
        res.status(422).json({ error: "Invalid project workspace payload" });
        return;
      }

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: existing.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "project.workspace_updated",
        entityType: "project",
        entityId: id,
        details: {
          workspaceId: workspace.id,
          changedKeys: Object.keys(req.body).sort(),
        },
      });

      res.json(workspace);
    },
  );

  router.post("/projects/:id/workspaces/:workspaceId/runtime-services/:action", async (req, res) => {
    const id = req.params.id as string;
    const workspaceId = req.params.workspaceId as string;
    const action = String(req.params.action ?? "").trim().toLowerCase();
    if (action !== "start" && action !== "stop" && action !== "restart") {
      res.status(404).json({ error: "Runtime service action not found" });
      return;
    }

    const project = await svc.getById(id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertCompanyAccess(req, project.companyId);
    await assertCanManageProjectWorkspaceRuntimeServices(db, req, {
      companyId: project.companyId,
      projectWorkspaceId: workspaceId,
    });

    const workspace = project.workspaces.find((entry) => entry.id === workspaceId) ?? null;
    if (!workspace) {
      res.status(404).json({ error: "Project workspace not found" });
      return;
    }

    const workspaceCwd = workspace.cwd;
    if (!workspaceCwd) {
      res.status(422).json({ error: "Project workspace needs a local path before Paperclip can manage local runtime services" });
      return;
    }

    const runtimeConfig = workspace.runtimeConfig?.workspaceRuntime ?? null;
    if ((action === "start" || action === "restart") && !runtimeConfig) {
      res.status(422).json({ error: "Project workspace has no runtime service configuration" });
      return;
    }

    const actor = getActorInfo(req);
    const recorder = workspaceOperations.createRecorder({ companyId: project.companyId });
    let runtimeServiceCount = workspace.runtimeServices?.length ?? 0;
    let stdout = "";
    let stderr = "";

    const operation = await recorder.recordOperation({
      phase: action === "stop" ? "workspace_teardown" : "workspace_provision",
      command: `workspace runtime ${action}`,
      cwd: workspace.cwd,
      metadata: {
        action,
        projectId: project.id,
        projectWorkspaceId: workspace.id,
      },
      run: async () => {
        const onLog = async (stream: "stdout" | "stderr", chunk: string) => {
          if (stream === "stdout") stdout = appendWithCap(stdout, chunk, WORKSPACE_CONTROL_OUTPUT_MAX_CHARS);
          else stderr = appendWithCap(stderr, chunk, WORKSPACE_CONTROL_OUTPUT_MAX_CHARS);
        };

        if (action === "stop" || action === "restart") {
          await stopRuntimeServicesForProjectWorkspace({
            db,
            projectWorkspaceId: workspace.id,
          });
        }

        if (action === "start" || action === "restart") {
          const startedServices = await startRuntimeServicesForWorkspaceControl({
            db,
            actor: {
              id: actor.agentId ?? null,
              name: actor.actorType === "user" ? "Board" : "Agent",
              companyId: project.companyId,
            },
            issue: null,
            workspace: {
              baseCwd: workspaceCwd,
              source: "project_primary",
              projectId: project.id,
              workspaceId: workspace.id,
              repoUrl: workspace.repoUrl,
              repoRef: workspace.repoRef,
              strategy: "project_primary",
              cwd: workspaceCwd,
              branchName: workspace.defaultRef ?? workspace.repoRef ?? null,
              worktreePath: null,
              warnings: [],
              created: false,
            },
            config: { workspaceRuntime: runtimeConfig },
            adapterEnv: {},
            onLog,
          });
          runtimeServiceCount = startedServices.length;
        } else {
          runtimeServiceCount = 0;
        }

        const currentDesiredState = workspace.runtimeConfig?.desiredState ?? null;
        const nextDesiredState = currentDesiredState === "manual"
          ? "manual"
          : action === "stop"
            ? "stopped"
            : "running";

        await svc.updateWorkspace(project.id, workspace.id, {
          runtimeConfig: {
            desiredState: nextDesiredState,
          },
        });

        return {
          status: "succeeded",
          stdout,
          stderr,
          system:
            action === "stop"
              ? "Stopped project workspace runtime services.\n"
              : action === "restart"
                ? "Restarted project workspace runtime services.\n"
                : "Started project workspace runtime services.\n",
          metadata: {
            runtimeServiceCount,
          },
        };
      },
    });

    const updatedWorkspace = (await svc.listWorkspaces(project.id)).find((entry) => entry.id === workspace.id) ?? workspace;

    await logActivity(db, {
      companyId: project.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: `project.workspace_runtime_${action}`,
      entityType: "project",
      entityId: project.id,
      details: {
        projectWorkspaceId: workspace.id,
        runtimeServiceCount,
      },
    });

    res.json({
      workspace: updatedWorkspace,
      operation,
    });
  });

  router.delete("/projects/:id/workspaces/:workspaceId", async (req, res) => {
    const id = req.params.id as string;
    const workspaceId = req.params.workspaceId as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const workspace = await svc.removeWorkspace(id, workspaceId);
    if (!workspace) {
      res.status(404).json({ error: "Project workspace not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "project.workspace_deleted",
      entityType: "project",
      entityId: id,
      details: {
        workspaceId: workspace.id,
        name: workspace.name,
      },
    });

    res.json(workspace);
  });

  router.delete("/projects/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const project = await svc.remove(id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: project.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "project.deleted",
      entityType: "project",
      entityId: project.id,
    });

    res.json(project);
  });

  return router;
}
