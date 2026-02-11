import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { initWorkspace } from "../src/workspace/init.js";
import { createTeam } from "../src/org/teams.js";
import { createAgent } from "../src/org/agents.js";
import { createProject } from "../src/work/projects.js";
import { createRun } from "../src/runtime/run.js";
import { proposeMemoryDelta } from "../src/memory/propose_memory_delta.js";
import { buildUiSnapshot } from "../src/runtime/ui_bundle.js";

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-"));
}

describe("ui snapshot colleagues", () => {
  test("includes colleague directory with activity counters", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const { team_id } = await createTeam({ workspace_dir: dir, name: "Payments" });

    const manager = await createAgent({
      workspace_dir: dir,
      name: "Payments Manager",
      role: "manager",
      provider: "codex",
      team_id
    });
    const worker = await createAgent({
      workspace_dir: dir,
      name: "Payments Worker",
      role: "worker",
      provider: "codex",
      team_id
    });

    const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });
    const run = await createRun({
      workspace_dir: dir,
      project_id,
      agent_id: worker.agent_id,
      provider: "codex"
    });

    await proposeMemoryDelta({
      workspace_dir: dir,
      project_id,
      title: "Worker pending item",
      under_heading: "## Decisions",
      insert_lines: ["- pending review"],
      visibility: "managers",
      produced_by: worker.agent_id,
      run_id: run.run_id,
      context_pack_id: run.context_pack_id
    });

    const snapshot = await buildUiSnapshot({
      workspace_dir: dir,
      project_id,
      sync_index: true
    });

    const workerColleague = snapshot.colleagues.find((c) => c.agent_id === worker.agent_id);
    const managerColleague = snapshot.colleagues.find((c) => c.agent_id === manager.agent_id);

    expect(workerColleague).toBeDefined();
    expect(workerColleague?.name).toBe("Payments Worker");
    expect(workerColleague?.team_name).toBe("Payments");
    expect(workerColleague?.total_runs).toBeGreaterThanOrEqual(1);
    expect(workerColleague?.pending_reviews).toBeGreaterThanOrEqual(1);
    expect(workerColleague?.status).toBe("active");

    expect(managerColleague).toBeDefined();
    expect(managerColleague?.name).toBe("Payments Manager");
  });
});
