import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listPaperclipSkillEntries,
  prepareManagedAdapterHome,
  removeMaintainerOnlySkillSymlinks,
} from "@paperclipai/adapter-utils/server-utils";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("paperclip skill utils", () => {
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("lists runtime skills from ./skills without pulling in .agents/skills", async () => {
    const root = await makeTempDir("paperclip-skill-roots-");
    cleanupDirs.add(root);

    const moduleDir = path.join(root, "a", "b", "c", "d", "e");
    await fs.mkdir(moduleDir, { recursive: true });
    await fs.mkdir(path.join(root, "skills", "paperclip"), { recursive: true });
    await fs.mkdir(path.join(root, ".agents", "skills", "release"), { recursive: true });

    const entries = await listPaperclipSkillEntries(moduleDir);

    expect(entries.map((entry) => entry.key)).toEqual(["paperclipai/paperclip/paperclip"]);
    expect(entries.map((entry) => entry.runtimeName)).toEqual(["paperclip"]);
    expect(entries[0]?.source).toBe(path.join(root, "skills", "paperclip"));
  });

  it("removes stale maintainer-only symlinks from a shared skills home", async () => {
    const root = await makeTempDir("paperclip-skill-cleanup-");
    cleanupDirs.add(root);

    const skillsHome = path.join(root, "skills-home");
    const runtimeSkill = path.join(root, "skills", "paperclip");
    const customSkill = path.join(root, "custom", "release-notes");
    const staleMaintainerSkill = path.join(root, ".agents", "skills", "release");

    await fs.mkdir(skillsHome, { recursive: true });
    await fs.mkdir(runtimeSkill, { recursive: true });
    await fs.mkdir(customSkill, { recursive: true });

    await fs.symlink(runtimeSkill, path.join(skillsHome, "paperclip"));
    await fs.symlink(customSkill, path.join(skillsHome, "release-notes"));
    await fs.symlink(staleMaintainerSkill, path.join(skillsHome, "release"));

    const removed = await removeMaintainerOnlySkillSymlinks(skillsHome, ["paperclip"]);

    expect(removed).toEqual(["release"]);
    await expect(fs.lstat(path.join(skillsHome, "release"))).rejects.toThrow();
    expect((await fs.lstat(path.join(skillsHome, "paperclip"))).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(path.join(skillsHome, "release-notes"))).isSymbolicLink()).toBe(true);
  });

  it("prepares a managed adapter home without copying excluded skill directories", async () => {
    const root = await makeTempDir("paperclip-managed-home-");
    cleanupDirs.add(root);

    const sharedHome = path.join(root, "shared-home");
    const paperclipHome = path.join(root, "paperclip-home");
    await fs.mkdir(path.join(sharedHome, ".cursor", "config"), { recursive: true });
    await fs.mkdir(path.join(sharedHome, ".cursor", "skills", "rogue-skill"), { recursive: true });
    await fs.writeFile(path.join(sharedHome, ".cursor", "config", "settings.json"), "{\"theme\":\"dark\"}", "utf8");

    const managedHome = await prepareManagedAdapterHome({
      env: {
        HOME: sharedHome,
        PAPERCLIP_HOME: paperclipHome,
      },
      adapterKey: "cursor",
      companyId: "company-1",
      sharedHomeDir: sharedHome,
      logLabel: "Cursor",
      subtrees: [{ relativePath: ".cursor", excludeChildren: ["skills"] }],
    });

    expect(managedHome).toBe(
      path.join(paperclipHome, "instances", "default", "companies", "company-1", "cursor-home"),
    );
    expect((await fs.lstat(path.join(managedHome, ".cursor", "config"))).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(managedHome, ".cursor", "config", "settings.json"), "utf8")).toBe(
      "{\"theme\":\"dark\"}",
    );
    await expect(fs.lstat(path.join(managedHome, ".cursor", "skills"))).rejects.toThrow();
  });
});
