import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { serverVersion } from "../version.js";

describe("GET /health", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.doUnmock("../routes/health.js");
    vi.doUnmock("../dev-server-status.js");
    vi.doUnmock("../services/instance-settings.js");
    vi.doUnmock("../middleware/logger.js");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("../routes/health.js");
    vi.doUnmock("../dev-server-status.js");
    vi.doUnmock("../services/instance-settings.js");
    vi.doUnmock("../middleware/logger.js");
  });

  it("returns 200 with status ok", async () => {
    const devServerStatus = await vi.importActual<typeof import("../dev-server-status.js")>("../dev-server-status.js");
    vi.spyOn(devServerStatus, "readPersistedDevServerStatus").mockReturnValue(undefined);
    const { healthRoutes } = await vi.importActual<typeof import("../routes/health.js")>("../routes/health.js");
    const app = express();
    app.use("/health", healthRoutes());

    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", version: serverVersion });
  });

  it("returns 200 when the database probe succeeds", async () => {
    const devServerStatus = await vi.importActual<typeof import("../dev-server-status.js")>("../dev-server-status.js");
    vi.spyOn(devServerStatus, "readPersistedDevServerStatus").mockReturnValue(undefined);
    const { healthRoutes } = await vi.importActual<typeof import("../routes/health.js")>("../routes/health.js");
    const db = {
      execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    } as unknown as Db;
    const app = express();
    app.use("/health", healthRoutes(db));

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", version: serverVersion });
  });

  it("returns 503 when the database probe fails", async () => {
    const devServerStatus = await vi.importActual<typeof import("../dev-server-status.js")>("../dev-server-status.js");
    vi.spyOn(devServerStatus, "readPersistedDevServerStatus").mockReturnValue(undefined);
    const { healthRoutes } = await vi.importActual<typeof import("../routes/health.js")>("../routes/health.js");
    const db = {
      execute: vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")),
    } as unknown as Db;
    const app = express();
    app.use("/health", healthRoutes(db));

    const res = await request(app).get("/health");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      status: "unhealthy",
      version: serverVersion,
      error: "database_unreachable",
    });
  });
});
