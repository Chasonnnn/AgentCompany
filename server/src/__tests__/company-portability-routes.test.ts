import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { companyRoutes } from "../routes/companies.js";
import { errorHandler } from "../middleware/index.js";

const mockCompanyService = vi.hoisted(() => ({
  list: vi.fn(),
  stats: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  archive: vi.fn(),
  remove: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  ensureMembership: vi.fn(),
}));

const mockBudgetService = vi.hoisted(() => ({
  upsertPolicy: vi.fn(),
}));

const mockCompanyPortabilityService = vi.hoisted(() => ({
  exportBundle: vi.fn(),
  previewExport: vi.fn(),
  previewImport: vi.fn(),
  importBundle: vi.fn(),
}));

const mockAgentTemplateService = vi.hoisted(() => ({
  importPack: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockFeedbackService = vi.hoisted(() => ({
  listIssueVotesForUser: vi.fn(),
  listFeedbackTraces: vi.fn(),
  getFeedbackTraceById: vi.fn(),
  saveIssueVote: vi.fn(),
}));
const mockDocumentService = vi.hoisted(() => ({
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
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  budgetService: () => mockBudgetService,
  companyPortabilityService: () => mockCompanyPortabilityService,
  companyService: () => mockCompanyService,
  agentTemplateService: () => mockAgentTemplateService,
  documentService: () => mockDocumentService,
  feedbackService: () => mockFeedbackService,
  logActivity: mockLogActivity,
}));

function createApp(actor: Record<string, unknown>) {
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

describe("company portability routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("rejects agents without create authority from company-scoped export preview routes", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "11111111-1111-4111-8111-111111111111",
      role: "engineer",
    });
    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "11111111-1111-4111-8111-111111111111",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .post("/api/companies/11111111-1111-4111-8111-111111111111/exports/preview")
      .send({ include: { company: true, agents: true, projects: true } });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Only agents with create authority");
    expect(mockCompanyPortabilityService.previewExport).not.toHaveBeenCalled();
  });

  it("allows agents with create authority to use company-scoped export preview routes", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "11111111-1111-4111-8111-111111111111",
      role: "ceo",
    });
    mockCompanyPortabilityService.previewExport.mockResolvedValue({
      rootPath: "paperclip",
      manifest: { agents: [], skills: [], projects: [], issues: [], envInputs: [], includes: { company: true, agents: true, projects: true, issues: false, skills: false }, company: null, schemaVersion: 1, generatedAt: new Date().toISOString(), source: null },
      files: {},
      fileInventory: [],
      counts: { files: 0, agents: 0, skills: 0, projects: 0, issues: 0 },
      warnings: [],
      paperclipExtensionPath: ".paperclip.yaml",
    });
    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "11111111-1111-4111-8111-111111111111",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .post("/api/companies/11111111-1111-4111-8111-111111111111/exports/preview")
      .send({ include: { company: true, agents: true, projects: true } });

    expect(res.status).toBe(200);
    expect(res.body.rootPath).toBe("paperclip");
  });

  it("rejects replace collision strategy on create-authority import routes", async () => {
    const originalGetById = mockAgentService.getById;
    const originalPreviewImport = mockCompanyPortabilityService.previewImport;
    const getByIdCalls: unknown[][] = [];
    const previewImportCalls: unknown[][] = [];
    try {
      mockAgentService.getById = (async (...args: unknown[]) => {
        getByIdCalls.push(args);
        return {
          id: "agent-1",
          companyId: "11111111-1111-4111-8111-111111111111",
          role: "ceo",
        };
      }) as any;
      mockCompanyPortabilityService.previewImport = (async (...args: unknown[]) => {
        previewImportCalls.push(args);
        return { ok: true };
      }) as any;
      const app = createApp({
        type: "agent",
        agentId: "agent-1",
        companyId: "11111111-1111-4111-8111-111111111111",
        source: "agent_key",
        runId: "run-1",
      });

      const res = await request(app)
        .post("/api/companies/11111111-1111-4111-8111-111111111111/imports/preview")
        .send({
          source: { type: "inline", files: { "COMPANY.md": "---\nname: Test\n---\n" } },
          include: { company: true, agents: true, projects: false, issues: false },
          target: { mode: "existing_company", companyId: "11111111-1111-4111-8111-111111111111" },
          collisionStrategy: "replace",
        });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain("does not allow replace");
      expect(getByIdCalls).toEqual([["agent-1"]]);
      expect(previewImportCalls).toHaveLength(0);
    } finally {
      mockAgentService.getById = originalGetById;
      mockCompanyPortabilityService.previewImport = originalPreviewImport;
    }
  });

  it("keeps global import preview routes board-only", async () => {
    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "11111111-1111-4111-8111-111111111111",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .post("/api/companies/import/preview")
      .send({
        source: { type: "inline", files: { "COMPANY.md": "---\nname: Test\n---\n" } },
        include: { company: true, agents: true, projects: false, issues: false },
        target: { mode: "existing_company", companyId: "11111111-1111-4111-8111-111111111111" },
        collisionStrategy: "rename",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Board access required");
  });

  it("requires instance admin for new-company import preview", async () => {
    const app = createApp({
      type: "board",
      userId: "user-1",
      companyIds: ["11111111-1111-4111-8111-111111111111"],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post("/api/companies/import/preview")
      .send({
        source: { type: "inline", files: { "COMPANY.md": "---\nname: Test\n---\n" } },
        include: { company: true, agents: true, projects: false, issues: false },
        target: { mode: "new_company", newCompanyName: "Imported Test" },
        collisionStrategy: "rename",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Instance admin");
    expect(mockCompanyPortabilityService.previewImport).not.toHaveBeenCalled();
  });

  it("requires instance admin for new-company import apply", async () => {
    const app = createApp({
      type: "board",
      userId: "user-1",
      companyIds: ["11111111-1111-4111-8111-111111111111"],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post("/api/companies/import")
      .send({
        source: { type: "inline", files: { "COMPANY.md": "---\nname: Test\n---\n" } },
        include: { company: true, agents: true, projects: false, issues: false },
        target: { mode: "new_company", newCompanyName: "Imported Test" },
        collisionStrategy: "rename",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Instance admin");
    expect(mockCompanyPortabilityService.importBundle).not.toHaveBeenCalled();
  });
});
