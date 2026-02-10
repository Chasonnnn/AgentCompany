import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { initWorkspace } from "../src/workspace/init.js";
import { createProject } from "../src/work/projects.js";
import { createTeam } from "../src/org/teams.js";
import { createAgent } from "../src/org/agents.js";
import { createTaskFile, addTaskMilestone } from "../src/work/tasks.js";
import { createRun } from "../src/runtime/run.js";
import { executeCommandRun } from "../src/runtime/execute_command.js";
import { setRepoRoot } from "../src/machine/machine.js";
import { readYamlFile } from "../src/store/yaml.js";
import { RunYaml } from "../src/schemas/run.js";

const execFileP = promisify(execFile);

async function mkTmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function git(repoDir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", args, { cwd: repoDir });
  return stdout;
}

async function readJsonl(filePath: string): Promise<any[]> {
  const s = await fs.readFile(filePath, { encoding: "utf8" });
  const lines = s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.map((l) => JSON.parse(l));
}

describe("worktree isolation", () => {
  test("coding milestone runs default to task worktree isolation", async () => {
    const workspaceDir = await mkTmpDir("agentcompany-");
    const repoDir = await mkTmpDir("ac-repo-");

    await git(repoDir, ["init"]);
    await git(repoDir, ["config", "user.email", "test@example.com"]);
    await git(repoDir, ["config", "user.name", "Test"]);
    await fs.writeFile(path.join(repoDir, "a.txt"), "one\n", { encoding: "utf8" });
    await git(repoDir, ["add", "a.txt"]);
    await git(repoDir, ["commit", "-m", "init"]);

    await initWorkspace({ root_dir: workspaceDir, company_name: "Acme" });
    await setRepoRoot(workspaceDir, "repo_test", repoDir);

    const { team_id } = await createTeam({ workspace_dir: workspaceDir, name: "Payments" });
    const { agent_id } = await createAgent({
      workspace_dir: workspaceDir,
      name: "Worker",
      role: "worker",
      provider: "cmd",
      team_id
    });
    const { project_id } = await createProject({ workspace_dir: workspaceDir, name: "Proj" });
    const task = await createTaskFile({
      workspace_dir: workspaceDir,
      project_id,
      title: "Implement feature",
      visibility: "team",
      team_id,
      assignee_agent_id: agent_id
    });
    const ms = await addTaskMilestone({
      workspace_dir: workspaceDir,
      project_id,
      task_id: task.task_id,
      milestone: {
        title: "Code it",
        kind: "coding",
        status: "ready",
        acceptance_criteria: ["Write output file"]
      }
    });
    const run = await createRun({
      workspace_dir: workspaceDir,
      project_id,
      agent_id,
      provider: "cmd"
    });

    const res = await executeCommandRun({
      workspace_dir: workspaceDir,
      project_id,
      run_id: run.run_id,
      argv: [process.execPath, "-e", "require('node:fs').writeFileSync('from_run.txt','ok\\n');"],
      repo_id: "repo_test",
      task_id: task.task_id,
      milestone_id: ms.milestone_id
    });
    expect(res.exit_code).toBe(0);

    const runYamlPath = path.join(workspaceDir, "work/projects", project_id, "runs", run.run_id, "run.yaml");
    const runDoc = RunYaml.parse(await readYamlFile(runYamlPath));
    expect(runDoc.spec?.worktree_relpath).toBeDefined();
    expect(runDoc.spec?.worktree_branch).toMatch(/^ac\//);

    const worktreeAbs = path.join(workspaceDir, runDoc.spec!.worktree_relpath!);
    const worktreeFile = path.join(worktreeAbs, "from_run.txt");
    await fs.access(worktreeFile);

    const rootFile = path.join(repoDir, "from_run.txt");
    await expect(fs.access(rootFile)).rejects.toThrow();

    const status = (await git(repoDir, ["status", "--porcelain=v1"])).trim();
    expect(status).toBe("");

    const eventsPath = path.join(workspaceDir, "work/projects", project_id, "runs", run.run_id, "events.jsonl");
    const evs = await readJsonl(eventsPath);
    expect(evs.some((e) => e.type === "worktree.prepared")).toBe(true);
  });
});

