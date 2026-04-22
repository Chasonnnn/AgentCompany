import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const issueId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";

function resetIssueRouteModules() {
  vi.doUnmock("../routes/issues.js");
  vi.doUnmock("../routes/authz.js");
  vi.doUnmock("../middleware/index.js");
  vi.doUnmock("../middleware/validate.js");
  vi.doUnmock("../services/index.js");
  vi.doUnmock("../telemetry.js");
  vi.doUnmock("@paperclipai/shared/telemetry");
}

function createRouteHarness() {
  return {
    issueService: {
      getById: vi.fn(),
    },
    documentsService: {
      listIssueDocumentRevisions: vi.fn(),
      restoreIssueDocumentRevision: vi.fn(),
    },
    accessService: {
      canUser: vi.fn(),
      hasPermission: vi.fn(),
    },
    agentService: {
      getById: vi.fn(),
    },
    logActivity: vi.fn(async () => undefined),
  };
}

function seedHarnessDefaults(harness: ReturnType<typeof createRouteHarness>) {
  harness.issueService.getById.mockResolvedValue({
    id: issueId,
    companyId,
    identifier: "PAP-881",
    title: "Document revisions",
    status: "in_progress",
  });
  harness.documentsService.listIssueDocumentRevisions.mockResolvedValue([
    {
      id: "revision-1",
      companyId,
      documentId: "document-1",
      issueId,
      key: "plan",
      revisionNumber: 1,
      title: "Plan v1",
      format: "markdown",
      body: "# One",
      changeSummary: null,
      createdByAgentId: null,
      createdByUserId: "board-user",
      createdAt: new Date("2026-03-26T11:00:00.000Z"),
    },
    {
      id: "revision-2",
      companyId,
      documentId: "document-1",
      issueId,
      key: "plan",
      revisionNumber: 2,
      title: "Plan v2",
      format: "markdown",
      body: "# Two",
      changeSummary: null,
      createdByAgentId: null,
      createdByUserId: "board-user",
      createdAt: new Date("2026-03-26T12:00:00.000Z"),
    },
  ]);
  harness.documentsService.restoreIssueDocumentRevision.mockResolvedValue({
    restoredFromRevisionId: "revision-1",
    restoredFromRevisionNumber: 1,
    document: {
      id: "document-1",
      companyId,
      issueId,
      key: "plan",
      title: "Plan v1",
      format: "markdown",
      body: "# One",
      latestRevisionId: "revision-3",
      latestRevisionNumber: 3,
      createdByAgentId: null,
      createdByUserId: "board-user",
      updatedByAgentId: null,
      updatedByUserId: "board-user",
      createdAt: new Date("2026-03-26T12:00:00.000Z"),
      updatedAt: new Date("2026-03-26T12:10:00.000Z"),
    },
  });
}

function registerRouteMocks(harness: ReturnType<typeof createRouteHarness>) {
  vi.doMock("../services/index.js", () => ({
    accessService: () => harness.accessService,
    agentService: () => harness.agentService,
    documentService: () => harness.documentsService,
    executionWorkspaceService: () => ({}),
    feedbackService: () => ({}),
    goalService: () => ({}),
    heartbeatService: () => ({
      wakeup: vi.fn(async () => undefined),
      reportRunActivity: vi.fn(async () => undefined),
    }),
    instanceSettingsService: () => ({
      getExperimental: vi.fn(async () => ({})),
      getGeneral: vi.fn(async () => ({ feedbackDataSharingPreference: "prompt" })),
    }),
    issueApprovalService: () => ({}),
    issueContinuityService: () => ({
      recomputeIssueContinuityState: vi.fn(async () => ({
        tier: "normal",
        status: "draft",
        health: "healthy",
        requiredDocumentKeys: [],
        missingDocumentKeys: [],
        specState: "editable",
        branchRole: "none",
        branchStatus: "none",
        unresolvedBranchIssueIds: [],
        lastProgressAt: null,
        lastHandoffAt: null,
        lastPreparedAt: null,
        lastBundleHash: null,
      })),
    }),
    issueService: () => harness.issueService,
    logActivity: harness.logActivity,
    officeCoordinationService: () => ({
      findOfficeOperator: vi.fn(async () => null),
      buildWakeSnapshot: vi.fn(async () => null),
      isOfficeOperatorAgent: vi.fn(async () => false),
    }),
    projectService: () => ({}),
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => ({}),
  }));
}

async function createApp(harness: ReturnType<typeof createRouteHarness>) {
  registerRouteMocks(harness);
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/issues.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("issue document revision routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    resetIssueRouteModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    resetIssueRouteModules();
  });

  it("returns revision snapshots including title and format", async () => {
    const harness = createRouteHarness();
    seedHarnessDefaults(harness);

    const res = await request(await createApp(harness)).get(`/api/issues/${issueId}/documents/plan/revisions`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.arrayContaining([
      expect.objectContaining({
        revisionNumber: 2,
        title: "Plan v2",
        format: "markdown",
        body: "# Two",
      }),
    ]));
  });

  it("restores a revision through the append-only route and logs the action", async () => {
    const harness = createRouteHarness();
    seedHarnessDefaults(harness);

    const res = await request(await createApp(harness))
      .post(`/api/issues/${issueId}/documents/plan/revisions/revision-1/restore`)
      .send({});

    expect(res.status).toBe(200);
    expect(harness.documentsService.restoreIssueDocumentRevision).toHaveBeenCalledWith({
      issueId,
      key: "plan",
      revisionId: "revision-1",
      createdByAgentId: null,
      createdByUserId: "board-user",
    });
    expect(harness.logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.document_restored",
        details: expect.objectContaining({
          key: "plan",
          restoredFromRevisionId: "revision-1",
          restoredFromRevisionNumber: 1,
          revisionNumber: 3,
        }),
      }),
    );
    expect(res.body).toEqual(expect.objectContaining({
      key: "plan",
      title: "Plan v1",
      latestRevisionNumber: 3,
    }));
  });

  it("rejects invalid document keys before attempting restore", async () => {
    const harness = createRouteHarness();
    seedHarnessDefaults(harness);

    const res = await request(await createApp(harness))
      .post(`/api/issues/${issueId}/documents/INVALID KEY/revisions/revision-1/restore`)
      .send({});

    expect(res.status).toBe(400);
    expect(harness.documentsService.restoreIssueDocumentRevision).not.toHaveBeenCalled();
  });
});
