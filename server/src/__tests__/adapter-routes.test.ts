import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerAdapterModule } from "../adapters/types.js";

const mocks = vi.hoisted(() => ({
  listAdapterPlugins: vi.fn(() => []),
  addAdapterPlugin: vi.fn(),
  removeAdapterPlugin: vi.fn(),
  getAdapterPluginByType: vi.fn(),
  getAdapterPluginsDir: vi.fn(() => "/tmp/paperclip-adapter-route-test"),
  getDisabledAdapterTypes: vi.fn(() => []),
  setAdapterDisabled: vi.fn(),
  loadExternalAdapterPackage: vi.fn(),
  buildExternalAdapters: vi.fn(async () => []),
  reloadExternalAdapter: vi.fn(),
  getUiParserSource: vi.fn(),
  getOrExtractUiParserSource: vi.fn(),
}));

vi.mock("../services/adapter-plugin-store.js", () => ({
  listAdapterPlugins: mocks.listAdapterPlugins,
  addAdapterPlugin: mocks.addAdapterPlugin,
  removeAdapterPlugin: mocks.removeAdapterPlugin,
  getAdapterPluginByType: mocks.getAdapterPluginByType,
  getAdapterPluginsDir: mocks.getAdapterPluginsDir,
  getDisabledAdapterTypes: mocks.getDisabledAdapterTypes,
  setAdapterDisabled: mocks.setAdapterDisabled,
}));

vi.mock("../adapters/plugin-loader.js", () => ({
  loadExternalAdapterPackage: mocks.loadExternalAdapterPackage,
  buildExternalAdapters: mocks.buildExternalAdapters,
  reloadExternalAdapter: mocks.reloadExternalAdapter,
  getUiParserSource: mocks.getUiParserSource,
  getOrExtractUiParserSource: mocks.getOrExtractUiParserSource,
}));

const overridingConfigSchemaAdapter: ServerAdapterModule = {
  type: "claude_local",
  execute: async () => ({ exitCode: 0, signal: null, timedOut: false }),
  testEnvironment: async () => ({
    adapterType: "claude_local",
    status: "pass",
    checks: [],
    testedAt: new Date(0).toISOString(),
  }),
  getConfigSchema: async () => ({
    version: 1,
    fields: [
      {
        key: "mode",
        type: "text",
        label: "Mode",
      },
    ],
  }),
};

let registerServerAdapter: typeof import("../adapters/registry.js").registerServerAdapter;
let resetServerAdaptersForTests: typeof import("../adapters/registry.js").resetServerAdaptersForTests;
let unregisterServerAdapter: typeof import("../adapters/registry.js").unregisterServerAdapter;
let setOverridePaused: typeof import("../adapters/registry.js").setOverridePaused;
let waitForExternalAdapters: typeof import("../adapters/registry.js").waitForExternalAdapters;
let adapterRoutes: typeof import("../routes/adapters.js").adapterRoutes;
let errorHandler: typeof import("../middleware/index.js").errorHandler;

function readAdapterList(res: { body: unknown; text: string }) {
  if (Array.isArray(res.body)) return res.body as Array<Record<string, unknown>>;
  if (typeof res.text === "string" && res.text.trim().startsWith("[")) {
    return JSON.parse(res.text) as Array<Record<string, unknown>>;
  }
  throw new Error(`Expected adapter list response array, got: ${JSON.stringify(res.body)}`);
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: [],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", adapterRoutes());
  app.use(errorHandler);
  return app;
}

