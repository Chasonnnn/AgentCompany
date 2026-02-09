import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { initWorkspace } from "../src/workspace/init.js";
import { validateWorkspace } from "../src/workspace/validate.js";
import { createProject } from "../src/work/projects.js";
import { createAgent } from "../src/org/agents.js";
import { createTeam } from "../src/org/teams.js";
import { createRun } from "../src/runtime/run.js";

async function mkTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-"));
  return dir;
}

describe("workspace validation: runs and context packs", () => {
  test("invalid run.yaml is reported", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const { team_id } = await createTeam({ workspace_dir: dir, name: "Payments" });
    const { agent_id } = await createAgent({
      workspace_dir: dir,
      name: "Worker",
      role: "worker",
      provider: "codex",
      team_id
    });
    const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });
    const { run_id } = await createRun({
      workspace_dir: dir,
      project_id,
      agent_id,
      provider: "codex"
    });

    const runYamlPath = path.join(dir, "work/projects", project_id, "runs", run_id, "run.yaml");
    const raw = await fs.readFile(runYamlPath, { encoding: "utf8" });
    await fs.writeFile(runYamlPath, raw.replace("status: running", "status: nope"), {
      encoding: "utf8"
    });

    const res = await validateWorkspace(dir);
    expect(res.ok).toBe(false);
  });

  test("invalid context pack manifest is reported", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const { team_id } = await createTeam({ workspace_dir: dir, name: "Payments" });
    const { agent_id } = await createAgent({
      workspace_dir: dir,
      name: "Worker",
      role: "worker",
      provider: "codex",
      team_id
    });
    const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });
    const { context_pack_id } = await createRun({
      workspace_dir: dir,
      project_id,
      agent_id,
      provider: "codex"
    });

    const manifestPath = path.join(
      dir,
      "work/projects",
      project_id,
      "context_packs",
      context_pack_id,
      "manifest.yaml"
    );
    const raw = await fs.readFile(manifestPath, { encoding: "utf8" });
    await fs.writeFile(manifestPath, raw.replace("type: context_pack_manifest", "type: nope"), {
      encoding: "utf8"
    });

    const res = await validateWorkspace(dir);
    expect(res.ok).toBe(false);
  });
});

