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
import { createRun } from "../src/runtime/run.js";
import { executeCommandRun } from "../src/runtime/execute_command.js";
import { setRepoRoot } from "../src/machine/machine.js";
import { readYamlFile } from "../src/store/yaml.js";
import { ContextPackManifestYaml } from "../src/schemas/context_pack.js";

const execFileP = promisify(execFile);

async function mkTmpDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return dir;
}

async function git(repoDir: string, args: string[]): Promise<void> {
  await execFileP("git", args, { cwd: repoDir });
}

describe("context pack repo snapshot", () => {
  test("executeCommandRun writes repo_snapshot and dirty patch artifact when repo is dirty", async () => {
    const workspaceDir = await mkTmpDir("agentcompany-");
    const repoDir = await mkTmpDir("ac-repo-");

    await git(repoDir, ["init"]);
    await git(repoDir, ["config", "user.email", "test@example.com"]);
    await git(repoDir, ["config", "user.name", "Test"]);
    await fs.writeFile(path.join(repoDir, "a.txt"), "one\n", { encoding: "utf8" });
    await git(repoDir, ["add", "a.txt"]);
    await git(repoDir, ["commit", "-m", "init"]);
    // Make repo dirty.
    await fs.writeFile(path.join(repoDir, "a.txt"), "one\ntwo\n", { encoding: "utf8" });

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
    const { run_id, context_pack_id } = await createRun({
      workspace_dir: workspaceDir,
      project_id,
      agent_id,
      provider: "cmd"
    });

    const res = await executeCommandRun({
      workspace_dir: workspaceDir,
      project_id,
      run_id,
      argv: [process.execPath, "-e", "console.log('hello')"],
      repo_id: "repo_test"
    });
    expect(res.exit_code).toBe(0);

    const manifestPath = path.join(
      workspaceDir,
      "work/projects",
      project_id,
      "context_packs",
      context_pack_id,
      "manifest.yaml"
    );
    const manifest = ContextPackManifestYaml.parse(await readYamlFile(manifestPath));
    expect(manifest.repo_snapshot?.repo_id).toBe("repo_test");
    expect(manifest.repo_snapshot?.head_sha).toMatch(/[0-9a-f]{7,40}/);
    expect(manifest.repo_snapshot?.dirty).toBe(true);
    expect(manifest.repo_snapshot?.dirty_patch_artifact_id).toMatch(/^art_/);

    const patchPath = path.join(
      workspaceDir,
      "work/projects",
      project_id,
      "artifacts",
      `${manifest.repo_snapshot?.dirty_patch_artifact_id}.patch`
    );
    const patch = await fs.readFile(patchPath, { encoding: "utf8" });
    expect(patch).toContain("diff --git");
  });
});

