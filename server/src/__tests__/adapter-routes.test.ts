import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerAdapterModule } from "../adapters/types.js";

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

    ({
      registerServerAdapter,
      resetServerAdaptersForTests,
      unregisterServerAdapter,
      setOverridePaused,
      waitForExternalAdapters,
    } = await import("../adapters/registry.js"));
    ({ adapterRoutes } = await import("../routes/adapters.js"));
    ({ errorHandler } = await import("../middleware/index.js"));

    await waitForExternalAdapters();
    resetServerAdaptersForTests();
    setOverridePaused("claude_local", false);
    registerServerAdapter(overridingConfigSchemaAdapter);
  });

  afterEach(() => {
    unregisterServerAdapter("claude_local");
    resetServerAdaptersForTests();
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

    // codex_local has instructions bundle + skills + jwt, no materialized skills
    // (claude_local is overridden by beforeEach, so check codex_local instead)
    const codexLocal = res.body.find((a: any) => a.type === "codex_local");
    expect(codexLocal).toBeDefined();
    expect(codexLocal.capabilities).toMatchObject({
      supportsInstructionsBundle: true,
      supportsSkills: true,
      supportsLocalAgentJwt: true,
      requiresMaterializedRuntimeSkills: false,
      nativePlanningMode: false,
      nativeDecisionQuestions: false,
    });

    // process adapter should have no local capabilities
    const processAdapter = res.body.find((a: any) => a.type === "process");
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
    const cursorAdapter = res.body.find((a: any) => a.type === "cursor");
    expect(cursorAdapter).toBeDefined();
    expect(cursorAdapter.capabilities.requiresMaterializedRuntimeSkills).toBe(true);
    expect(cursorAdapter.capabilities.supportsInstructionsBundle).toBe(true);

    const geminiAdapter = res.body.find((a: any) => a.type === "gemini_local");
    expect(geminiAdapter).toBeDefined();
    expect(geminiAdapter.capabilities.nativeDecisionQuestions).toBe(true);
  });

  it("GET /api/adapters derives supportsSkills from listSkills/syncSkills presence", async () => {
    const app = createApp();

    const res = await request(app).get("/api/adapters");
    expect(res.status).toBe(200);

    // http adapter has no listSkills/syncSkills
    const httpAdapter = res.body.find((a: any) => a.type === "http");
    expect(httpAdapter).toBeDefined();
    expect(httpAdapter.capabilities.supportsSkills).toBe(false);

    // codex_local has listSkills/syncSkills
    const codexLocal = res.body.find((a: any) => a.type === "codex_local");
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
