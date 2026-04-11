import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, companySkills, createDb } from "@paperclipai/db";
import {
  discoverProjectWorkspaceSkillDirectories,
  findMissingLocalSkillIds,
  normalizeGitHubSkillDirectory,
  parseSkillImportSourceInput,
  readLocalSkillImportFromDirectory,
  companySkillService,
} from "../services/company-skills.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const cleanupDirs = new Set<string>();
const originalHome = process.env.HOME;

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

afterEach(async () => {
  await Promise.all(Array.from(cleanupDirs, (dir) => fs.rm(dir, { recursive: true, force: true })));
  cleanupDirs.clear();
  if (originalHome) {
    process.env.HOME = originalHome;
  } else {
    delete process.env.HOME;
  }
});

async function makeTempDir(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  cleanupDirs.add(dir);
  return dir;
}

async function writeSkillDir(skillDir: string, name: string) {
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), `---\nname: ${name}\n---\n\n# ${name}\n`, "utf8");
}

describe("company skill import source parsing", () => {
  it("parses a skills.sh command without executing shell input", () => {
    const parsed = parseSkillImportSourceInput(
      "npx skills add https://github.com/vercel-labs/skills --skill find-skills",
    );

    expect(parsed.resolvedSource).toBe("https://github.com/vercel-labs/skills");
    expect(parsed.requestedSkillSlug).toBe("find-skills");
    expect(parsed.originalSkillsShUrl).toBeNull();
    expect(parsed.warnings).toEqual([]);
  });

  it("parses owner/repo/skill shorthand as skills.sh-managed", () => {
    const parsed = parseSkillImportSourceInput("vercel-labs/skills/find-skills");

    expect(parsed.resolvedSource).toBe("https://github.com/vercel-labs/skills");
    expect(parsed.requestedSkillSlug).toBe("find-skills");
    expect(parsed.originalSkillsShUrl).toBe("https://skills.sh/vercel-labs/skills/find-skills");
  });

  it("resolves skills.sh URL with org/repo/skill to GitHub repo and preserves original URL", () => {
    const parsed = parseSkillImportSourceInput(
      "https://skills.sh/google-labs-code/stitch-skills/design-md",
    );

    expect(parsed.resolvedSource).toBe("https://github.com/google-labs-code/stitch-skills");
    expect(parsed.requestedSkillSlug).toBe("design-md");
    expect(parsed.originalSkillsShUrl).toBe("https://skills.sh/google-labs-code/stitch-skills/design-md");
  });

  it("resolves skills.sh URL with org/repo (no skill) to GitHub repo and preserves original URL", () => {
    const parsed = parseSkillImportSourceInput(
      "https://skills.sh/vercel-labs/skills",
    );

    expect(parsed.resolvedSource).toBe("https://github.com/vercel-labs/skills");
    expect(parsed.requestedSkillSlug).toBeNull();
    expect(parsed.originalSkillsShUrl).toBe("https://skills.sh/vercel-labs/skills");
  });

  it("parses skills.sh commands whose requested skill differs from the folder name", () => {
    const parsed = parseSkillImportSourceInput(
      "npx skills add https://github.com/remotion-dev/skills --skill remotion-best-practices",
    );

    expect(parsed.resolvedSource).toBe("https://github.com/remotion-dev/skills");
    expect(parsed.requestedSkillSlug).toBe("remotion-best-practices");
    expect(parsed.originalSkillsShUrl).toBeNull();
  });

  it("does not set originalSkillsShUrl for owner/repo shorthand", () => {
    const parsed = parseSkillImportSourceInput("vercel-labs/skills");

    expect(parsed.resolvedSource).toBe("https://github.com/vercel-labs/skills");
    expect(parsed.originalSkillsShUrl).toBeNull();
  });
});

