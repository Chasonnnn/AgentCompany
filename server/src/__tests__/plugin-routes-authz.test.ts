import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockServices = vi.hoisted(() => {
  const registry = {
    calls: {
      getById: [] as unknown[][],
      getByKey: [] as unknown[][],
      upsertConfig: [] as unknown[][],
    },
    results: {
      getById: undefined as unknown,
      getByKey: undefined as unknown,
      upsertConfig: undefined as unknown,
    },
    reset() {
      this.calls.getById.length = 0;
      this.calls.getByKey.length = 0;
      this.calls.upsertConfig.length = 0;
      this.results.getById = undefined;
      this.results.getByKey = undefined;
      this.results.upsertConfig = undefined;
    },
    async getById(...args: unknown[]) {
      registry.calls.getById.push(args);
      return registry.results.getById;
    },
    async getByKey(...args: unknown[]) {
      registry.calls.getByKey.push(args);
      return registry.results.getByKey;
    },
    async upsertConfig(...args: unknown[]) {
      registry.calls.upsertConfig.push(args);
      return registry.results.upsertConfig;
    },
  };

  const lifecycle = {
    calls: {
      load: [] as unknown[][],
      upgrade: [] as unknown[][],
      unload: [] as unknown[][],
      enable: [] as unknown[][],
      disable: [] as unknown[][],
    },
    results: {
      load: undefined as unknown,
      upgrade: undefined as unknown,
      unload: undefined as unknown,
      enable: undefined as unknown,
      disable: undefined as unknown,
    },
    reset() {
      this.calls.load.length = 0;
      this.calls.upgrade.length = 0;
      this.calls.unload.length = 0;
      this.calls.enable.length = 0;
      this.calls.disable.length = 0;
      this.results.load = undefined;
      this.results.upgrade = undefined;
      this.results.unload = undefined;
      this.results.enable = undefined;
      this.results.disable = undefined;
    },
    async load(...args: unknown[]) {
      lifecycle.calls.load.push(args);
      return lifecycle.results.load;
    },
    async upgrade(...args: unknown[]) {
      lifecycle.calls.upgrade.push(args);
      return lifecycle.results.upgrade;
    },
    async unload(...args: unknown[]) {
      lifecycle.calls.unload.push(args);
      return lifecycle.results.unload;
    },
    async enable(...args: unknown[]) {
      lifecycle.calls.enable.push(args);
      return lifecycle.results.enable;
    },
    async disable(...args: unknown[]) {
      lifecycle.calls.disable.push(args);
      return lifecycle.results.disable;
    },
  };

  const activityLog = {
    calls: [] as unknown[][],
    reset() {
      this.calls.length = 0;
    },
    async log(...args: unknown[]) {
      activityLog.calls.push(args);
    },
  };

  const liveEvents = {
    calls: [] as unknown[][],
    reset() {
      this.calls.length = 0;
    },
    publish(...args: unknown[]) {
      liveEvents.calls.push(args);
    },
  };

  return { registry, lifecycle, activityLog, liveEvents };
});

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockServices.registry,
}));

vi.mock("../services/plugin-lifecycle.js", () => ({
  pluginLifecycleManager: () => mockServices.lifecycle,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: (...args: unknown[]) => mockServices.activityLog.log(...args),
}));

vi.mock("../services/live-events.js", () => ({
  publishGlobalLiveEvent: (...args: unknown[]) => mockServices.liveEvents.publish(...args),
}));

function resetPluginRouteMocks() {
  mockServices.registry.reset();
  mockServices.lifecycle.reset();
  mockServices.activityLog.reset();
  mockServices.liveEvents.reset();
}

function createAsyncRecorder<TArgs extends unknown[], TResult>(
  impl: (...args: TArgs) => Promise<TResult> | TResult,
) {
  const calls: TArgs[] = [];
  return {
    calls,
    fn: async (...args: TArgs): Promise<TResult> => {
      calls.push(args);
      return await impl(...args);
    },
  };
}

function createRecorder<TArgs extends unknown[], TResult>(
  impl: (...args: TArgs) => TResult,
) {
  const calls: TArgs[] = [];
  return {
    calls,
    fn: (...args: TArgs): TResult => {
      calls.push(args);
      return impl(...args);
    },
  };
}