describe("adapter routes", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.doUnmock("../adapters/registry.js");
    vi.doUnmock("../routes/adapters.js");
    vi.doUnmock("../middleware/index.js");
    mocks.listAdapterPlugins.mockReturnValue([]);
    mocks.getDisabledAdapterTypes.mockReturnValue([]);
    mocks.buildExternalAdapters.mockResolvedValue([]);

    ({
      registerServerAdapter,
      resetServerAdaptersForTests,
      unregisterServerAdapter,
      setOverridePaused,
      waitForExternalAdapters,
    } = await vi.importActual<typeof import("../adapters/registry.js")>("../adapters/registry.js"));
    ({ adapterRoutes } = await vi.importActual<typeof import("../routes/adapters.js")>("../routes/adapters.js"));
    ({ errorHandler } = await vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"));

    await waitForExternalAdapters();
    resetServerAdaptersForTests();
    setOverridePaused("claude_local", false);
    registerServerAdapter(overridingConfigSchemaAdapter);
  });

  afterEach(() => {
    unregisterServerAdapter("claude_local");
    resetServerAdaptersForTests();
    vi.doUnmock("../adapters/registry.js");
    vi.doUnmock("../routes/adapters.js");
    vi.doUnmock("../middleware/index.js");
  });

  it("GET /api/adapters includes capabilities object for each adapter", async () => {
    const app = createApp();

    const res = await request(app).get("/api/adapters");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);

    // Every adapter should have a capabilities object
    for (const adapter of res.body) {
      expect(adapter.capabilities).toBeDefined();
      expect(typeof adapter.capabilities.supportsInstructionsBundle).toBe("boolean");
      expect(typeof adapter.capabilities.supportsSkills).toBe("boolean");
      expect(typeof adapter.capabilities.supportsLocalAgentJwt).toBe("boolean");
      expect(typeof adapter.capabilities.requiresMaterializedRuntimeSkills).toBe("boolean");
      expect(typeof adapter.capabilities.nativePlanningMode).toBe("boolean");
      expect(typeof adapter.capabilities.nativeDecisionQuestions).toBe("boolean");
    }
  });

  it("GET /api/adapters returns correct capabilities for built-in adapters", async () => {
    const app = createApp();

    const res = await request(app).get("/api/adapters");
    expect(res.status).toBe(200);
    const adapters = readAdapterList(res);

    // codex_local has instructions bundle + skills + jwt, no materialized skills
    // (claude_local is overridden by beforeEach, so check codex_local instead)
    const codexLocal = adapters.find((a: any) => a.type === "codex_local");
    expect(codexLocal).toBeDefined();
    expect(codexLocal.capabilities).toMatchObject({
      supportsInstructionsBundle: true,
      supportsSkills: true,
      supportsLocalAgentJwt: true,
      requiresMaterializedRuntimeSkills: false,
      nativePlanningMode: true,
      nativeDecisionQuestions: true,
    });

    // process adapter should have no local capabilities
    const processAdapter = adapters.find((a: any) => a.type === "process");
    expect(processAdapter).toBeDefined();
    expect(processAdapter.capabilities).toMatchObject({
      supportsInstructionsBundle: false,
      supportsSkills: false,
      supportsLocalAgentJwt: false,
      requiresMaterializedRuntimeSkills: false,
      nativePlanningMode: false,
      nativeDecisionQuestions: false,
    });

    // cursor adapter should require materialized runtime skills
    const cursorAdapter = adapters.find((a: any) => a.type === "cursor");
    expect(cursorAdapter).toBeDefined();
    expect(cursorAdapter.capabilities.requiresMaterializedRuntimeSkills).toBe(true);
    expect(cursorAdapter.capabilities.supportsInstructionsBundle).toBe(true);

    const geminiAdapter = adapters.find((a: any) => a.type === "gemini_local");
    expect(geminiAdapter).toBeDefined();
    expect(geminiAdapter.capabilities.nativeDecisionQuestions).toBe(true);
  });

  it("GET /api/adapters derives supportsSkills from listSkills/syncSkills presence", async () => {
    const app = createApp();

    const res = await request(app).get("/api/adapters");
    expect(res.status).toBe(200);
    const adapters = readAdapterList(res);

    // http adapter has no listSkills/syncSkills
    const httpAdapter = adapters.find((a: any) => a.type === "http");
    expect(httpAdapter).toBeDefined();
    expect(httpAdapter.capabilities.supportsSkills).toBe(false);

    // codex_local has listSkills/syncSkills
    const codexLocal = adapters.find((a: any) => a.type === "codex_local");
    expect(codexLocal).toBeDefined();
    expect(codexLocal.capabilities.supportsSkills).toBe(true);
  });

  it("uses the active adapter when resolving config schema for a paused builtin override", async () => {
    const app = createApp();

    const active = await request(app).get("/api/adapters/claude_local/config-schema");
    expect(active.status, JSON.stringify(active.body)).toBe(200);
    expect(active.body).toMatchObject({
      fields: [{ key: "mode" }],
    });

    const paused = await request(app)
      .patch("/api/adapters/claude_local/override")
      .send({ paused: true });
    expect(paused.status, JSON.stringify(paused.body)).toBe(200);

    const builtin = await request(app).get("/api/adapters/claude_local/config-schema");
    expect(builtin.status, JSON.stringify(builtin.body)).toBe(404);
    expect(String(builtin.body.error ?? "")).toContain("does not provide a config schema");
  });
});
