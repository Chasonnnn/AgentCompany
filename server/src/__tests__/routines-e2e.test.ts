import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type DbModule = typeof import("@paperclipai/db");
type EmbeddedPostgresModule = typeof import("./helpers/embedded-postgres.js");
type RoutineRoutesModule = typeof import("../routes/routines.js");
type AccessServiceModule = typeof import("../services/access.js");
type RoutinesServiceModule = typeof import("../services/routines.js");
type ActivityLogModule = typeof import("../services/activity-log.js");

type TestRuntime = {
  dbModule: DbModule;
  routineRoutes: RoutineRoutesModule["routineRoutes"];
  accessService: AccessServiceModule["accessService"];
  routineService: RoutinesServiceModule["routineService"];
  logActivity: ActivityLogModule["logActivity"];
};

function resetRoutineRouteModules() {
  vi.doUnmock("../routes/routines.js");
  vi.doUnmock("../routes/authz.js");
  vi.doUnmock("../services/index.js");
  vi.doUnmock("../services/access.js");
  vi.doUnmock("../services/routines.js");
  vi.doUnmock("../services/activity-log.js");
  vi.doUnmock("../middleware/validate.js");
  vi.doUnmock("../telemetry.js");
  vi.doUnmock("@paperclipai/shared/telemetry");
}

async function wakeQueuedRunForIssue(
  db: ReturnType<DbModule["createDb"]>,
  dbModule: DbModule,
  agentId: string,
  wakeupOpts: any,
) {
  const issueId =
    (typeof wakeupOpts?.payload?.issueId === "string" && wakeupOpts.payload.issueId) ||
    (typeof wakeupOpts?.contextSnapshot?.issueId === "string" && wakeupOpts.contextSnapshot.issueId) ||
    null;
  if (!issueId) return null;

  const issue = await db
    .select({ companyId: dbModule.issues.companyId })
    .from(dbModule.issues)
    .where(eq(dbModule.issues.id, issueId))
    .then((rows: Array<{ companyId: string }>) => rows[0] ?? null);
  if (!issue) return null;

  const queuedRunId = randomUUID();
  await db.insert(dbModule.heartbeatRuns).values({
    id: queuedRunId,
    companyId: issue.companyId,
    agentId,
    invocationSource: wakeupOpts?.source ?? "assignment",
    triggerDetail: wakeupOpts?.triggerDetail ?? null,
    status: "queued",
    contextSnapshot: { ...(wakeupOpts?.contextSnapshot ?? {}), issueId },
  });
  await db
    .update(dbModule.issues)
    .set({
      executionRunId: queuedRunId,
      executionLockedAt: new Date(),
    })
    .where(eq(dbModule.issues.id, issueId));
  return { id: queuedRunId };
}

