import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function createHarness(actor: any) {
  vi.doUnmock("../routes/instance-settings.js");
  vi.doUnmock("../routes/authz.js");
  vi.doUnmock("../middleware/index.js");
  vi.doUnmock("../middleware/validate.js");
  vi.doUnmock("../services/index.js");

  const state = {
    general: {
      censorUsernameInLogs: false,
      keyboardShortcuts: false,
      feedbackDataSharingPreference: "prompt",
    },
    experimental: {
      enableIsolatedWorkspaces: false,
      autoRestartDevServerWhenIdle: false,
    },
    companyIds: ["company-1", "company-2"],
  };

  const calls = {
    getGeneral: [] as unknown[][],
    getExperimental: [] as unknown[][],
    updateGeneral: [] as unknown[][],
    updateExperimental: [] as unknown[][],
    listCompanyIds: [] as unknown[][],
    logActivity: [] as unknown[][],
  };

  const [{ errorHandler }, { instanceSettingsRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/instance-settings.js")>("../routes/instance-settings.js"),
  ]);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", instanceSettingsRoutes({} as any, {
    instanceSettingsService: {
      getGeneral: async (...args: unknown[]) => {
        calls.getGeneral.push(args);
        return state.general;
      },
      getExperimental: async (...args: unknown[]) => {
        calls.getExperimental.push(args);
        return state.experimental;
      },
      updateGeneral: async (...args: unknown[]) => {
        calls.updateGeneral.push(args);
        state.general = { ...state.general, ...(args[0] as Record<string, unknown>) };
        return {
          id: "instance-settings-1",
          general: state.general,
        };
      },
      updateExperimental: async (...args: unknown[]) => {
        calls.updateExperimental.push(args);
        state.experimental = { ...state.experimental, ...(args[0] as Record<string, unknown>) };
        return {
          id: "instance-settings-1",
          experimental: state.experimental,
        };
      },
      listCompanyIds: async (...args: unknown[]) => {
        calls.listCompanyIds.push(args);
        return state.companyIds;
      },
    } as any,
    logActivity: async (...args: unknown[]) => {
      calls.logActivity.push(args);
    },
  }));
  app.use(errorHandler);

  return { app, state, calls };
}

describe("instance settings routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/instance-settings.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../middleware/validate.js");
    vi.doUnmock("../services/index.js");
  });

  afterEach(() => {
    vi.doUnmock("../routes/instance-settings.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../middleware/validate.js");
    vi.doUnmock("../services/index.js");
  });

  it("allows local board users to read and update experimental settings", async () => {
    const actor = {
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    };
    const { app: readApp } = await createHarness(actor);

    const getRes = await request(readApp).get("/api/instance/settings/experimental");
    expect(getRes.status).toBe(200);
    expect(getRes.body).toEqual({
      enableIsolatedWorkspaces: false,
      autoRestartDevServerWhenIdle: false,
    });

    const { app: patchApp } = await createHarness(actor);
    const patchRes = await request(patchApp)
      .patch("/api/instance/settings/experimental")
      .send({ enableIsolatedWorkspaces: true });

    expect(patchRes.status).toBe(200);
    expect(patchRes.body).toEqual({
      enableIsolatedWorkspaces: true,
      autoRestartDevServerWhenIdle: false,
    });
  });

  it("allows local board users to update guarded dev-server auto-restart", async () => {
    const { app } = await createHarness({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await request(app)
      .patch("/api/instance/settings/experimental")
      .send({ autoRestartDevServerWhenIdle: true })
      .expect(200);

    expect(res.body).toEqual({
      enableIsolatedWorkspaces: false,
      autoRestartDevServerWhenIdle: true,
    });
  });

  it("allows local board users to read and update general settings", async () => {
    const actor = {
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    };
    const { app: readApp } = await createHarness(actor);

    const getRes = await request(readApp).get("/api/instance/settings/general");
    expect(getRes.status).toBe(200);
    expect(getRes.body).toEqual({
      censorUsernameInLogs: false,
      keyboardShortcuts: false,
      feedbackDataSharingPreference: "prompt",
    });

    const { app: patchApp } = await createHarness(actor);
    const patchRes = await request(patchApp)
      .patch("/api/instance/settings/general")
      .send({
        censorUsernameInLogs: true,
        keyboardShortcuts: true,
        feedbackDataSharingPreference: "allowed",
      });

    expect(patchRes.status).toBe(200);
    expect(patchRes.body).toEqual({
      censorUsernameInLogs: true,
      keyboardShortcuts: true,
      feedbackDataSharingPreference: "allowed",
    });
  });

  it("allows non-admin board users to read general settings", async () => {
    const { app, calls } = await createHarness({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });

    const res = await request(app).get("/api/instance/settings/general");

    expect(res.status).toBe(200);
    expect(calls.getGeneral).toHaveLength(1);
  });

  it("rejects non-admin board users from updating general settings", async () => {
    const { app } = await createHarness({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });

    const res = await request(app)
      .patch("/api/instance/settings/general")
      .send({ censorUsernameInLogs: true, keyboardShortcuts: true });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Instance admin access required");
  });

  it("rejects agent callers", async () => {
    const { app } = await createHarness({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
    });

    const res = await request(app)
      .patch("/api/instance/settings/general")
      .send({ feedbackDataSharingPreference: "not_allowed" });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Board access required");
  });
});
