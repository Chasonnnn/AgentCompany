import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockCompanySkillService = vi.hoisted(() => ({
  listGlobalCatalog: vi.fn(),
  installGlobalCatalogSkill: vi.fn(),
  importFromSource: vi.fn(),
  deleteSkill: vi.fn(),
}));

const mockAgentSkillService = vi.hoisted(() => ({
  previewBulkSkillGrant: vi.fn(),
  applyBulkSkillGrant: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockTrackSkillImported = vi.hoisted(() => vi.fn());
const mockGetTelemetryClient = vi.hoisted(() => vi.fn());

function registerRouteMocks() {
  vi.doMock("@paperclipai/shared/telemetry", () => ({
    trackSkillImported: mockTrackSkillImported,
    trackErrorHandlerCrash: vi.fn(),
  }));

  vi.doMock("../telemetry.js", () => ({
    getTelemetryClient: mockGetTelemetryClient,
  }));

  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    agentSkillService: () => mockAgentSkillService,
    companySkillService: () => mockCompanySkillService,
    logActivity: mockLogActivity,
  }));
}

async function createApp(actor: Record<string, unknown>) {
  const [{ companySkillRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/company-skills.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", companySkillRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("company skill mutation permissions", () => {
  beforeEach(() => {
    vi.resetModules();
    registerRouteMocks();
    vi.clearAllMocks();
    mockGetTelemetryClient.mockReturnValue({ track: vi.fn() });
    mockCompanySkillService.importFromSource.mockResolvedValue({
      imported: [],
      warnings: [],
    });
    mockCompanySkillService.listGlobalCatalog.mockResolvedValue([]);
    mockCompanySkillService.installGlobalCatalogSkill.mockResolvedValue({
      id: "skill-1",
      companyId: "company-1",
      key: "local/abc123/find-skills",
      slug: "find-skills",
      name: "Find Skills",
      description: null,
      markdown: "# Find Skills",
      sourceType: "catalog",
      sourceLocator: "/Users/chason/.paperclip/skills/company-1/__catalog__/find-skills",
      sourceRef: null,
      trustLevel: "markdown_only",
      compatibility: "compatible",
      fileInventory: [],
      metadata: {
        sourceKind: "global_catalog",
        catalogKey: "global/codex/abc123/find-skills",
        catalogSourceRoot: "codex",
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockCompanySkillService.deleteSkill.mockResolvedValue({
      id: "skill-1",
      slug: "find-skills",
      name: "Find Skills",
    });
    mockAgentSkillService.previewBulkSkillGrant.mockResolvedValue({
      skillId: "skill-1",
      skillKey: "local/abc123/find-skills",
      skillName: "Find Skills",
      target: {
        kind: "department",
        departmentKey: "engineering",
        label: "Engineering",
      },
      tier: "leaders",
      mode: "add",
      matchedAgentCount: 1,
      changedAgentCount: 1,
      addCount: 1,
      removeCount: 0,
      unchangedCount: 0,
      agents: [
        {
          id: "agent-1",
          name: "CTO",
          urlKey: "cto",
          role: "cto",
          title: "Chief Technology Officer",
          currentDesiredSkills: [],
          nextDesiredSkills: ["local/abc123/find-skills"],
          change: "add",
        },
      ],
      skippedAgents: [],
      selectionFingerprint: "fingerprint-1",
    });
    mockAgentSkillService.applyBulkSkillGrant.mockResolvedValue({
      skillId: "skill-1",
      skillKey: "local/abc123/find-skills",
      skillName: "Find Skills",
      target: {
        kind: "department",
        departmentKey: "engineering",
        label: "Engineering",
      },
      tier: "leaders",
      mode: "add",
      matchedAgentCount: 1,
      changedAgentCount: 1,
      addCount: 1,
      removeCount: 0,
      unchangedCount: 0,
      appliedAgentIds: ["agent-1"],
      rollbackPerformed: false,
      rollbackErrors: [],
    });
    mockLogActivity.mockResolvedValue(undefined);
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(false);
  });

  it("allows local board operators to mutate company skills", async () => {
    const res = await request(await createApp({
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    }))
      .post("/api/companies/company-1/skills/import")
      .send({ source: "https://github.com/vercel-labs/agent-browser" });

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    expect(mockCompanySkillService.importFromSource).toHaveBeenCalledWith(
      "company-1",
      "https://github.com/vercel-labs/agent-browser",
    );
  });

  it("lists the global catalog for authorized board actors", async () => {
    mockCompanySkillService.listGlobalCatalog.mockResolvedValue([
      {
        catalogKey: "global/codex/abc123/find-skills",
        slug: "find-skills",
        name: "Find Skills",
        description: "Discover and install skills.",
        sourceRoot: "codex",
        sourcePath: "/Users/chason/.codex/skills/find-skills",
        trustLevel: "markdown_only",
        compatibility: "compatible",
        fileInventory: [{ path: "SKILL.md", kind: "skill" }],
        installedSkillId: null,
        installedSkillKey: null,
      },
    ]);

    const res = await request(await createApp({
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    }))
      .get("/api/companies/company-1/skills/global-catalog");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockCompanySkillService.listGlobalCatalog).toHaveBeenCalledWith("company-1");
  });

  it("installs a global catalog skill for authorized board actors", async () => {
    const res = await request(await createApp({
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    }))
      .post("/api/companies/company-1/skills/install-global")
      .send({ catalogKey: "global/codex/abc123/find-skills" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockCompanySkillService.installGlobalCatalogSkill).toHaveBeenCalledWith("company-1", {
      catalogKey: "global/codex/abc123/find-skills",
    });
  });

  it("previews a bulk skill grant for board actors", async () => {
    const res = await request(await createApp({
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    }))
      .post("/api/companies/company-1/skills/skill-1/bulk-preview")
      .send({
        target: { kind: "department", departmentKey: "engineering" },
        tier: "leaders",
        mode: "add",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentSkillService.previewBulkSkillGrant).toHaveBeenCalledWith("company-1", "skill-1", {
      target: { kind: "department", departmentKey: "engineering" },
      tier: "leaders",
      mode: "add",
    });
  });

  it("applies a bulk skill grant for board actors", async () => {
    const res = await request(await createApp({
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    }))
      .post("/api/companies/company-1/skills/skill-1/bulk-apply")
      .send({
        target: { kind: "department", departmentKey: "engineering" },
        tier: "leaders",
        mode: "add",
        selectionFingerprint: "fingerprint-1",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentSkillService.applyBulkSkillGrant).toHaveBeenCalledWith(
      "company-1",
      "skill-1",
      {
        target: { kind: "department", departmentKey: "engineering" },
        tier: "leaders",
        mode: "add",
        selectionFingerprint: "fingerprint-1",
      },
      {
        actorType: "user",
        actorId: "local-board",
        agentId: null,
        runId: null,
      },
    );
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "company.skill_bulk_grant_applied",
      entityId: "skill-1",
    }));
  });

  it("tracks public GitHub skill imports with an explicit skill reference", async () => {
    mockCompanySkillService.importFromSource.mockResolvedValue({
      imported: [
        {
          id: "skill-1",
          companyId: "company-1",
          key: "vercel-labs/agent-browser/find-skills",
          slug: "find-skills",
          name: "Find Skills",
          description: null,
          markdown: "# Find Skills",
          sourceType: "github",
          sourceLocator: "https://github.com/vercel-labs/agent-browser",
          sourceRef: null,
          trustLevel: "markdown_only",
          compatibility: "compatible",
          fileInventory: [],
          metadata: {
            hostname: "github.com",
            owner: "vercel-labs",
            repo: "agent-browser",
          },
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      warnings: [],
    });

    const res = await request(await createApp({
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    }))
      .post("/api/companies/company-1/skills/import")
      .send({ source: "https://github.com/vercel-labs/agent-browser" });

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    expect(mockTrackSkillImported).toHaveBeenCalledWith(expect.anything(), {
      sourceType: "github",
      skillRef: "vercel-labs/agent-browser/find-skills",
    });
  });

  it("does not expose a skill reference for non-public skill imports", async () => {
    mockCompanySkillService.importFromSource.mockResolvedValue({
      imported: [
        {
          id: "skill-1",
          companyId: "company-1",
          key: "private-skill",
          slug: "private-skill",
          name: "Private Skill",
          description: null,
          markdown: "# Private Skill",
          sourceType: "github",
          sourceLocator: "https://ghe.example.com/acme/private-skill",
          sourceRef: null,
          trustLevel: "markdown_only",
          compatibility: "compatible",
          fileInventory: [],
          metadata: {
            hostname: "ghe.example.com",
            owner: "acme",
            repo: "private-skill",
          },
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      warnings: [],
    });

    const res = await request(await createApp({
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    }))
      .post("/api/companies/company-1/skills/import")
      .send({ source: "https://ghe.example.com/acme/private-skill" });

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    expect(mockTrackSkillImported).toHaveBeenCalledWith(expect.anything(), {
      sourceType: "github",
      skillRef: null,
    });
  });

  it("does not expose a skill reference when GitHub metadata is missing", async () => {
    mockCompanySkillService.importFromSource.mockResolvedValue({
      imported: [
        {
          id: "skill-1",
          companyId: "company-1",
          key: "unknown/private-skill",
          slug: "private-skill",
          name: "Private Skill",
          description: null,
          markdown: "# Private Skill",
          sourceType: "github",
          sourceLocator: "https://github.com/acme/private-skill",
          sourceRef: null,
          trustLevel: "markdown_only",
          compatibility: "compatible",
          fileInventory: [],
          metadata: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      warnings: [],
    });

    const res = await request(await createApp({
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    }))
      .post("/api/companies/company-1/skills/import")
      .send({ source: "https://github.com/acme/private-skill" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockTrackSkillImported).toHaveBeenCalledWith(expect.anything(), {
      sourceType: "github",
      skillRef: null,
    });
  });

  it("blocks same-company agents without management permission from mutating company skills", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      permissions: {},
    });

    const res = await request(await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-1",
    }))
      .post("/api/companies/company-1/skills/import")
      .send({ source: "https://github.com/vercel-labs/agent-browser" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mockCompanySkillService.importFromSource).not.toHaveBeenCalled();
  });

  it("blocks same-company agents without management permission from browsing the global catalog", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      permissions: {},
    });

    const res = await request(await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-1",
    }))
      .get("/api/companies/company-1/skills/global-catalog");

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mockCompanySkillService.listGlobalCatalog).not.toHaveBeenCalled();
  });

  it("blocks same-company agents without management permission from installing a global catalog skill", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      permissions: {},
    });

    const res = await request(await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-1",
    }))
      .post("/api/companies/company-1/skills/install-global")
      .send({ catalogKey: "global/codex/abc123/find-skills" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mockCompanySkillService.installGlobalCatalogSkill).not.toHaveBeenCalled();
  });

  it("blocks agents from previewing bulk skill grants", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      permissions: { canCreateAgents: true },
    });

    const res = await request(await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-1",
    }))
      .post("/api/companies/company-1/skills/skill-1/bulk-preview")
      .send({
        target: { kind: "department", departmentKey: "engineering" },
        tier: "leaders",
        mode: "add",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mockAgentSkillService.previewBulkSkillGrant).not.toHaveBeenCalled();
  });

  it("allows agents with canCreateAgents to mutate company skills", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      permissions: { canCreateAgents: true },
    });

    const res = await request(await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-1",
    }))
      .post("/api/companies/company-1/skills/import")
      .send({ source: "https://github.com/vercel-labs/agent-browser" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockCompanySkillService.importFromSource).toHaveBeenCalledWith(
      "company-1",
      "https://github.com/vercel-labs/agent-browser",
    );
  });

  it("returns a blocking error when attempting to delete a skill still used by agents", async () => {
    const { unprocessable } = await import("../errors.js");
    mockCompanySkillService.deleteSkill.mockImplementationOnce(async () => {
      throw unprocessable(
        'Cannot delete skill "Find Skills" while it is still used by Builder, Reviewer. Detach it from those agents first.',
      );
    });

    const res = await request(await createApp({
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    }))
      .delete("/api/companies/company-1/skills/skill-1");

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body).toEqual({
      error: 'Cannot delete skill "Find Skills" while it is still used by Builder, Reviewer. Detach it from those agents first.',
    });
    expect(mockCompanySkillService.deleteSkill).toHaveBeenCalledWith("company-1", "skill-1");
    expect(mockLogActivity).not.toHaveBeenCalled();
  });
});