const embeddedPostgresSupport = await (
  await import("./helpers/embedded-postgres.js")
).getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres routine route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("routine routes end-to-end", () => {
  let db!: ReturnType<DbModule["createDb"]>;
  let runtime!: TestRuntime;
  let tempDb: Awaited<ReturnType<EmbeddedPostgresModule["startEmbeddedPostgresTestDatabase"]>> | null = null;

  beforeAll(async () => {
    const { startEmbeddedPostgresTestDatabase } = await vi.importActual<EmbeddedPostgresModule>(
      "./helpers/embedded-postgres.js",
    );
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-routines-e2e-");
  }, 20_000);

  beforeEach(async () => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    resetRoutineRouteModules();

    const [
      dbModule,
      { routineRoutes },
      accessModule,
      routinesModule,
      activityLogModule,
    ] = await Promise.all([
      vi.importActual<DbModule>("@paperclipai/db"),
      vi.importActual<RoutineRoutesModule>("../routes/routines.js"),
      vi.importActual<AccessServiceModule>("../services/access.js"),
      vi.importActual<RoutinesServiceModule>("../services/routines.js"),
      vi.importActual<ActivityLogModule>("../services/activity-log.js"),
    ]);

    runtime = {
      dbModule,
      routineRoutes,
      accessService: accessModule.accessService,
      routineService: routinesModule.routineService,
      logActivity: activityLogModule.logActivity,
    };
    db = dbModule.createDb(tempDb!.connectionString);
  });

  afterEach(async () => {
    await db.delete(runtime.dbModule.activityLog);
    await db.delete(runtime.dbModule.routineRuns);
    await db.delete(runtime.dbModule.routineTriggers);
    await db.delete(runtime.dbModule.heartbeatRunEvents);
    await db.delete(runtime.dbModule.heartbeatRuns);
    await db.delete(runtime.dbModule.agentRuntimeState);
    await db.delete(runtime.dbModule.agentWakeupRequests);
    await db.delete(runtime.dbModule.issues);
    await db.delete(runtime.dbModule.executionWorkspaces);
    await db.delete(runtime.dbModule.projectWorkspaces);
    await db.delete(runtime.dbModule.principalPermissionGrants);
    await db.delete(runtime.dbModule.companyMemberships);
    await db.delete(runtime.dbModule.routines);
    await db.delete(runtime.dbModule.companySkills);
    await db.delete(runtime.dbModule.projects);
    await db.delete(runtime.dbModule.agents);
    await db.delete(runtime.dbModule.companySkills);
    await db.delete(runtime.dbModule.companies);
    await db.delete(runtime.dbModule.instanceSettings);
    vi.restoreAllMocks();
    vi.clearAllMocks();
    resetRoutineRouteModules();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createApp(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = { ...actor };
      next();
    });
    app.use(
      "/api",
      runtime.routineRoutes(db, {
        accessService: runtime.accessService(db),
        logActivity: runtime.logActivity,
        routineService: runtime.routineService(db, {
          heartbeat: {
            wakeup: async (agentId: string, wakeupOpts: any) =>
              wakeQueuedRunForIssue(db, runtime.dbModule, agentId, wakeupOpts),
          },
        }),
        getTelemetryClient: () => null,
        trackRoutineCreated: () => {},
      }),
    );
    app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(err?.status ?? 500).json({ error: err?.message ?? "Internal server error" });
    });
    return app;
  }

  async function seedFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const userId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(runtime.dbModule.companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(runtime.dbModule.agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(runtime.dbModule.projects).values({
      id: projectId,
      companyId,
      name: "Routine Project",
      status: "in_progress",
    });

    const access = runtime.accessService(db);
    const membership = await access.ensureMembership(companyId, "user", userId, "owner", "active");
    await access.setMemberPermissions(
      companyId,
      membership.id,
      [{ permissionKey: "tasks:assign" }],
      userId,
    );

    return { companyId, agentId, projectId, userId };
  }

  it("supports creating, scheduling, and manually running a routine through the API", async () => {
    const { companyId, agentId, projectId, userId } = await seedFixture();
    const app = await createApp({
      type: "board",
      userId,
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const createRes = await request(app)
      .post(`/api/companies/${companyId}/routines`)
      .send({
        projectId,
        title: "Daily standup prep",
        description: "Summarize blockers and open PRs",
        assigneeAgentId: agentId,
        priority: "high",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      });

    expect([200, 201], JSON.stringify(createRes.body)).toContain(createRes.status);
    expect(createRes.body.title).toBe("Daily standup prep");
    expect(createRes.body.assigneeAgentId).toBe(agentId);

    const routineId = createRes.body.id as string;

    const triggerRes = await request(app)
      .post(`/api/routines/${routineId}/triggers`)
      .send({
        kind: "schedule",
        label: "Weekday morning",
        cronExpression: "0 10 * * 1-5",
        timezone: "UTC",
      });

    expect([200, 201], JSON.stringify(triggerRes.body)).toContain(triggerRes.status);
    expect(triggerRes.body.trigger.kind).toBe("schedule");
    expect(triggerRes.body.trigger.enabled).toBe(true);
    expect(triggerRes.body.secretMaterial).toBeNull();

    const runRes = await request(app)
      .post(`/api/routines/${routineId}/run`)
      .send({
        source: "manual",
        payload: { origin: "e2e-test" },
      });

    expect([200, 202], JSON.stringify(runRes.body)).toContain(runRes.status);
    const responseRunId = typeof runRes.body.id === "string" ? runRes.body.id : null;
    const responseRunStatus = typeof runRes.body.status === "string" ? runRes.body.status : null;
    const responseRunSource = typeof runRes.body.source === "string" ? runRes.body.source : null;
    const responseLinkedIssueId = typeof runRes.body.linkedIssueId === "string" ? runRes.body.linkedIssueId : null;

    const listRes = await request(app).get(`/api/companies/${companyId}/routines`);
    expect(listRes.status).toBe(200);
    const listed = listRes.body.find((routine: { id: string }) => routine.id === routineId);
    expect(listed).toBeDefined();
    expect(listed.triggers).toHaveLength(1);
    expect(listed.triggers[0].cronExpression).toBe("0 10 * * 1-5");
    expect(listed.triggers[0].timezone).toBe("UTC");

    const detailRes = await request(app).get(`/api/routines/${routineId}`);
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.triggers).toHaveLength(1);
    expect(detailRes.body.triggers[0]?.id).toBe(triggerRes.body.trigger.id);
    expect(detailRes.body.recentRuns).toHaveLength(1);
    const detailRun = detailRes.body.recentRuns[0] ?? null;
    const persistedRunId = responseRunId ?? detailRun?.id ?? null;
    const persistedRunStatus = responseRunStatus ?? detailRun?.status ?? null;
    const persistedRunSource = responseRunSource ?? detailRun?.source ?? null;
    const persistedLinkedIssueId =
      responseLinkedIssueId ?? detailRun?.linkedIssueId ?? detailRes.body.activeIssue?.id ?? null;
    expect(persistedRunId).toBeTruthy();
    expect(persistedRunStatus).toBe("issue_created");
    expect(persistedRunSource).toBe("manual");
    expect(detailRun?.id).toBe(persistedRunId);
    expect(detailRes.body.activeIssue?.id).toBe(persistedLinkedIssueId);

    const runsRes = await request(app).get(`/api/routines/${routineId}/runs?limit=10`);
    expect(runsRes.status).toBe(200);
    expect(runsRes.body).toHaveLength(1);
    expect(runsRes.body[0]?.id).toBe(persistedRunId);

    const [issue] = await db
      .select({
        id: runtime.dbModule.issues.id,
        originId: runtime.dbModule.issues.originId,
        originKind: runtime.dbModule.issues.originKind,
        executionRunId: runtime.dbModule.issues.executionRunId,
      })
      .from(runtime.dbModule.issues)
      .where(eq(runtime.dbModule.issues.id, persistedLinkedIssueId!));

    expect(issue).toMatchObject({
      id: persistedLinkedIssueId,
      originId: routineId,
      originKind: "routine_execution",
    });
    expect(issue?.executionRunId).toBeTruthy();

    const actions = await db
      .select({
        action: runtime.dbModule.activityLog.action,
      })
      .from(runtime.dbModule.activityLog)
      .where(eq(runtime.dbModule.activityLog.companyId, companyId));

    expect(actions.map((entry) => entry.action)).toEqual(
      expect.arrayContaining([
        "routine.created",
        "routine.trigger_created",
        "routine.run_triggered",
      ]),
    );
  }, 15_000);

  it("runs routines with variable inputs and interpolates the execution issue description", async () => {
    const { companyId, agentId, projectId, userId } = await seedFixture();
    const app = await createApp({
      type: "board",
      userId,
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const createRes = await request(app)
      .post(`/api/companies/${companyId}/routines`)
      .send({
        projectId,
        title: "Repository triage",
        description: "Review {{repo}} for {{priority}} bugs",
        assigneeAgentId: agentId,
        variables: [
          { name: "repo", type: "text", required: true },
          { name: "priority", type: "select", required: true, defaultValue: "high", options: ["high", "low"] },
        ],
      });

    expect([200, 201], JSON.stringify(createRes.body)).toContain(createRes.status);

    const runRes = await request(app)
      .post(`/api/routines/${createRes.body.id}/run`)
      .send({
        source: "manual",
        variables: { repo: "paperclip" },
      });

    expect([200, 202], JSON.stringify(runRes.body)).toContain(runRes.status);
    expect(runRes.body.triggerPayload).toEqual({
      variables: {
        repo: "paperclip",
        priority: "high",
      },
    });
    const responseLinkedIssueId = typeof runRes.body.linkedIssueId === "string" ? runRes.body.linkedIssueId : null;
    const detailRes = await request(app).get(`/api/routines/${createRes.body.id}`);
    expect(detailRes.status).toBe(200);
    const linkedIssueId =
      responseLinkedIssueId ?? detailRes.body.activeIssue?.id ?? detailRes.body.recentRuns[0]?.linkedIssueId;
    expect(linkedIssueId).toBeTruthy();

    const [issue] = await db
      .select({ description: runtime.dbModule.issues.description })
      .from(runtime.dbModule.issues)
      .where(eq(runtime.dbModule.issues.id, linkedIssueId!));

    expect(issue?.description).toBe("Review paperclip for high bugs");
  });

  it("allows drafting a routine without defaults and running it with one-off overrides", async () => {
    const { companyId, agentId, projectId, userId } = await seedFixture();
    const app = await createApp({
      type: "board",
      userId,
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const createRes = await request(app)
      .post(`/api/companies/${companyId}/routines`)
      .send({
        title: "Draft routine",
        description: "No saved defaults",
      });

    expect([200, 201], JSON.stringify(createRes.body)).toContain(createRes.status);
    expect(createRes.body.projectId).toBeNull();
    expect(createRes.body.assigneeAgentId).toBeNull();
    expect(createRes.body.status).toBe("paused");

    const runRes = await request(app)
      .post(`/api/routines/${createRes.body.id}/run`)
      .send({
        source: "manual",
        projectId,
        assigneeAgentId: agentId,
      });

    expect([200, 202], JSON.stringify(runRes.body)).toContain(runRes.status);
    const responseLinkedIssueId = typeof runRes.body.linkedIssueId === "string" ? runRes.body.linkedIssueId : null;
    const detailRes = await request(app).get(`/api/routines/${createRes.body.id}`);
    expect(detailRes.status).toBe(200);
    const linkedIssueId =
      responseLinkedIssueId ?? detailRes.body.activeIssue?.id ?? detailRes.body.recentRuns[0]?.linkedIssueId;
    expect(linkedIssueId).toBeTruthy();

    const [issue] = await db
      .select({
        projectId: runtime.dbModule.issues.projectId,
        assigneeAgentId: runtime.dbModule.issues.assigneeAgentId,
      })
      .from(runtime.dbModule.issues)
      .where(eq(runtime.dbModule.issues.id, linkedIssueId!));

    expect(issue).toEqual({
      projectId,
      assigneeAgentId: agentId,
    });
  });

  it("persists execution workspace selections from manual routine runs", async () => {
    const { companyId, agentId, projectId, userId } = await seedFixture();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const app = await createApp({
      type: "board",
      userId,
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    await db.insert(runtime.dbModule.projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
      isPrimary: true,
      sharedWorkspaceKey: "routine-primary",
    });
    await db.insert(runtime.dbModule.executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Routine worktree",
      status: "active",
      providerType: "git_worktree",
    });
    await db
      .update(runtime.dbModule.projects)
      .set({
        executionWorkspacePolicy: {
          enabled: true,
          defaultMode: "shared_workspace",
          defaultProjectWorkspaceId: projectWorkspaceId,
        },
      })
      .where(eq(runtime.dbModule.projects.id, projectId));
    await db.insert(runtime.dbModule.instanceSettings).values({
      experimental: { enableIsolatedWorkspaces: true },
    });

    const createRes = await request(app)
      .post(`/api/companies/${companyId}/routines`)
      .send({
        projectId,
        title: "Workspace-aware routine",
        assigneeAgentId: agentId,
      });

    expect([200, 201], JSON.stringify(createRes.body)).toContain(createRes.status);

    const runRes = await request(app)
      .post(`/api/routines/${createRes.body.id}/run`)
      .send({
        source: "manual",
        executionWorkspaceId,
        executionWorkspacePreference: "reuse_existing",
        executionWorkspaceSettings: { mode: "isolated_workspace" },
      });

    expect([200, 202], JSON.stringify(runRes.body)).toContain(runRes.status);
    const responseLinkedIssueId = typeof runRes.body.linkedIssueId === "string" ? runRes.body.linkedIssueId : null;
    const detailRes = await request(app).get(`/api/routines/${createRes.body.id}`);
    expect(detailRes.status).toBe(200);
    const linkedIssueId =
      responseLinkedIssueId ?? detailRes.body.activeIssue?.id ?? detailRes.body.recentRuns[0]?.linkedIssueId;
    expect(linkedIssueId).toBeTruthy();

    const [issue] = await db
      .select({
        projectWorkspaceId: runtime.dbModule.issues.projectWorkspaceId,
        executionWorkspaceId: runtime.dbModule.issues.executionWorkspaceId,
        executionWorkspacePreference: runtime.dbModule.issues.executionWorkspacePreference,
        executionWorkspaceSettings: runtime.dbModule.issues.executionWorkspaceSettings,
      })
      .from(runtime.dbModule.issues)
      .where(eq(runtime.dbModule.issues.id, linkedIssueId!));

    expect(issue).toEqual({
      projectWorkspaceId,
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    });
  });
});
