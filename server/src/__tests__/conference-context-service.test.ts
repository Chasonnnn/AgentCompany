import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { inspectGitSnapshot } from "../services/conference-context.ts";

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[]) {
  await execFileAsync("git", ["-C", cwd, ...args], { cwd });
}

async function createTempRepo() {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-conference-context-"));
  await runGit(repoRoot, ["init"]);
  await runGit(repoRoot, ["config", "user.name", "Paperclip Test"]);
  await runGit(repoRoot, ["config", "user.email", "test@paperclip.local"]);
  await fs.writeFile(path.join(repoRoot, "README.md"), "# Test repo\n", "utf8");
  await runGit(repoRoot, ["add", "README.md"]);
  await runGit(repoRoot, ["commit", "-m", "Initial commit"]);
  await runGit(repoRoot, ["branch", "-M", "main"]);
  return repoRoot;
}

describe("inspectGitSnapshot", () => {
  const tempDirs = new Set<string>();

  afterEach(async () => {
    for (const dir of tempDirs) {
      await fs.rm(dir, { recursive: true, force: true });
    }
    tempDirs.clear();
  });

  it("parses repo-relative rename and untracked entries from git porcelain", async () => {
    const repoRoot = await createTempRepo();
    tempDirs.add(repoRoot);

    await fs.writeFile(path.join(repoRoot, "old-name.txt"), "before\n", "utf8");
    await runGit(repoRoot, ["add", "old-name.txt"]);
    await runGit(repoRoot, ["commit", "-m", "Add rename target"]);
    await runGit(repoRoot, ["mv", "old-name.txt", "new-name.txt"]);
    await fs.writeFile(path.join(repoRoot, "scratch.txt"), "untracked\n", "utf8");

    const result = await inspectGitSnapshot({
      workspacePath: repoRoot,
      baseRef: "main",
    });
    const resolvedRepoRoot = await fs.realpath(repoRoot);

    expect(result.isMergedIntoBase).toBe(true);
    expect(result.snapshot).not.toBeNull();
    expect(result.snapshot?.rootPath).toBe(resolvedRepoRoot);
    expect(result.snapshot?.displayWorkspacePath).toBe(path.basename(repoRoot));
    expect(result.snapshot?.changedFileCount).toBe(2);
    expect(result.snapshot?.dirtyEntryCount).toBe(1);
    expect(result.snapshot?.untrackedEntryCount).toBe(1);
    expect(result.snapshot?.aheadCount).toBe(0);
    expect(result.snapshot?.behindCount).toBe(0);
    expect(result.snapshot?.changedFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "new-name.txt",
          previousPath: "old-name.txt",
          indexStatus: "R",
          worktreeStatus: " ",
          status: "R ",
        }),
        expect.objectContaining({
          path: "scratch.txt",
          previousPath: null,
          indexStatus: "?",
          worktreeStatus: "?",
          status: "??",
        }),
      ]),
    );
  });

  it("caps changed files and marks the snapshot as truncated", async () => {
    const repoRoot = await createTempRepo();
    tempDirs.add(repoRoot);

    for (let index = 0; index < 5; index += 1) {
      await fs.writeFile(path.join(repoRoot, `file-${index}.txt`), `file ${index}\n`, "utf8");
    }

    const result = await inspectGitSnapshot({
      workspacePath: repoRoot,
      baseRef: "main",
      maxFiles: 3,
    });

    expect(result.snapshot).not.toBeNull();
    expect(result.snapshot?.changedFileCount).toBe(5);
    expect(result.snapshot?.changedFiles).toHaveLength(3);
    expect(result.snapshot?.truncated).toBe(true);
    for (const file of result.snapshot?.changedFiles ?? []) {
      expect(file.path.startsWith("/")).toBe(false);
    }
  });
});
