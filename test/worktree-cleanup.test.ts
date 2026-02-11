import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { initWorkspace } from "../src/workspace/init.js";
import { createProject } from "../src/work/projects.js";
import { createTeam } from "../src/org/teams.js";
import { createAgent } from "../src/org/agents.js";
import { createRun } from "../src/runtime/run.js";
import { cleanupWorktrees } from "../src/runtime/worktree_cleanup.js";
import { readYamlFile, writeYamlFile } from "../src/store/yaml.js";
import { RunYaml } from "../src/schemas/run.js";

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-"));
}

async function setupEndedRunWithWorktree(dir: string): Promise<{
  project_id: string;
  run_id: string;
  worktree_relpath: string;
  worktree_abs: string;
}> {
  await initWorkspace({ root_dir: dir, company_name: "Acme" });
  const { team_id } = await createTeam({ workspace_dir: dir, name: "Payments" });
  const { agent_id } = await createAgent({
    workspace_dir: dir,
    name: "Worker",
    role: "worker",
    provider: "cmd",
    team_id
  });
  const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });
  const { run_id } = await createRun({ workspace_dir: dir, project_id, agent_id, provider: "cmd" });

  const worktree_relpath = path.join(".local", "worktrees", project_id, "task_demo", run_id);
  const worktree_abs = path.join(dir, worktree_relpath);
  await fs.mkdir(worktree_abs, { recursive: true });
  await fs.writeFile(path.join(worktree_abs, "note.txt"), "hello\n", { encoding: "utf8" });

  const runYamlPath = path.join(dir, "work/projects", project_id, "runs", run_id, "run.yaml");
  const runDoc = RunYaml.parse(await readYamlFile(runYamlPath));
  await writeYamlFile(runYamlPath, {
    ...runDoc,
    status: "ended",
    ended_at: new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString(),
    spec: {
      kind: "command",
      argv: ["echo", "ok"],
      worktree_relpath
    }
  });

  return { project_id, run_id, worktree_relpath, worktree_abs };
}

describe("worktree cleanup", () => {
  test("removes terminal-run worktrees older than retention threshold", async () => {
    const dir = await mkTmpDir();
    const setup = await setupEndedRunWithWorktree(dir);

    const res = await cleanupWorktrees({
      workspace_dir: dir,
      max_age_hours: 1,
      dry_run: false
    });
    expect(res.eligible).toBe(1);
    expect(res.removed).toBe(1);
    expect(res.items.some((i) => i.run_id === setup.run_id && i.action === "removed")).toBe(true);
    await expect(fs.access(setup.worktree_abs)).rejects.toThrow();
  });

  test("dry-run reports candidates but does not remove worktree paths", async () => {
    const dir = await mkTmpDir();
    const setup = await setupEndedRunWithWorktree(dir);

    const res = await cleanupWorktrees({
      workspace_dir: dir,
      max_age_hours: 1,
      dry_run: true
    });
    expect(res.eligible).toBe(1);
    expect(res.removed).toBe(0);
    expect(
      res.items.some(
        (i) =>
          i.run_id === setup.run_id &&
          i.action === "kept" &&
          i.reason.includes("dry-run eligible for removal")
      )
    ).toBe(true);
    await fs.access(setup.worktree_abs);
  });
});
