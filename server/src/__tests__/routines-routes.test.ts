import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
const advisorTemplates = [
  {
    advisorKind: "security_audit",
    title: "Security Audit",
    description: "Review runtime and dependency risk.",
    disabledByDefault: true,
    variables: [],
  },
];
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

async function createHarness(
  actor: Record<string, unknown>,
  overrides?: {
    accessCanUser?: (companyId: string, userId: string, permission: string) => Promise<boolean> | boolean;
    getRoutine?: (routineId: string) => Promise<typeof routine | typeof pausedRoutine | null> | (typeof routine | typeof pausedRoutine | null);
    updateRoutine?: (routineId: string, input: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>;
  },
) {
  vi.doUnmock("../middleware/index.js");
  vi.doUnmock("../routes/routines.js");
  vi.doUnmock("../services/index.js");
  vi.doUnmock("../routes/authz.js");
  vi.doUnmock("../middleware/validate.js");
  vi.doUnmock("../telemetry.js");
  vi.doUnmock("@paperclipai/shared/telemetry");
  const [{ errorHandler }, { routineRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/routines.js")>("../routes/routines.js"),
  ]);
  const routineService = {
    list: async () => [],
    listAdvisorTemplates: () => advisorTemplates,
    get: async (routineId: string) => {
      if (overrides?.getRoutine) {
        return await overrides.getRoutine(routineId);
      }
      return routine;
    },
    getDetail: async () => null,
    update: async (routineId: string, input: Record<string, unknown>) => {
      if (overrides?.updateRoutine) {
        return await overrides.updateRoutine(routineId, input);
      }
      return { ...routine, assigneeAgentId: otherAgentId };
    },
    create: async () => routine,
    listRuns: async () => [],
    createTrigger: async () => trigger,
    getTrigger: async () => trigger,
    updateTrigger: async () => trigger,
    deleteTrigger: async () => undefined,
    rotateTriggerSecret: async () => trigger,
    runRoutine: async () => ({
      id: "run-1",
      source: "manual",
      status: "issue_created",
    }),
    firePublicTrigger: async () => undefined,
  };
  const accessService = {
    canUser: async (targetCompanyId: string, userId: string, permission: string) => {
      if (overrides?.accessCanUser) {
        return await overrides.accessCanUser(targetCompanyId, userId, permission);
      }
      return false;
    },
  };
  const logActivity = async () => undefined;
  const trackRoutineCreated = () => {};
  const getTelemetryClient = () => ({ track: () => {} });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = { ...actor };
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

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.doUnmock("../middleware/index.js");
  vi.doUnmock("../routes/routines.js");
  vi.doUnmock("../services/index.js");
  vi.doUnmock("../routes/authz.js");
  vi.doUnmock("../middleware/validate.js");
  vi.doUnmock("../telemetry.js");
  vi.doUnmock("@paperclipai/shared/telemetry");
});

describe("routine routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../routes/routines.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/validate.js");
    vi.doUnmock("../telemetry.js");
    vi.doUnmock("@paperclipai/shared/telemetry");
  });

  it("requires tasks:assign permission for non-admin board routine creation", async () => {
    const { app } = await createHarness({
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
    const accessCanUser = vi.fn(async () => false);
    const { app } = await createHarness({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    }, {
      accessCanUser,
      getRoutine: async () => ({ ...routine, assigneeAgentId: agentId }),
    });

    const res = await request(app)
      .patch(`/api/routines/${routineId}`)
      .send({
        assigneeAgentId: otherAgentId,
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("tasks:assign");
    expect(accessCanUser).toHaveBeenCalledWith(companyId, "board-user", "tasks:assign");
  });

  it("requires tasks:assign permission to reactivate a routine", async () => {
    const accessCanUser = vi.fn(async () => false);
    const { app } = await createHarness({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    }, {
      accessCanUser,
      getRoutine: async () => pausedRoutine,
    });

    const res = await request(app)
      .patch(`/api/routines/${routineId}`)
      .send({
        status: "active",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("tasks:assign");
    expect(accessCanUser).toHaveBeenCalledWith(companyId, "board-user", "tasks:assign");
  });

  it("requires tasks:assign permission to create a trigger", async () => {
    const { app } = await createHarness({
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
    const { app } = await createHarness({
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
    const { app } = await createHarness({
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

  it("passes the board actor through when manually running a routine", async () => {
    mockAccessService.canUser.mockResolvedValue(true);
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app)
      .post(`/api/routines/${routineId}/run`)
      .send({});

    expect(res.status).toBe(202);
    expect(mockRoutineService.runRoutine).toHaveBeenCalledWith(routineId, {
      source: "manual",
    }, {
      agentId: null,
      userId: "board-user",
    });
  });

  it("allows routine creation when the board user has tasks:assign", async () => {
    const { app } = await createHarness({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    }, {
      accessCanUser: async () => true,
    });

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

  it("lists built-in advisor routine templates for company actors", async () => {
    const { app } = await createHarness({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app).get(`/api/companies/${companyId}/routines/advisor-templates`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual(advisorTemplates);
  });
});
