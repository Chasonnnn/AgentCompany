import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockActivityService = vi.hoisted(() => ({
  list: vi.fn(),
  forIssue: vi.fn(),
  runsForIssue: vi.fn(),
  issuesForRun: vi.fn(),
  create: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  getRun: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
}));

const boardActor = {
  type: "board" as const,
  userId: "user-1",
  companyIds: ["company-1"],
  source: "session" as const,
  isInstanceAdmin: false,
};

async function createApp(
  actor: Record<string, unknown> = boardActor,
  dbOverride: unknown = {},
) {
  vi.doUnmock("../routes/activity.js");
  vi.doUnmock("../middleware/index.js");
  vi.doUnmock("../services/index.js");

  const [{ errorHandler }, { activityRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/activity.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", activityRoutes(dbOverride as any, {
    activityService: mockActivityService as any,
    heartbeatService: mockHeartbeatService as any,
    issueService: mockIssueService as any,
  }));
  app.use(errorHandler);
  return app;
}

describe("activity routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("resolves issue identifiers before loading runs", async () => {
    mockIssueService.getByIdentifier.mockResolvedValue({
      id: "issue-uuid-1",
      companyId: "company-1",
    });
    mockActivityService.runsForIssue.mockResolvedValue([
      {
        runId: "run-1",
      },
    ]);

    const app = await createApp();
    const res = await request(app).get("/api/issues/PAP-475/runs");

    expect(res.status).toBe(200);
    expect(mockIssueService.getByIdentifier).toHaveBeenCalledWith("PAP-475");
    expect(mockIssueService.getById).not.toHaveBeenCalled();
    expect(mockActivityService.runsForIssue).toHaveBeenCalledWith("company-1", "issue-uuid-1");
    expect(res.body).toEqual([{ runId: "run-1" }]);
  });

  it("requires company access before creating activity events", async () => {
    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-2/activity")
      .send({
        actorId: "user-1",
        action: "test.event",
        entityType: "issue",
        entityId: "issue-1",
      });

    expect(res.status).toBe(403);
    expect(mockActivityService.create).not.toHaveBeenCalled();
  });

  it("requires company access before listing issues for another company's run", async () => {
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-2",
      companyId: "company-2",
    });

    const app = await createApp();
    const res = await request(app).get("/api/heartbeat-runs/run-2/issues");

    expect(res.status).toBe(403);
    expect(mockActivityService.issuesForRun).not.toHaveBeenCalled();
  });

  // AIW-27 D6-1a. Board actors are privileged and see raw runIds; non-participant
  // agents get opaque `run-hash:...` tokens in activity responses.
  describe("runId redaction", () => {
    it("returns raw runId to board actors on GET /companies/:companyId/activity", async () => {
      mockActivityService.list.mockResolvedValue([
        { id: "a1", entityType: "agent", entityId: "some-other", runId: "run-raw-1" },
      ]);

      const app = await createApp();
      const res = await request(app).get("/api/companies/company-1/activity");

      expect(res.status).toBe(200);
      expect(res.body[0].runId).toBe("run-raw-1");
    });

    it("hashes runId for same-company non-participant agents on non-issue rows", async () => {
      mockActivityService.list.mockResolvedValue([
        { id: "a1", entityType: "agent", entityId: "some-other", runId: "run-raw-1" },
      ]);

      const sameCompanyAgent = {
        type: "agent",
        agentId: "outsider",
        companyId: "company-1",
        source: "agent_key",
      };
      const app = await createApp(sameCompanyAgent);
      const res = await request(app).get("/api/companies/company-1/activity");

      expect(res.status).toBe(200);
      expect(res.body[0].runId).toMatch(/^run-hash:[0-9a-f]+$/);
      expect(res.body[0].runId).not.toBe("run-raw-1");
    });

    it("passes through null runId untouched (GET /issues/:id/activity)", async () => {
      mockIssueService.getByIdentifier.mockResolvedValue({
        id: "issue-uuid-1",
        companyId: "company-1",
        assigneeAgentId: null,
      });
      mockActivityService.forIssue.mockResolvedValue([
        { id: "a1", entityType: "issue", entityId: "issue-uuid-1", runId: "run-raw-1" },
        { id: "a2", entityType: "issue", entityId: "issue-uuid-1", runId: null },
      ]);

      const sameCompanyAgent = {
        type: "agent",
        agentId: "outsider",
        companyId: "company-1",
        source: "agent_key",
      };
      const app = await createApp(sameCompanyAgent);
      const res = await request(app).get("/api/issues/PAP-475/activity");

      expect(res.status).toBe(200);
      // Unassigned issue short-circuits to not-privileged for same-company agents.
      expect(res.body[0].runId).toMatch(/^run-hash:[0-9a-f]+$/);
      expect(res.body[1].runId).toBeNull();
    });

    it("gives the issue assignee raw runIds on GET /issues/:id/runs", async () => {
      mockIssueService.getByIdentifier.mockResolvedValue({
        id: "issue-uuid-1",
        companyId: "company-1",
        assigneeAgentId: "assignee-agent",
      });
      mockActivityService.runsForIssue.mockResolvedValue([
        { runId: "run-raw-1", retryOfRunId: "run-raw-0" },
      ]);

      const assigneeActor = {
        type: "agent",
        agentId: "assignee-agent",
        companyId: "company-1",
        source: "agent_key",
      };
      const app = await createApp(assigneeActor);
      const res = await request(app).get("/api/issues/PAP-475/runs");

      expect(res.status).toBe(200);
      expect(res.body[0].runId).toBe("run-raw-1");
      expect(res.body[0].retryOfRunId).toBe("run-raw-0");
    });

    it("redacts runId + retryOfRunId for same-company non-assignee on GET /issues/:id/runs", async () => {
      mockIssueService.getByIdentifier.mockResolvedValue({
        id: "issue-uuid-1",
        companyId: "company-1",
        assigneeAgentId: null,
      });
      mockActivityService.runsForIssue.mockResolvedValue([
        { runId: "run-raw-1", retryOfRunId: "run-raw-0" },
      ]);

      const sameCompanyAgent = {
        type: "agent",
        agentId: "outsider",
        companyId: "company-1",
        source: "agent_key",
      };
      const app = await createApp(sameCompanyAgent);
      const res = await request(app).get("/api/issues/PAP-475/runs");

      expect(res.status).toBe(200);
      expect(res.body[0].runId).toMatch(/^run-hash:[0-9a-f]+$/);
      expect(res.body[0].retryOfRunId).toMatch(/^run-hash:[0-9a-f]+$/);
      expect(res.body[0].runId).not.toBe(res.body[0].retryOfRunId);
    });
  });
});
