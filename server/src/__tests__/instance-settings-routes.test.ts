import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

async function createHarness(actor: any) {
  const instanceSettingsService = {
    getGeneral: vi.fn().mockResolvedValue({
      censorUsernameInLogs: false,
      keyboardShortcuts: false,
      feedbackDataSharingPreference: "prompt",
    }),
    getExperimental: vi.fn().mockResolvedValue({
      enableIsolatedWorkspaces: false,
      autoRestartDevServerWhenIdle: false,
    }),
    updateGeneral: vi.fn(async (patch: Record<string, unknown>) => ({
      id: "instance-settings-1",
      general: {
        censorUsernameInLogs: false,
        keyboardShortcuts: false,
        feedbackDataSharingPreference: "prompt",
        ...patch,
      },
    })),
    updateExperimental: vi.fn(async (patch: Record<string, unknown>) => ({
      id: "instance-settings-1",
      experimental: {
        enableIsolatedWorkspaces: false,
        autoRestartDevServerWhenIdle: false,
        ...patch,
      },
    })),
    listCompanyIds: vi.fn().mockResolvedValue(["company-1", "company-2"]),
  };
  const logActivity = vi.fn().mockResolvedValue(undefined);
  const [{ errorHandler }, { instanceSettingsRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/instance-settings.js"),
  ]);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", instanceSettingsRoutes({} as any, {
    instanceSettingsService: instanceSettingsService as any,
    logActivity,
  }));
  app.use(errorHandler);

  return { app, instanceSettingsService, logActivity };
}

describe("instance settings routes", () => {
  beforeEach(() => {
    vi.resetModules();
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
    const { app, instanceSettingsService } = await createHarness({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });

    const res = await request(app).get("/api/instance/settings/general");

    expect(res.status).toBe(200);
    expect(instanceSettingsService.getGeneral).toHaveBeenCalled();
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