async function createApp(
  actor: Record<string, unknown>,
  loaderOverrides: Record<string, unknown> = {},
  routeOverrides: {
    db?: unknown;
    jobDeps?: unknown;
    toolDeps?: unknown;
    bridgeDeps?: unknown;
  } = {},
) {
  vi.doUnmock("../routes/plugins.js");
  vi.doUnmock("../middleware/index.js");
  vi.doUnmock("../routes/authz.js");
  vi.doUnmock("../middleware/validate.js");
  const [{ pluginRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/plugins.js")>("../routes/plugins.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);

  const defaultInstallPlugin = createAsyncRecorder(async () => undefined);
  const loader = {
    installPlugin: defaultInstallPlugin.fn,
    ...loaderOverrides,
  };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = { ...actor } as typeof req.actor;
    next();
  });
  app.use("/api", pluginRoutes(
    (routeOverrides.db ?? {}) as never,
    loader as never,
    routeOverrides.jobDeps as never,
    undefined,
    routeOverrides.toolDeps as never,
    routeOverrides.bridgeDeps as never,
  ));
  app.use(errorHandler);

  return { app, loader, installPluginCalls: defaultInstallPlugin.calls };
}

function createSelectQueueDb(rows: Array<Array<Record<string, unknown>>>) {
  let callIndex = 0;
  return {
    select: () => {
      const responseRows = rows[callIndex] ?? [];
      callIndex += 1;
      return {
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve(responseRows),
          }),
        }),
      };
    },
  };
}

const companyA = "22222222-2222-4222-8222-222222222222";
const companyB = "33333333-3333-4333-8333-333333333333";
const agentA = "44444444-4444-4444-8444-444444444444";
const runA = "55555555-5555-4555-8555-555555555555";
const projectA = "66666666-6666-4666-8666-666666666666";
const pluginId = "11111111-1111-4111-8111-111111111111";

function boardActor(overrides: Record<string, unknown> = {}) {
  return {
    type: "board",
    userId: "user-1",
    source: "session",
    isInstanceAdmin: false,
    companyIds: [companyA],
    ...overrides,
  };
}

function readyPlugin() {
  mockServices.registry.results.getById = {
    id: pluginId,
    pluginKey: "paperclip.example",
    version: "1.0.0",
    status: "ready",
  };
}

describe("plugin install and upgrade authz", () => {
  beforeEach(() => {
    resetPluginRouteMocks();
    vi.resetModules();
    vi.doUnmock("../routes/plugins.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/validate.js");
  });

  it("rejects plugin installation for non-admin board users", async () => {
    const { app, installPluginCalls } = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });

    const res = await request(app)
      .post("/api/plugins/install")
      .send({ packageName: "paperclip-plugin-example" });

    expect(res.status).toBe(403);
    expect(installPluginCalls).toHaveLength(0);
  }, 20_000);

  it("allows instance admins to install plugins", async () => {
    const discovered = {
      manifest: {
        id: "paperclip.example",
      },
    };
    const installPlugin = createAsyncRecorder(async () => discovered);

    mockServices.registry.results.getByKey = {
      id: pluginId,
      pluginKey: "paperclip.example",
      packageName: "paperclip-plugin-example",
      version: "1.0.0",
    };
    mockServices.registry.results.getById = {
      id: pluginId,
      pluginKey: "paperclip.example",
      packageName: "paperclip-plugin-example",
      version: "1.0.0",
    };
    mockServices.lifecycle.results.load = undefined;

    const { app } = await createApp(
      {
        type: "board",
        userId: "admin-1",
        source: "session",
        isInstanceAdmin: true,
        companyIds: [],
      },
      { installPlugin: installPlugin.fn },
    );

    const res = await request(app)
      .post("/api/plugins/install")
      .send({ packageName: "paperclip-plugin-example" });

    expect(res.status).toBe(200);
    expect(installPlugin.calls).toEqual([
      [{
        packageName: "paperclip-plugin-example",
        version: undefined,
      }],
    ]);
    expect(mockServices.lifecycle.calls.load).toEqual([[pluginId]]);
  }, 20_000);

  it("rejects plugin upgrades for non-admin board users", async () => {
    const { app } = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/upgrade`)
      .send({});

    expect(res.status).toBe(403);
    expect(mockServices.registry.calls.getById).toHaveLength(0);
    expect(mockServices.lifecycle.calls.upgrade).toHaveLength(0);
  }, 20_000);

  it.each([
    ["delete", "delete", `/api/plugins/${pluginId}`, undefined],
    ["enable", "post", `/api/plugins/${pluginId}/enable`, {}],
    ["disable", "post", `/api/plugins/${pluginId}/disable`, {}],
    ["config", "post", `/api/plugins/${pluginId}/config`, { configJson: {} }],
  ] as const)("rejects plugin %s for non-admin board users", async (_name, method, path, body) => {
    const { app } = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });

    const req = method === "delete" ? request(app).delete(path) : request(app).post(path).send(body);
    const res = await req;

    expect(res.status).toBe(403);
    expect(mockServices.registry.calls.getById).toHaveLength(0);
    expect(mockServices.registry.calls.upsertConfig).toHaveLength(0);
    expect(mockServices.lifecycle.calls.unload).toHaveLength(0);
    expect(mockServices.lifecycle.calls.enable).toHaveLength(0);
    expect(mockServices.lifecycle.calls.disable).toHaveLength(0);
  }, 20_000);

  it("allows instance admins to upgrade plugins", async () => {
    mockServices.registry.results.getById = {
      id: pluginId,
      pluginKey: "paperclip.example",
      version: "1.0.0",
    };
    mockServices.lifecycle.results.upgrade = {
      id: pluginId,
      version: "1.1.0",
    };

    const { app } = await createApp({
      type: "board",
      userId: "admin-1",
      source: "session",
      isInstanceAdmin: true,
      companyIds: [],
    });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/upgrade`)
      .send({ version: "1.1.0" });

    expect(res.status).toBe(200);
    expect(mockServices.lifecycle.calls.upgrade).toEqual([[pluginId, "1.1.0"]]);
  }, 20_000);
});

