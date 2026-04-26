import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function createHarness(actor: any) {
  vi.doUnmock("../routes/admin.js");
  vi.doUnmock("../routes/authz.js");
  vi.doUnmock("../middleware/index.js");
  vi.doUnmock("../services/heartbeat.js");

  const [{ errorHandler }, { adminRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/admin.js")>("../routes/admin.js"),
  ]);

  const app = express();
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", adminRoutes());
  app.use(errorHandler);
  return app;
}

describe("admin routes", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.doUnmock("../routes/admin.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../services/heartbeat.js");
    const heartbeatModule = await vi.importActual<typeof import("../services/heartbeat.js")>("../services/heartbeat.js");
    heartbeatModule.resetHeartbeatReaperTicksForTests();
  });

  afterEach(async () => {
    const heartbeatModule = await vi.importActual<typeof import("../services/heartbeat.js")>("../services/heartbeat.js");
    heartbeatModule.resetHeartbeatReaperTicksForTests();
    vi.restoreAllMocks();
  });

  it("returns recent reaper ticks for instance admins", async () => {
    const heartbeatModule = await vi.importActual<typeof import("../services/heartbeat.js")>("../services/heartbeat.js");
    heartbeatModule.pushHeartbeatReaperTickForTests({
      recordedAt: "2026-04-24T16:00:00.000Z",
      staleThresholdMs: 300_000,
      scannedRunningCount: 2,
      inMemoryActiveCount: 0,
      skippedFreshCount: 1,
      detachedCount: 0,
      reapedCount: 1,
      runIds: ["run-older"],
      reapedRuns: [{ runId: "run-older", timeSinceLockMs: 301_000 }],
      timeSinceLockMs: {
        count: 1,
        minMs: 301_000,
        p50Ms: 301_000,
        p95Ms: 301_000,
        maxMs: 301_000,
      },
    });
    heartbeatModule.pushHeartbeatReaperTickForTests({
      recordedAt: "2026-04-24T16:01:00.000Z",
      staleThresholdMs: 300_000,
      scannedRunningCount: 3,
      inMemoryActiveCount: 1,
      skippedFreshCount: 1,
      detachedCount: 0,
      reapedCount: 1,
      runIds: ["run-newer"],
      reapedRuns: [{ runId: "run-newer", timeSinceLockMs: 420_000 }],
      timeSinceLockMs: {
        count: 1,
        minMs: 420_000,
        p50Ms: 420_000,
        p95Ms: 420_000,
        maxMs: 420_000,
      },
    });

    const app = await createHarness({
      type: "board",
      userId: "admin-1",
      source: "session",
      isInstanceAdmin: true,
    });

    const res = await request(app).get("/api/admin/reaper-stats?limit=1");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      limit: 1,
      ticks: [{
        recordedAt: "2026-04-24T16:01:00.000Z",
        staleThresholdMs: 300_000,
        scannedRunningCount: 3,
        inMemoryActiveCount: 1,
        skippedFreshCount: 1,
        detachedCount: 0,
        reapedCount: 1,
        runIds: ["run-newer"],
        reapedRuns: [{ runId: "run-newer", timeSinceLockMs: 420_000 }],
        timeSinceLockMs: {
          count: 1,
          minMs: 420_000,
          p50Ms: 420_000,
          p95Ms: 420_000,
          maxMs: 420_000,
        },
      }],
    });
  });

  it("rejects non-admin board users", async () => {
    const app = await createHarness({
      type: "board",
      userId: "board-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });

    const res = await request(app).get("/api/admin/reaper-stats");
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Instance admin access required");
  });

  it("rejects agents", async () => {
    const app = await createHarness({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
    });

    const res = await request(app).get("/api/admin/reaper-stats");
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Board access required");
  });
});
