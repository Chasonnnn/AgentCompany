import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  installAllGlobalCatalogSkills: vi.fn(),
  importFromSource: vi.fn(),
  deleteSkill: vi.fn(),
}));

const mockAgentSkillService = vi.hoisted(() => ({
  previewBulkSkillGrant: vi.fn(),
  applyBulkSkillGrant: vi.fn(),
  coverageAudit: vi.fn(),
  previewCoverageRepair: vi.fn(),
  applyCoverageRepair: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockTrackSkillImported = vi.hoisted(() => vi.fn());
const mockGetTelemetryClient = vi.hoisted(() => vi.fn());
const mockAgentHasCreatePermission = vi.hoisted(() =>
  vi.fn((agent: Record<string, unknown> | null | undefined) => agent?.permissions?.canCreateAgents === true),
);

function registerRouteMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    agentSkillService: () => mockAgentSkillService,
    companySkillService: () => mockCompanySkillService,
    logActivity: mockLogActivity,
  }));

  vi.doMock("../services/agent-permissions.js", () => ({
    agentHasCreatePermission: mockAgentHasCreatePermission,
  }));

  vi.doMock("@paperclipai/shared/telemetry", () => ({
    trackSkillImported: mockTrackSkillImported,
  }));

  vi.doMock("../telemetry.js", () => ({
    getTelemetryClient: mockGetTelemetryClient,
  }));
}

function testMocks() {
  return {
    agentService: mockAgentService,
    accessService: mockAccessService,
    companySkillService: mockCompanySkillService,
    agentSkillService: mockAgentSkillService,
    logActivity: mockLogActivity,
    trackSkillImported: mockTrackSkillImported,
    getTelemetryClient: mockGetTelemetryClient,
    agentHasCreatePermission: mockAgentHasCreatePermission,
  };
}

