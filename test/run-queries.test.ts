import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { initWorkspace } from "../src/workspace/init.js";
import { createProject } from "../src/work/projects.js";
import { createTeam } from "../src/org/teams.js";
import { createAgent } from "../src/org/agents.js";
import { createRun } from "../src/runtime/run.js";
import { executeCommandRun } from "../src/runtime/execute_command.js";
import { listRuns, readEventsJsonl } from "../src/runtime/run_queries.js";

async function mkTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-"));
  return dir;
}

describe("run queries", () => {
  test("listRuns returns created runs", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });
    const { team_id } = await createTeam({ workspace_dir: dir, name: "Payments" });
    const { agent_id } = await createAgent({
      workspace_dir: dir,
      name: "Worker",
      role: "worker",
      provider: "cmd",
      team_id
    });
    const r1 = await createRun({ workspace_dir: dir, project_id, agent_id, provider: "cmd" });
    const r2 = await createRun({ workspace_dir: dir, project_id, agent_id, provider: "cmd" });

    const runs = await listRuns({ workspace_dir: dir, project_id });
    const ids = new Set(runs.map((r) => r.run_id));
    expect(ids.has(r1.run_id)).toBe(true);
    expect(ids.has(r2.run_id)).toBe(true);
  });

  test("readEventsJsonl parses events including provider.raw", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });
    const { team_id } = await createTeam({ workspace_dir: dir, name: "Payments" });
    const { agent_id } = await createAgent({
      workspace_dir: dir,
      name: "Worker",
      role: "worker",
      provider: "cmd",
      team_id
    });
    const { run_id } = await createRun({ workspace_dir: dir, project_id, agent_id, provider: "cmd" });
    await executeCommandRun({
      workspace_dir: dir,
      project_id,
      run_id,
      argv: [process.execPath, "-e", "console.log('hello')"]
    });

    const eventsPath = path.join(dir, "work/projects", project_id, "runs", run_id, "events.jsonl");
    const lines = await readEventsJsonl(eventsPath);
    expect(lines.every((l) => l.ok)).toBe(true);
    const types = lines.filter((l): l is any => l.ok).map((l) => l.event.type);
    expect(types).toContain("run.started");
    expect(types).toContain("provider.raw");
  });
});