describe("scoped plugin API routes", () => {
  beforeEach(() => {
    resetPluginRouteMocks();
    vi.resetModules();
    vi.doUnmock("../routes/plugins.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/validate.js");
  });

  it("dispatches manifest-declared scoped routes after company access checks", async () => {
    const call = createAsyncRecorder(async () => ({
        status: 202,
        body: { ok: true },
      }));
    const workerManager = {
      call: call.fn,
    };
    mockServices.registry.results.getById = null;
    mockServices.registry.results.getByKey = {
      id: pluginId,
      pluginKey: "paperclip.example",
      version: "1.0.0",
      status: "ready",
      manifestJson: {
        id: "paperclip.example",
        capabilities: ["api.routes.register"],
        apiRoutes: [
          {
            routeKey: "smoke",
            method: "GET",
            path: "/smoke",
            auth: "board-or-agent",
            capability: "api.routes.register",
            companyResolution: { from: "query", key: "companyId" },
          },
        ],
      },
    };

    const { app } = await createApp(
      {
        type: "board",
        userId: "admin-1",
        source: "session",
        isInstanceAdmin: false,
        companyIds: ["company-1"],
      },
      {},
      { bridgeDeps: { workerManager } },
    );

    const res = await request(app)
      .get("/api/plugins/paperclip.example/api/smoke")
      .query({ companyId: "company-1" });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ok: true });
    expect(call.calls).toHaveLength(1);
    expect(call.calls[0]?.[0]).toBe(pluginId);
    expect(call.calls[0]?.[1]).toBe("handleApiRequest");
    expect(call.calls[0]?.[2]).toMatchObject({
      routeKey: "smoke",
      method: "GET",
      companyId: "company-1",
      query: { companyId: "company-1" },
    });
  }, 20_000);
});

