import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

async function createHarness(actor: any) {
  vi.resetModules();
  const evalService = {
    getSummary: vi.fn().mockResolvedValue({
      artifactSchemaVersion: 1,
      evalContractVersion: 1,
      scorecardVersion: 1,
      generatedAt: "2026-04-13T12:00:00.000Z",
      runCount: 1,
      latestRunId: "run-1",
      statusCounts: [{ status: "passed", count: 1 }],
      dimensions: [],
      scenarios: [],
      failingScenarios: [],
      runs: [],
    }),
    listRuns: vi.fn().mockResolvedValue([
      {
        runId: "run-1",
        scenarioId: "worker-isolation-across-projects",
        scenarioTitle: "Worker isolation across projects",
        bundleId: "architecture-canary",
        bundleLabel: "Architecture Canary",
        dimension: "reliability",
        layer: "invariant",
        horizonBucket: "15_60m",
        status: "passed",
        acceptedOutcome: true,
        startedAt: "2026-04-13T12:00:00.000Z",
        completedAt: "2026-04-13T12:00:03.000Z",
        durationMs: 3000,
        artifactDirectory: "runs/run-1",
        failureKinds: [],
        tags: ["scope"],
        sourceKind: "seeded",
      },
    ]),
    getRun: vi.fn().mockResolvedValue({
      runId: "run-1",
      status: "passed",
      redactionMode: "redacted",
      sourceKind: "seeded",
    }),
  };

  const [{ errorHandler }, { evalRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/evals.js"),
  ]);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", evalRoutes({} as any, { evalService: evalService as any }));
  app.use(errorHandler);

  return { app, evalService };
}

describe("eval routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows instance admins to read summary and run detail", async () => {
    const { app, evalService } = await createHarness({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const summaryRes = await request(app).get("/api/instance/evals/summary");
    expect(summaryRes.status).toBe(200);
    expect(evalService.getSummary).toHaveBeenCalled();

    const runsRes = await request(app).get("/api/instance/evals/runs");
    expect(runsRes.status).toBe(200);
    expect(runsRes.body[0].runId).toBe("run-1");

    const detailRes = await request(app).get("/api/instance/evals/runs/run-1");
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.redactionMode).toBe("redacted");
  });

  it("rejects non-admin board users", async () => {
    const { app } = await createHarness({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });

    const res = await request(app).get("/api/instance/evals/summary");
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

    const res = await request(app).get("/api/instance/evals/summary");
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Board access required");
  });

  it("returns 404 for unknown runs", async () => {
    const { app, evalService } = await createHarness({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
      isInstanceAdmin: true,
    });
    evalService.getRun.mockResolvedValueOnce(null);

    const res = await request(app).get("/api/instance/evals/runs/missing-run");
    expect(res.status).toBe(404);
    expect(res.body.error).toContain("Eval run not found");
  });
});
