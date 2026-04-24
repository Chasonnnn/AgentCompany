import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockCompanyService = vi.hoisted(() => ({
  list: vi.fn(),
  stats: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  archive: vi.fn(),
  remove: vi.fn(),
}));

const mockProductivityService = vi.hoisted(() => ({
  companySummary: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({ canUser: vi.fn(), ensureMembership: vi.fn() }),
  agentService: () => ({ getById: vi.fn() }),
  agentTemplateService: () => ({ importPack: vi.fn() }),
  budgetService: () => ({ upsertPolicy: vi.fn() }),
  companyPortabilityService: () => ({
    exportBundle: vi.fn(),
    previewExport: vi.fn(),
    previewImport: vi.fn(),
    importBundle: vi.fn(),
  }),
  companyService: () => mockCompanyService,
  documentService: () => ({
    listCompanyDocuments: vi.fn(),
    getCompanyDocumentByKey: vi.fn(),
    upsertCompanyDocument: vi.fn(),
    listCompanyDocumentRevisions: vi.fn(),
    restoreCompanyDocumentRevision: vi.fn(),
    deleteCompanyDocument: vi.fn(),
    listTeamDocuments: vi.fn(),
    getTeamDocumentByScope: vi.fn(),
    upsertTeamDocument: vi.fn(),
    listTeamDocumentRevisions: vi.fn(),
    restoreTeamDocumentRevision: vi.fn(),
    deleteTeamDocument: vi.fn(),
  }),
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(),
    listFeedbackTraces: vi.fn(),
    getFeedbackTraceById: vi.fn(),
    saveIssueVote: vi.fn(),
  }),
  logActivity: vi.fn(),
}));

vi.mock("../services/productivity.js", () => ({
  productivityService: () => mockProductivityService,
}));

async function createApp(actor: Record<string, unknown>) {
  const [{ companyRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/companies.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api/companies", companyRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("productivity routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockCompanyService.getById.mockResolvedValue({
      id: "company-1",
      name: "Paperclip",
      status: "active",
    });
    mockProductivityService.companySummary.mockResolvedValue({
      companyId: "company-1",
      window: "7d",
      totals: { runCount: 0 },
      agents: [],
      lowYieldRuns: [],
      recommendations: [],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("allows board operators to read company productivity summaries", async () => {
    const app = await createApp({
      type: "board",
      source: "local_implicit",
      userId: "board",
      companyIds: ["company-1"],
    });

    const res = await request(app).get("/api/companies/company-1/productivity?window=30d");

    expect(res.status).toBe(200);
    expect(mockProductivityService.companySummary).toHaveBeenCalledWith("company-1", { window: "30d" });
  });

  it("rejects agent API keys for company-wide productivity summaries", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
    });

    const res = await request(app).get("/api/companies/company-1/productivity");

    expect(res.status).toBe(403);
    expect(mockProductivityService.companySummary).not.toHaveBeenCalled();
  });

  it("rejects board users without access to the target company", async () => {
    const app = await createApp({
      type: "board",
      source: "session",
      userId: "board",
      companyIds: ["company-2"],
    });

    const res = await request(app).get("/api/companies/company-1/productivity");

    expect(res.status).toBe(403);
    expect(mockProductivityService.companySummary).not.toHaveBeenCalled();
  });
});