describe("project workspace skill discovery", () => {
  it("normalizes GitHub skill directories for blob imports and legacy metadata", () => {
    expect(normalizeGitHubSkillDirectory("retro/.", "retro")).toBe("retro");
    expect(normalizeGitHubSkillDirectory("retro/SKILL.md", "retro")).toBe("retro");
    expect(normalizeGitHubSkillDirectory("SKILL.md", "root-skill")).toBe("");
    expect(normalizeGitHubSkillDirectory("", "fallback-skill")).toBe("fallback-skill");
  });

  it("finds bounded skill roots under supported workspace paths", async () => {
    const workspace = await makeTempDir("paperclip-skill-workspace-");
    await writeSkillDir(workspace, "Workspace Root");
    await writeSkillDir(path.join(workspace, "skills", "find-skills"), "Find Skills");
    await writeSkillDir(path.join(workspace, ".agents", "skills", "release"), "Release");
    await writeSkillDir(path.join(workspace, "skills", ".system", "paperclip"), "Paperclip");
    await fs.writeFile(path.join(workspace, "README.md"), "# ignore\n", "utf8");

    const discovered = await discoverProjectWorkspaceSkillDirectories({
      projectId: "11111111-1111-1111-1111-111111111111",
      projectName: "Repo",
      workspaceId: "22222222-2222-2222-2222-222222222222",
      workspaceName: "Main",
      workspaceCwd: workspace,
    });

    expect(discovered).toEqual([
      { skillDir: path.resolve(workspace), inventoryMode: "project_root" },
      { skillDir: path.resolve(workspace, ".agents", "skills", "release"), inventoryMode: "full" },
      { skillDir: path.resolve(workspace, "skills", ".system", "paperclip"), inventoryMode: "full" },
      { skillDir: path.resolve(workspace, "skills", "find-skills"), inventoryMode: "full" },
    ]);
  });

  it("limits root SKILL.md imports to skill-related support folders", async () => {
    const workspace = await makeTempDir("paperclip-root-skill-");
    await writeSkillDir(workspace, "Workspace Skill");
    await fs.mkdir(path.join(workspace, "references"), { recursive: true });
    await fs.mkdir(path.join(workspace, "scripts"), { recursive: true });
    await fs.mkdir(path.join(workspace, "assets"), { recursive: true });
    await fs.mkdir(path.join(workspace, "src"), { recursive: true });
    await fs.writeFile(path.join(workspace, "references", "checklist.md"), "# Checklist\n", "utf8");
    await fs.writeFile(path.join(workspace, "scripts", "run.sh"), "echo ok\n", "utf8");
    await fs.writeFile(path.join(workspace, "assets", "logo.svg"), "<svg />\n", "utf8");
    await fs.writeFile(path.join(workspace, "README.md"), "# Repo\n", "utf8");
    await fs.writeFile(path.join(workspace, "src", "index.ts"), "export {};\n", "utf8");

    const imported = await readLocalSkillImportFromDirectory(
      "33333333-3333-4333-8333-333333333333",
      workspace,
      { inventoryMode: "project_root", metadata: { sourceKind: "project_scan" } },
    );

    expect(new Set(imported.fileInventory.map((entry) => entry.path))).toEqual(new Set([
      "assets/logo.svg",
      "references/checklist.md",
      "scripts/run.sh",
      "SKILL.md",
    ]));
    expect(imported.fileInventory.map((entry) => entry.kind)).toContain("script");
    expect(imported.metadata?.sourceKind).toBe("project_scan");
  });

  it("parses inline object array items in skill frontmatter metadata", async () => {
    const workspace = await makeTempDir("paperclip-inline-skill-yaml-");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(
      path.join(workspace, "SKILL.md"),
      [
        "---",
        "name: Inline Metadata Skill",
        "metadata:",
        "  sources:",
        "    - kind: github-dir",
        "      repo: paperclipai/paperclip",
        "      path: skills/paperclip",
        "---",
        "",
        "# Inline Metadata Skill",
        "",
      ].join("\n"),
      "utf8",
    );

    const imported = await readLocalSkillImportFromDirectory(
      "33333333-3333-4333-8333-333333333333",
      workspace,
      { inventoryMode: "full" },
    );

    expect(imported.metadata).toMatchObject({
      sourceKind: "local_path",
      sources: [
        {
          kind: "github-dir",
          repo: "paperclipai/paperclip",
          path: "skills/paperclip",
        },
      ],
    });
  });
});

