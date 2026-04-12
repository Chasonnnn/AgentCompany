import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function createMocks() {
  return {
    agentService: {
      getById: vi.fn(),
    },
    accessService: {
      canUser: vi.fn(),
      hasPermission: vi.fn(),
    },
    companySkillService: {
      listGlobalCatalog: vi.fn(),
      installGlobalCatalogSkill: vi.fn(),
      installAllGlobalCatalogSkills: vi.fn(),
      importFromSource: vi.fn(),
      deleteSkill: vi.fn(),
    },
    agentSkillService: {
      previewBulkSkillGrant: vi.fn(),
      applyBulkSkillGrant: vi.fn(),
    },
    logActivity: vi.fn(),
    trackSkillImported: vi.fn(),
    getTelemetryClient: vi.fn(),
  };
}

function applyDefaultMocks(mocks: ReturnType<typeof createMocks>) {
  mocks.getTelemetryClient.mockReturnValue({ track: vi.fn() });
  mocks.companySkillService.importFromSource.mockResolvedValue({
    imported: [],
    warnings: [],
  });
  mocks.companySkillService.listGlobalCatalog.mockResolvedValue([]);
  mocks.companySkillService.installGlobalCatalogSkill.mockResolvedValue({
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
  mocks.companySkillService.installAllGlobalCatalogSkills.mockResolvedValue({
    discoverableCount: 2,
    installedCount: 1,
    alreadyInstalledCount: 1,
    skipped: [],
    installed: [],
  });
  mocks.companySkillService.deleteSkill.mockResolvedValue({
    id: "skill-1",
    slug: "find-skills",
    name: "Find Skills",
  });
  mocks.agentSkillService.previewBulkSkillGrant.mockResolvedValue({
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
  mocks.agentSkillService.applyBulkSkillGrant.mockResolvedValue({
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
  mocks.logActivity.mockResolvedValue(undefined);
  mocks.accessService.canUser.mockResolvedValue(true);
  mocks.accessService.hasPermission.mockResolvedValue(false);
}

async function createApp(actor: Record<string, unknown>) {
  vi.unmock("../services/index.js");
  vi.unmock("../telemetry.js");
  vi.unmock("@paperclipai/shared/telemetry");
  vi.resetModules();
  const mocks = createMocks();
  applyDefaultMocks(mocks);
  const [sharedTelemetry, serverTelemetry] = await Promise.all([
    vi.importActual<typeof import("@paperclipai/shared/telemetry")>("@paperclipai/shared/telemetry"),
    vi.importActual<typeof import("../telemetry.js")>("../telemetry.js"),
  ]);
  vi.spyOn(sharedTelemetry, "trackSkillImported").mockImplementation(mocks.trackSkillImported);
  vi.spyOn(serverTelemetry, "getTelemetryClient").mockImplementation(mocks.getTelemetryClient);
  vi.doMock("../services/index.js", () => ({
    accessService: () => mocks.accessService,
    agentService: () => mocks.agentService,
    agentSkillService: () => mocks.agentSkillService,
    companySkillService: () => mocks.companySkillService,
    logActivity: mocks.logActivity,
  }));
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
  return { app, mocks, errors };
}

describe("company skill mutation permissions", () => {
  beforeEach(() => {
    vi.unmock("../services/index.js");
    vi.unmock("../telemetry.js");
    vi.unmock("@paperclipai/shared/telemetry");
    vi.resetModules();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unmock("../services/index.js");
    vi.unmock("../telemetry.js");
    vi.unmock("@paperclipai/shared/telemetry");
    vi.restoreAllMocks();
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
