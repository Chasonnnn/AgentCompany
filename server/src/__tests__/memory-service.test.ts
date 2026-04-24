import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { memoryService } from "../services/memory.js";

type TestAgent = {
  id: string;
  companyId: string;
  name: string;
  adapterConfig: Record<string, unknown>;
};

async function makeTempDir(prefix: string) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function makeAgent(adapterConfig: Record<string, unknown> = {}): TestAgent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Agent 1",
    adapterConfig,
  };
}

describe("memory service", () => {
  const originalPaperclipHome = process.env.PAPERCLIP_HOME;
  const originalPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    if (originalPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = originalPaperclipHome;
    if (originalPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = originalPaperclipInstanceId;

    await Promise.all([...cleanupDirs].map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
      cleanupDirs.delete(dir);
    }));
  });

  async function setupHome() {
    const paperclipHome = await makeTempDir("paperclip-memory-home-");
    cleanupDirs.add(paperclipHome);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";
    return paperclipHome;
  }

  it("creates agent memory defaults and reports hot memory health", async () => {
    const paperclipHome = await setupHome();
    const svc = memoryService();
    const overview = await svc.getAgentMemory(makeAgent());

    expect(overview.status).toBe("ok");
    expect(overview.files.map((file) => file.path)).toContain("hot/MEMORY.md");
    await expect(fs.readFile(path.join(
      paperclipHome,
      "instances",
      "test-instance",
      "companies",
      "company-1",
      "agents",
      "agent-1",
      "memory",
      "index.md",
    ), "utf8")).resolves.toContain("Agent memory");
  });

  it("rejects traversal and hot memory writes over the hard limit", async () => {
    await setupHome();
    const svc = memoryService();
    const agent = makeAgent();

    await expect(svc.readAgentMemoryFile(agent, "../outside.md")).rejects.toThrow(/stay within/);
    await expect(
      svc.writeAgentMemoryFile(agent, "hot/MEMORY.md", "x".repeat(17 * 1024)),
    ).rejects.toThrow(/hard limit/);
  });

  it("mirrors hot memory writes to the legacy instructions bundle", async () => {
    const paperclipHome = await setupHome();
    const svc = memoryService();
    const agent = makeAgent();
    const result = await svc.writeAgentMemoryFile(agent, "hot/MEMORY.md", "# Hot\n\n- Keep this.\n");

    expect(result.adapterConfig?.instructionsFilePath).toBeTruthy();
    const mirrorPath = path.join(
      paperclipHome,
      "instances",
      "test-instance",
      "companies",
      "company-1",
      "agents",
      "agent-1",
      "instructions",
      "MEMORY.md",
    );
    await expect(fs.readFile(mirrorPath, "utf8")).resolves.toContain("Keep this.");
  });

  it("archives hot memory before migration and replaces the mirror with a compact pointer", async () => {
    const paperclipHome = await setupHome();
    const svc = memoryService();
    const agent = makeAgent();
    const written = await svc.writeAgentMemoryFile(agent, "hot/MEMORY.md", `# Big\n\n${"detail\n".repeat(2000)}`);
    const nextAgent = makeAgent(written.adapterConfig ?? {});
    const { result } = await svc.migrateAgentHotMemory(nextAgent);

    expect(result.archivePath).toMatch(/^archive\/\d{8}-\d{6}-MEMORY\.md$/);
    expect(result.oldBytes).toBeGreaterThan(result.newHotBytes);
    const root = path.join(
      paperclipHome,
      "instances",
      "test-instance",
      "companies",
      "company-1",
      "agents",
      "agent-1",
      "memory",
    );
    await expect(fs.readFile(path.join(root, result.archivePath), "utf8")).resolves.toContain("# Big");
    await expect(fs.readFile(path.join(root, "hot", "MEMORY.md"), "utf8")).resolves.toContain("Pre-migration memory archive");
  });

  it("creates company memory defaults and blocks archived writes", async () => {
    await setupHome();
    const svc = memoryService();
    const overview = await svc.getCompanyMemory("company-1");

    expect(overview.files.map((file) => file.path)).toEqual(expect.arrayContaining(["RESOLVER.md", "index.md"]));
    await expect(
      svc.writeCompanyMemoryFile("company-1", "archive/old.md", "nope"),
    ).rejects.toThrow(/immutable/);
  });
});