describe("missing local skill reconciliation", () => {
  it("flags local-path skills whose directory was removed", async () => {
    const workspace = await makeTempDir("paperclip-missing-skill-dir-");
    const skillDir = path.join(workspace, "skills", "ghost");
    await writeSkillDir(skillDir, "Ghost");
    await fs.rm(skillDir, { recursive: true, force: true });

    const missingIds = await findMissingLocalSkillIds([
      {
        id: "skill-1",
        sourceType: "local_path",
        sourceLocator: skillDir,
      },
      {
        id: "skill-2",
        sourceType: "github",
        sourceLocator: "https://github.com/vercel-labs/agent-browser",
      },
    ]);

    expect(missingIds).toEqual(["skill-1"]);
  });

  it("flags local-path skills whose SKILL.md file was removed", async () => {
    const workspace = await makeTempDir("paperclip-missing-skill-file-");
    const skillDir = path.join(workspace, "skills", "ghost");
    await writeSkillDir(skillDir, "Ghost");
    await fs.rm(path.join(skillDir, "SKILL.md"), { force: true });

    const missingIds = await findMissingLocalSkillIds([
      {
        id: "skill-1",
        sourceType: "local_path",
        sourceLocator: skillDir,
      },
    ]);

    expect(missingIds).toEqual(["skill-1"]);
  });
});

