import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InstanceDatabaseBackupService } from "../routes/instance-database-backups.js";

async function createApp(actor: Record<string, unknown>, service: InstanceDatabaseBackupService) {
  vi.doUnmock("../routes/instance-database-backups.js");
  vi.doUnmock("../middleware/index.js");
  const [{ instanceDatabaseBackupRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/instance-database-backups.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor as typeof req.actor;
    next();
  });
  app.use("/api", instanceDatabaseBackupRoutes(service));
  app.use(errorHandler);
  return app;
}

function createBackupService(
  overrides: Partial<InstanceDatabaseBackupService> = {},
): InstanceDatabaseBackupService {
  return {
    runManualBackup: vi.fn().mockResolvedValue({
      trigger: "manual",
      backupFile: "/tmp/paperclip-20260416.sql.gz",
      sizeBytes: 1234,
      prunedCount: 2,
      backupDir: "/tmp",
      retention: {
        dailyDays: 7,
        weeklyWeeks: 4,
        monthlyMonths: 1,
      },
      startedAt: "2026-04-16T20:00:00.000Z",
      finishedAt: "2026-04-16T20:00:01.000Z",
      durationMs: 1000,
    }),
    ...overrides,
  };
}

describe("instance database backup routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("runs a manual backup for an instance admin and returns the server result", async () => {
    const service = createBackupService();
    const app = await createApp(
      {
        type: "board",
        userId: "admin-1",
        source: "session",
        isInstanceAdmin: true,
      },
      service,
    );

    const res = await request(app).post("/api/instance/database-backups").send({});

    expect(res.status).toBe(201);
    expect(service.runManualBackup).toHaveBeenCalledTimes(1);
    expect(res.body).toEqual({
      trigger: "manual",
      backupFile: "/tmp/paperclip-20260416.sql.gz",
      sizeBytes: 1234,
      prunedCount: 2,
      backupDir: "/tmp",
      retention: {
        dailyDays: 7,
        weeklyWeeks: 4,
        monthlyMonths: 1,
      },
      startedAt: "2026-04-16T20:00:00.000Z",
      finishedAt: "2026-04-16T20:00:01.000Z",
      durationMs: 1000,
    });
  });

  it("allows local implicit board access", async () => {
    const service = createBackupService();
    const app = await createApp(
      {
        type: "board",
        userId: "local-board",
        source: "local_implicit",
        isInstanceAdmin: false,
      },
      service,
    );

    await request(app).post("/api/instance/database-backups").send({}).expect(201);
    expect(service.runManualBackup).toHaveBeenCalledTimes(1);
  });

  it("rejects non-admin board users", async () => {
    const service = createBackupService();
    const app = await createApp(
      {
        type: "board",
        userId: "user-1",
        source: "session",
        isInstanceAdmin: false,
        companyIds: ["company-1"],
      },
      service,
    );

    await request(app).post("/api/instance/database-backups").send({}).expect(403);
    expect(service.runManualBackup).not.toHaveBeenCalled();
  });

  it("rejects agent callers", async () => {
    const service = createBackupService();
    const app = await createApp(
      {
        type: "agent",
        agentId: "agent-1",
        companyId: "company-1",
        source: "agent_key",
      },
      service,
    );

    await request(app).post("/api/instance/database-backups").send({}).expect(403);
    expect(service.runManualBackup).not.toHaveBeenCalled();
  });

  it("returns conflict when another server backup is already running", async () => {
    const { conflict } = await import("../errors.js");
    const service = createBackupService({
      runManualBackup: vi.fn().mockRejectedValue(conflict("Database backup already in progress")),
    });
    const app = await createApp(
      {
        type: "board",
        userId: "admin-1",
        source: "session",
        isInstanceAdmin: true,
      },
      service,
    );

    const res = await request(app).post("/api/instance/database-backups").send({});

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "Database backup already in progress" });
  });
});
