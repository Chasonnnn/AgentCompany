import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { routineRoutes } from "../routes/routines.js";

const companyId = "22222222-2222-4222-8222-222222222222";
const agentId = "11111111-1111-4111-8111-111111111111";
const routineId = "33333333-3333-4333-8333-333333333333";
const projectId = "44444444-4444-4444-8444-444444444444";
const otherAgentId = "55555555-5555-4555-8555-555555555555";

const routine = {
  id: routineId,
  companyId,
  projectId,
  goalId: null,
  parentIssueId: null,
  title: "Daily routine",
  description: null,
  assigneeAgentId: agentId,
  priority: "medium",
  status: "active",
  concurrencyPolicy: "coalesce_if_active",
  catchUpPolicy: "skip_missed",
  createdByAgentId: null,
  createdByUserId: null,
  updatedByAgentId: null,
  updatedByUserId: null,
  lastTriggeredAt: null,
  lastEnqueuedAt: null,
  createdAt: new Date("2026-03-20T00:00:00.000Z"),
  updatedAt: new Date("2026-03-20T00:00:00.000Z"),
};
const pausedRoutine = {
  ...routine,
  status: "paused",
};
const trigger = {
  id: "66666666-6666-4666-8666-666666666666",
  companyId,
  routineId,
  kind: "schedule",
  label: "weekday",
  enabled: false,
  cronExpression: "0 10 * * 1-5",
  timezone: "UTC",
  nextRunAt: null,
  lastFiredAt: null,
  publicId: null,
  secretId: null,
  signingMode: null,
  replayWindowSec: null,
  lastRotatedAt: null,
  lastResult: null,
  createdByAgentId: null,
  createdByUserId: null,
  updatedByAgentId: null,
  updatedByUserId: null,
  createdAt: new Date("2026-03-20T00:00:00.000Z"),
  updatedAt: new Date("2026-03-20T00:00:00.000Z"),
};

function createHarness(actor: Record<string, unknown>) {
  const routineService = {
    list: vi.fn(),
    get: vi.fn().mockResolvedValue(routine),
    getDetail: vi.fn(),
    update: vi.fn().mockResolvedValue({ ...routine, assigneeAgentId: otherAgentId }),
    create: vi.fn().mockResolvedValue(routine),
    listRuns: vi.fn(),
    createTrigger: vi.fn(),
    getTrigger: vi.fn().mockResolvedValue(trigger),
    updateTrigger: vi.fn(),
    deleteTrigger: vi.fn(),
    rotateTriggerSecret: vi.fn(),
    runRoutine: vi.fn().mockResolvedValue({
      id: "run-1",
      source: "manual",
      status: "issue_created",
    }),
    firePublicTrigger: vi.fn(),
  };
  const accessService = {
    canUser: vi.fn().mockResolvedValue(false),
  };
  const logActivity = vi.fn().mockResolvedValue(undefined);
  const trackRoutineCreated = vi.fn();
  const getTelemetryClient = vi.fn().mockReturnValue({ track: vi.fn() });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", routineRoutes({} as any, {
    accessService: accessService as any,
    getTelemetryClient: getTelemetryClient as any,
    logActivity,
    routineService: routineService as any,
    trackRoutineCreated,
  }));
  app.use(errorHandler);

  return { accessService, app, logActivity, routineService, trackRoutineCreated };
}

describe("routine routes", () => {
  it("requires tasks:assign permission for non-admin board routine creation", async () => {
    const { app } = createHarness({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/routines`)
      .send({
        projectId,
        title: "Daily routine",
        assigneeAgentId: agentId,
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("tasks:assign");
  });

  it("requires tasks:assign permission to retarget a routine assignee", async () => {
    const { app } = createHarness({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app)
      .patch(`/api/routines/${routineId}`)
      .send({
        assigneeAgentId: otherAgentId,
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("tasks:assign");
  });

  it("requires tasks:assign permission to reactivate a routine", async () => {
    const { app, routineService } = createHarness({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });
    routineService.get.mockResolvedValue(pausedRoutine);

    const res = await request(app)
      .patch(`/api/routines/${routineId}`)
      .send({
        status: "active",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("tasks:assign");
  });

  it("requires tasks:assign permission to create a trigger", async () => {
    const { app } = createHarness({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app)
      .post(`/api/routines/${routineId}/triggers`)
      .send({
        kind: "schedule",
        cronExpression: "0 10 * * *",
        timezone: "UTC",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("tasks:assign");
  });

  it("requires tasks:assign permission to update a trigger", async () => {
    const { app } = createHarness({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app)
      .patch(`/api/routine-triggers/${trigger.id}`)
      .send({
        enabled: true,
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("tasks:assign");
  });

  it("requires tasks:assign permission to manually run a routine", async () => {
    const { app } = createHarness({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app)
      .post(`/api/routines/${routineId}/run`)
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("tasks:assign");
  });

  it("allows routine creation when the board user has tasks:assign", async () => {
    const { accessService, app } = createHarness({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });
    accessService.canUser.mockResolvedValue(true);

    const res = await request(app)
      .post(`/api/companies/${companyId}/routines`)
      .send({
        projectId,
        title: "Daily routine",
        assigneeAgentId: agentId,
      });

    expect(res.status).toBe(201);
    expect(res.body).toEqual(expect.objectContaining({
      id: routineId,
      title: "Daily routine",
      assigneeAgentId: agentId,
    }));
  });
});
