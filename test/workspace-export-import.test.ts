import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { initWorkspace } from "../src/workspace/init.js";
import { createTeam } from "../src/org/teams.js";
import { createAgent } from "../src/org/agents.js";
import { createProject } from "../src/work/projects.js";
import { createRun } from "../src/runtime/run.js";
import { exportWorkspace, importWorkspace } from "../src/workspace/export_import.js";
import { validateWorkspace } from "../src/workspace/validate.js";
import { rebuildSqliteIndex } from "../src/index/sqlite.js";

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-"));
}

describe("workspace export/import", () => {
  test("exports canonical folders and imports them into a reindexable workspace", async () => {
    const src = await mkTmpDir();
    await initWorkspace({ root_dir: src, company_name: "Acme" });
    const { team_id } = await createTeam({ workspace_dir: src, name: "Payments" });
    const { agent_id } = await createAgent({
      workspace_dir: src,
      name: "Worker",
      role: "worker",
      provider: "codex",
      team_id
    });
    const { project_id } = await createProject({ workspace_dir: src, name: "Proj" });
    await createRun({
      workspace_dir: src,
      project_id,
      agent_id,
      provider: "codex"
    });

    const exported = await mkTmpDir();
    await exportWorkspace({
      workspace_dir: src,
      out_dir: exported,
      include_local: false,
      force: true
    });
    await fs.access(path.join(exported, "company", "company.yaml"));
    await fs.access(path.join(exported, "org", "teams", team_id, "team.yaml"));
    await fs.access(path.join(exported, "work", "projects", project_id, "project.yaml"));
    await expect(fs.access(path.join(exported, ".local"))).rejects.toThrow();

    const importedDir = await mkTmpDir();
    const imported = await importWorkspace({
      src_dir: exported,
      workspace_dir: importedDir,
      include_local: false,
      force: true
    });
    expect(imported.validation_ok).toBe(true);

    const v = await validateWorkspace(importedDir);
    expect(v.ok).toBe(true);
    await fs.access(path.join(importedDir, ".local", "machine.yaml"));

    const idx = await rebuildSqliteIndex(importedDir);
    expect(idx.runs_indexed).toBeGreaterThanOrEqual(1);
  });
});