function applyDefaultMocks() {
  mockGetTelemetryClient.mockReturnValue({ track: vi.fn() });
  mockAgentHasCreatePermission.mockImplementation(
    (agent: Record<string, unknown> | null | undefined) => agent?.permissions?.canCreateAgents === true,
  );
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
  mockCompanySkillService.installAllGlobalCatalogSkills.mockResolvedValue({
    discoverableCount: 2,
    installedCount: 1,
    alreadyInstalledCount: 1,
    skipped: [],
    installed: [],
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
  mockAgentSkillService.coverageAudit.mockResolvedValue({
    companyId: "company-1",
    auditedAgentCount: 2,
    coveredCount: 1,
    repairableGapCount: 1,
    nonrepairableGapCount: 0,
    customizedCount: 0,
    plannedImports: [],
    agents: [],
  });
  mockAgentSkillService.previewCoverageRepair.mockResolvedValue({
    companyId: "company-1",
    auditedAgentCount: 2,
    coveredCount: 1,
    repairableGapCount: 1,
    nonrepairableGapCount: 0,
    customizedCount: 0,
    plannedImports: [],
    agents: [],
    changedAgentCount: 1,
    selectionFingerprint: "coverage-fingerprint-1",
  });
  mockAgentSkillService.applyCoverageRepair.mockResolvedValue({
    companyId: "company-1",
    changedAgentCount: 1,
    appliedAgentIds: ["agent-1"],
    importedSkills: [],
    rollbackPerformed: false,
    rollbackErrors: [],
    selectionFingerprint: "coverage-fingerprint-1",
    audit: {
      companyId: "company-1",
      auditedAgentCount: 2,
      coveredCount: 2,
      repairableGapCount: 0,
      nonrepairableGapCount: 0,
      customizedCount: 0,
      plannedImports: [],
      agents: [],
    },
  });
  mockLogActivity.mockResolvedValue(undefined);
  mockAccessService.canUser.mockResolvedValue(true);
  mockAccessService.hasPermission.mockResolvedValue(false);
}

async function createApp(actor: Record<string, unknown>) {
  vi.resetModules();
  vi.doUnmock("../routes/company-skills.js");
  vi.doUnmock("../middleware/index.js");
  vi.doUnmock("../errors.js");
  registerRouteMocks();
  applyDefaultMocks();
  const [{ companySkillRoutes }, { errorHandler }, errors] = await Promise.all([
    import("../routes/company-skills.js"),
    import("../middleware/index.js"),
    import("../errors.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", companySkillRoutes({} as any));
  app.use(errorHandler);
  return { app, mocks: testMocks(), errors };
}

describe("company skill mutation permissions", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    vi.resetAllMocks();
    vi.doUnmock("../routes/company-skills.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../errors.js");
    applyDefaultMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.doUnmock("../routes/company-skills.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../errors.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/agent-permissions.js");
    vi.doUnmock("@paperclipai/shared/telemetry");
    vi.doUnmock("../telemetry.js");
  });

  it("allows local board operators to mutate company skills", async () => {
    const { app, mocks } = await createApp({
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    });
    const res = await request(app)
      .post("/api/companies/company-1/skills/import")
      .send({ source: "https://github.com/vercel-labs/agent-browser" });

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    expect(mocks.companySkillService.importFromSource).toHaveBeenCalledWith(
      "company-1",
      "https://github.com/vercel-labs/agent-browser",
    );
  });

  it("lists the global catalog for authorized board actors", async () => {
    const { app, mocks } = await createApp({
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    });
    mocks.companySkillService.listGlobalCatalog.mockResolvedValue([
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

    const res = await request(app).get("/api/companies/company-1/skills/global-catalog");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mocks.companySkillService.listGlobalCatalog).toHaveBeenCalledWith("company-1");
  });

  it("installs a global catalog skill for authorized board actors", async () => {
    const { app, mocks } = await createApp({
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    });
    const res = await request(app)
      .post("/api/companies/company-1/skills/install-global")
      .send({ catalogKey: "global/codex/abc123/find-skills" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mocks.companySkillService.installGlobalCatalogSkill).toHaveBeenCalledWith("company-1", {
      catalogKey: "global/codex/abc123/find-skills",
    });
  });

  it("installs all discoverable global catalog skills for authorized board actors", async () => {
    const { app, mocks } = await createApp({
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    });
    const res = await request(app)
      .post("/api/companies/company-1/skills/install-global-all")
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mocks.companySkillService.installAllGlobalCatalogSkills).toHaveBeenCalledWith("company-1");
  });

  it("returns the company skill coverage audit", async () => {
    const { app, mocks } = await createApp({
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    });

    const res = await request(app).get("/api/companies/company-1/skills/coverage-audit");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mocks.agentSkillService.coverageAudit).toHaveBeenCalledWith("company-1");
  });

  it("previews a company skill coverage repair", async () => {
    const { app, mocks } = await createApp({
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post("/api/companies/company-1/skills/coverage-audit/repair-preview")
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mocks.agentSkillService.previewCoverageRepair).toHaveBeenCalledWith("company-1");
  });

  it("applies a company skill coverage repair", async () => {
    const { app, mocks } = await createApp({
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post("/api/companies/company-1/skills/coverage-audit/repair-apply")
      .send({ selectionFingerprint: "coverage-fingerprint-1" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mocks.agentSkillService.applyCoverageRepair).toHaveBeenCalledWith(
      "company-1",
      { selectionFingerprint: "coverage-fingerprint-1" },
      {
        actorType: "user",
        actorId: "local-board",
        agentId: null,
        runId: null,
      },
    );
    expect(mocks.logActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "company.skill_coverage_repair_applied",
      entityId: "company-1",
    }));
  });

  it("previews a bulk skill grant for board actors", async () => {
    const { app, mocks } = await createApp({
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    });
    const res = await request(app)
      .post("/api/companies/company-1/skills/skill-1/bulk-preview")
      .send({
        target: { kind: "department", departmentKey: "engineering" },
        tier: "leaders",
        mode: "add",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mocks.agentSkillService.previewBulkSkillGrant).toHaveBeenCalledWith("company-1", "skill-1", {
      target: { kind: "department", departmentKey: "engineering" },
      tier: "leaders",
      mode: "add",
    });
  });

  it("applies a bulk skill grant for board actors", async () => {
    const { app, mocks } = await createApp({
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    });
    const res = await request(app)
      .post("/api/companies/company-1/skills/skill-1/bulk-apply")
      .send({
        target: { kind: "department", departmentKey: "engineering" },
        tier: "leaders",
        mode: "add",
        selectionFingerprint: "fingerprint-1",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mocks.agentSkillService.applyBulkSkillGrant).toHaveBeenCalledWith(
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
    expect(mocks.logActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "company.skill_bulk_grant_applied",
      entityId: "skill-1",
    }));
  });

  it("tracks public GitHub skill imports with an explicit skill reference", async () => {
    const { app, mocks } = await createApp({
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    });
    mocks.companySkillService.importFromSource.mockResolvedValue({
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

    const res = await request(app)
      .post("/api/companies/company-1/skills/import")
      .send({ source: "https://github.com/vercel-labs/agent-browser" });

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    expect(mocks.trackSkillImported).toHaveBeenCalledWith(expect.anything(), {
      sourceType: "github",
      skillRef: "vercel-labs/agent-browser/find-skills",
    });
  });

  it("does not expose a skill reference for non-public skill imports", async () => {
    const { app, mocks } = await createApp({
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    });
    mocks.companySkillService.importFromSource.mockResolvedValue({
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

    const res = await request(app)
      .post("/api/companies/company-1/skills/import")
      .send({ source: "https://ghe.example.com/acme/private-skill" });

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    expect(mocks.trackSkillImported).toHaveBeenCalledWith(expect.anything(), {
      sourceType: "github",
      skillRef: null,
    });
  });

  it("does not expose a skill reference when GitHub metadata is missing", async () => {
    const { app, mocks } = await createApp({
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    });
    mocks.companySkillService.importFromSource.mockResolvedValue({
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

    const res = await request(app)
      .post("/api/companies/company-1/skills/import")
      .send({ source: "https://github.com/acme/private-skill" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mocks.trackSkillImported).toHaveBeenCalledWith(expect.anything(), {
      sourceType: "github",
      skillRef: null,
    });
  });

  it("blocks same-company agents without management permission from mutating company skills", async () => {
    const { app, mocks } = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-1",
    });
    mocks.agentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      permissions: {},
    });

    const res = await request(app)
      .post("/api/companies/company-1/skills/import")
      .send({ source: "https://github.com/vercel-labs/agent-browser" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mocks.companySkillService.importFromSource).not.toHaveBeenCalled();
  });

  it("blocks same-company agents without management permission from browsing the global catalog", async () => {
    const { app, mocks } = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-1",
    });
    mocks.agentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      permissions: {},
    });

    const res = await request(app).get("/api/companies/company-1/skills/global-catalog");

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mocks.companySkillService.listGlobalCatalog).not.toHaveBeenCalled();
  });

  it("blocks same-company agents without management permission from installing a global catalog skill", async () => {
    const { app, mocks } = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-1",
    });
    mocks.agentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      permissions: {},
    });

    const res = await request(app)
      .post("/api/companies/company-1/skills/install-global")
      .send({ catalogKey: "global/codex/abc123/find-skills" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mocks.companySkillService.installGlobalCatalogSkill).not.toHaveBeenCalled();
  });

  it("blocks agents from previewing bulk skill grants", async () => {
    const { app, mocks } = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-1",
    });
    mocks.agentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      permissions: { canCreateAgents: true },
    });

    const res = await request(app)
      .post("/api/companies/company-1/skills/skill-1/bulk-preview")
      .send({
        target: { kind: "department", departmentKey: "engineering" },
        tier: "leaders",
        mode: "add",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mocks.agentSkillService.previewBulkSkillGrant).not.toHaveBeenCalled();
  });

  it("allows agents with canCreateAgents to mutate company skills", async () => {
    const { app, mocks } = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-1",
    });
    mocks.agentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      permissions: { canCreateAgents: true },
    });

    const res = await request(app)
      .post("/api/companies/company-1/skills/import")
      .send({ source: "https://github.com/vercel-labs/agent-browser" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mocks.companySkillService.importFromSource).toHaveBeenCalledWith(
      "company-1",
      "https://github.com/vercel-labs/agent-browser",
    );
  });

  it("returns a blocking error when attempting to delete a skill still used by agents", async () => {
    const { app, mocks, errors } = await createApp({
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    });
    mocks.companySkillService.deleteSkill.mockImplementationOnce(async () => {
      throw errors.unprocessable(
        'Cannot delete skill "Find Skills" while it is still used by Builder, Reviewer. Detach it from those agents first.',
      );
    });

    const res = await request(app).delete("/api/companies/company-1/skills/skill-1");

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body).toEqual({
      error: 'Cannot delete skill "Find Skills" while it is still used by Builder, Reviewer. Detach it from those agents first.',
    });
    expect(mocks.companySkillService.deleteSkill).toHaveBeenCalledWith("company-1", "skill-1");
    expect(mocks.logActivity).not.toHaveBeenCalled();
  });
});