describeEmbeddedPostgres("global skill catalog installs", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-skills-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "AI Workforce",
      issuePrefix: "AIWA",
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function writeGlobalSkill(rootDir: string, slug: string, markdown: string, extraFiles?: Record<string, string>) {
    const skillDir = path.join(rootDir, slug);
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), markdown, "utf8");
    for (const [relativePath, content] of Object.entries(extraFiles ?? {})) {
      const absolutePath = path.join(skillDir, relativePath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, content, "utf8");
    }
    return skillDir;
  }

  it("discovers valid skills under agents, codex, and claude roots and ignores hidden or invalid entries", async () => {
    const homeDir = await makeTempDir("paperclip-global-skill-home-");
    process.env.HOME = homeDir;
    const companyId = await seedCompany();

    await writeGlobalSkill(
      path.join(homeDir, ".agents", "skills"),
      "release",
      "---\nname: Release\n---\n\n# Release\n",
    );
    await writeGlobalSkill(
      path.join(homeDir, ".codex", "skills"),
      "design-guide",
      "---\nname: Design Guide\n---\n\n# Design Guide\n",
    );
    await writeGlobalSkill(
      path.join(homeDir, ".claude", "skills"),
      "find-skills",
      "---\nname: Find Skills\n---\n\n# Find Skills\n",
    );
    await fs.symlink(
      path.join(homeDir, ".codex", "skills", "design-guide"),
      path.join(homeDir, ".claude", "skills", "design-guide-link"),
    );
    await fs.mkdir(path.join(homeDir, ".codex", "skills", ".system"), { recursive: true });
    await writeGlobalSkill(
      path.join(homeDir, ".codex", "skills", ".system"),
      "hidden-skill",
      "---\nname: Hidden Skill\n---\n\n# Hidden Skill\n",
    );
    await fs.mkdir(path.join(homeDir, ".claude", "skills", "missing-skill"), { recursive: true });

    const catalog = await companySkillService(db).listGlobalCatalog(companyId);

    expect(catalog.map((item) => item.slug)).toEqual(["design-guide", "find-skills", "release"]);
    expect(catalog.map((item) => item.sourceRoot)).toEqual(["codex", "claude", "agents"]);
  });

  it("installs and reinstalls a global skill as a read-only company snapshot", async () => {
    const homeDir = await makeTempDir("paperclip-global-install-home-");
    process.env.HOME = homeDir;
    const companyId = await seedCompany();
    const codexRoot = path.join(homeDir, ".codex", "skills");

    await writeGlobalSkill(
      codexRoot,
      "design-guide",
      "---\nname: Design Guide\ndescription: First version\n---\n\n# Design Guide\n",
      { "references/checklist.md": "# Checklist\n" },
    );

    const svc = companySkillService(db);
    const discovered = await svc.listGlobalCatalog(companyId);
    const catalogKey = discovered[0]?.catalogKey;
    expect(catalogKey).toBeTruthy();

    const installed = await svc.installGlobalCatalogSkill(companyId, { catalogKey: catalogKey! });
    expect(installed.sourceType).toBe("catalog");
    expect(installed.metadata).toMatchObject({
      sourceKind: "global_catalog",
      catalogKey,
      catalogSourceRoot: "codex",
    });

    const firstId = installed.id;
    const firstKey = installed.key;
    expect(await fs.readFile(path.join(installed.sourceLocator!, "references/checklist.md"), "utf8")).toContain("Checklist");

    await writeGlobalSkill(
      codexRoot,
      "design-guide",
      "---\nname: Design Guide\ndescription: Updated version\n---\n\n# Design Guide\n",
      { "references/checklist.md": "# Updated Checklist\n" },
    );

    const reinstalled = await svc.installGlobalCatalogSkill(companyId, { catalogKey: catalogKey! });
    expect(reinstalled.id).toBe(firstId);
    expect(reinstalled.key).toBe(firstKey);
    expect(reinstalled.description).toBe("Updated version");

    const persistedRow = await db
      .select()
      .from(companySkills)
      .where(eq(companySkills.id, firstId))
      .then((rows) => rows[0] ?? null);
    expect(persistedRow?.sourceType).toBe("catalog");
    expect(await fs.readFile(path.join(reinstalled.sourceLocator!, "references/checklist.md"), "utf8")).toContain("Updated Checklist");
  });

  it("installs all discoverable global skills and reports already-installed and skipped entries", async () => {
    const homeDir = await makeTempDir("paperclip-global-install-all-home-");
    process.env.HOME = homeDir;
    const companyId = await seedCompany();
    const codexRoot = path.join(homeDir, ".codex", "skills");

    await writeGlobalSkill(
      codexRoot,
      "design-guide",
      "---\nname: Design Guide\n---\n\n# Design Guide\n",
    );
    await writeGlobalSkill(
      codexRoot,
      "find-skills",
      [
        "---",
        "name: Find Skills",
        "metadata:",
        "  paperclip:",
        "    key: acme/find-skills/find-skills",
        "---",
        "",
        "# Find Skills",
        "",
      ].join("\n"),
    );
    await writeGlobalSkill(
      path.join(homeDir, ".agents", "skills"),
      "release",
      "---\nname: Release\n---\n\n# Release\n",
    );

    const svc = companySkillService(db);
    const discovered = await svc.listGlobalCatalog(companyId);
    const designGuideCatalogKey = discovered.find((item) => item.slug === "design-guide")?.catalogKey;
    expect(designGuideCatalogKey).toBeTruthy();

    await svc.installGlobalCatalogSkill(companyId, { catalogKey: designGuideCatalogKey! });

    await db.insert(companySkills).values({
      id: randomUUID(),
      companyId,
      key: "acme/find-skills/find-skills",
      slug: "existing-find-skills",
      name: "Existing Skill",
      markdown: "# Existing Skill",
      sourceType: "local_path",
      sourceLocator: await writeGlobalSkill(
        path.join(homeDir, "managed-existing"),
        "existing-find-skills",
        "---\nname: Existing Skill\n---\n\n# Existing Skill\n",
      ),
      metadata: {
        sourceKind: "managed_local",
      },
    });

    const result = await svc.installAllGlobalCatalogSkills(companyId);

    expect(result.discoverableCount).toBe(3);
    expect(result.installedCount).toBe(1);
    expect(result.alreadyInstalledCount).toBe(1);
    expect(result.installed.map((skill) => skill.slug)).toEqual(["release"]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({
      name: "Find Skills",
      conflictingSkillKey: "acme/find-skills/find-skills",
    });
  });

  it("returns a conflict when a global skill key collides with a different company skill", async () => {
    const homeDir = await makeTempDir("paperclip-global-conflict-home-");
    process.env.HOME = homeDir;
    const companyId = await seedCompany();
    const codexRoot = path.join(homeDir, ".codex", "skills");

    await writeGlobalSkill(
      codexRoot,
      "find-skills",
      [
        "---",
        "name: Find Skills",
        "metadata:",
        "  paperclip:",
        "    key: acme/find-skills/find-skills",
        "---",
        "",
        "# Find Skills",
        "",
      ].join("\n"),
    );

    await db.insert(companySkills).values({
      id: randomUUID(),
      companyId,
      key: "acme/find-skills/find-skills",
      slug: "existing-find-skills",
      name: "Existing Skill",
      markdown: "# Existing Skill",
      sourceType: "local_path",
      sourceLocator: await writeGlobalSkill(
        path.join(homeDir, "managed-existing"),
        "existing-find-skills",
        "---\nname: Existing Skill\n---\n\n# Existing Skill\n",
      ),
      metadata: {
        sourceKind: "managed_local",
      },
    });

    const svc = companySkillService(db);
    const discovered = await svc.listGlobalCatalog(companyId);

    await expect(
      svc.installGlobalCatalogSkill(companyId, { catalogKey: discovered[0]!.catalogKey }),
    ).rejects.toMatchObject({
      status: 409,
    });
  });
});