describe("plugin tool and bridge authz", () => {
  beforeEach(() => {
    resetPluginRouteMocks();
    vi.resetModules();
    vi.doUnmock("../routes/plugins.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/validate.js");
  });

  it("rejects tool execution when the board user cannot access runContext.companyId", async () => {
    const executeTool = createAsyncRecorder(async () => undefined);
    const getTool = createRecorder(() => undefined);
    const { app } = await createApp(boardActor(), {}, {
      toolDeps: {
        toolDispatcher: {
          listToolsForAgent: createAsyncRecorder(async () => []).fn,
          getTool: getTool.fn,
          executeTool: executeTool.fn,
        },
      },
    });

    const res = await request(app)
      .post("/api/plugins/tools/execute")
      .send({
        tool: "paperclip.example:search",
        parameters: {},
        runContext: {
          agentId: agentA,
          runId: runA,
          companyId: companyB,
          projectId: projectA,
        },
      });

    expect(res.status).toBe(403);
    expect(getTool.calls).toHaveLength(0);
    expect(executeTool.calls).toHaveLength(0);
  });

  it.each([
    ["agentId", [[{ companyId: companyB }]]],
    [
      "runId company",
      [
        [{ companyId: companyA }],
        [{ companyId: companyB, agentId: agentA }],
      ],
    ],
    [
      "runId agent",
      [
        [{ companyId: companyA }],
        [{ companyId: companyA, agentId: "77777777-7777-4777-8777-777777777777" }],
      ],
    ],
    [
      "projectId",
      [
        [{ companyId: companyA }],
        [{ companyId: companyA, agentId: agentA }],
        [{ companyId: companyB }],
      ],
    ],
  ])("rejects tool execution when runContext.%s is outside the company scope", async (_case, rows) => {
    const executeTool = createAsyncRecorder(async () => undefined);
    const { app } = await createApp(boardActor(), {}, {
      db: createSelectQueueDb(rows),
      toolDeps: {
        toolDispatcher: {
          listToolsForAgent: createAsyncRecorder(async () => []).fn,
          getTool: createRecorder(() => ({ name: "paperclip.example:search" })).fn,
          executeTool: executeTool.fn,
        },
      },
    });

    const res = await request(app)
      .post("/api/plugins/tools/execute")
      .send({
        tool: "paperclip.example:search",
        parameters: {},
        runContext: {
          agentId: agentA,
          runId: runA,
          companyId: companyA,
          projectId: projectA,
        },
      });

    expect(res.status).toBe(403);
    expect(executeTool.calls).toHaveLength(0);
  });

  it("allows tool execution when agent, run, and project all belong to runContext.companyId", async () => {
    const executeTool = createAsyncRecorder(async () => ({ content: "ok" }));
    const { app } = await createApp(boardActor(), {}, {
      db: createSelectQueueDb([
        [{ companyId: companyA }],
        [{ companyId: companyA, agentId: agentA }],
        [{ companyId: companyA }],
      ]),
      toolDeps: {
        toolDispatcher: {
          listToolsForAgent: createAsyncRecorder(async () => []).fn,
          getTool: createRecorder(() => ({ name: "paperclip.example:search" })).fn,
          executeTool: executeTool.fn,
        },
      },
    });

    const res = await request(app)
      .post("/api/plugins/tools/execute")
      .send({
        tool: "paperclip.example:search",
        parameters: { q: "test" },
        runContext: {
          agentId: agentA,
          runId: runA,
          companyId: companyA,
          projectId: projectA,
        },
      });

    expect(res.status).toBe(200);
    expect(executeTool.calls).toEqual([
      [
        "paperclip.example:search",
        { q: "test" },
        {
          agentId: agentA,
          runId: runA,
          companyId: companyA,
          projectId: projectA,
        },
      ],
    ]);
  });

  it.each([
    ["legacy data", "post", `/api/plugins/${pluginId}/bridge/data`, { key: "health" }],
    ["legacy action", "post", `/api/plugins/${pluginId}/bridge/action`, { key: "sync" }],
    ["url data", "post", `/api/plugins/${pluginId}/data/health`, {}],
    ["url action", "post", `/api/plugins/${pluginId}/actions/sync`, {}],
  ] as const)("rejects %s bridge calls without companyId for non-admin users", async (_name, _method, path, body) => {
    readyPlugin();
    const call = createAsyncRecorder(async () => undefined);
    const { app } = await createApp(boardActor(), {}, {
      bridgeDeps: {
        workerManager: { call: call.fn },
      },
    });

    const res = await request(app)
      .post(path)
      .send(body);

    expect(res.status).toBe(403);
    expect(call.calls).toHaveLength(0);
  });

  it("allows omitted-company bridge calls for instance admins as global plugin actions", async () => {
    readyPlugin();
    const call = createAsyncRecorder(async () => ({ ok: true }));
    const { app } = await createApp(boardActor({
      userId: "admin-1",
      isInstanceAdmin: true,
      companyIds: [],
    }), {}, {
      bridgeDeps: {
        workerManager: { call: call.fn },
      },
    });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/actions/sync`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { ok: true } });
    expect(call.calls).toEqual([[
      pluginId,
      "performAction",
      {
        key: "sync",
        params: {},
        renderEnvironment: null,
      },
    ]]);
  });

  it("rejects manual job triggers for non-admin board users", async () => {
    const scheduler = { triggerJob: createAsyncRecorder(async () => undefined) };
    const jobStore = { getJobByIdForPlugin: createAsyncRecorder(async () => undefined) };
    const { app } = await createApp(boardActor(), {}, {
      jobDeps: { scheduler, jobStore },
    });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/jobs/job-1/trigger`)
      .send({});

    expect(res.status).toBe(403);
    expect(scheduler.triggerJob.calls).toHaveLength(0);
    expect(jobStore.getJobByIdForPlugin.calls).toHaveLength(0);
  });
});
