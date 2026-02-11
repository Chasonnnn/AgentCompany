import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { initWorkspace } from "../src/workspace/init.js";
import { createTeam } from "../src/org/teams.js";
import { createAgent } from "../src/org/agents.js";
import { createProject } from "../src/work/projects.js";
import { createRun } from "../src/runtime/run.js";
import { executeCommandRun } from "../src/runtime/execute_command.js";
import { buildRunMonitorSnapshot } from "../src/runtime/run_monitor.js";
import { launchSession, stopSession } from "../src/runtime/session.js";

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-"));
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("run monitor snapshot", () => {
  test("returns indexed run rows with last event context", async () => {
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
    await executeCommandRun({
      workspace_dir: dir,
      project_id,
      run_id,
      argv: [process.execPath, "-e", "console.log('monitor')"]
    });

    const snap = await buildRunMonitorSnapshot({
      workspace_dir: dir,
      project_id,
      refresh_index: true
    });
    expect(snap.index_rebuilt).toBe(true);
    expect(snap.index_synced).toBe(false);
    const row = snap.rows.find((r) => r.run_id === run_id);
    expect(row).toBeDefined();
    expect(row?.last_event).toBeDefined();
    expect(row?.parse_error_count).toBeGreaterThanOrEqual(0);
    expect(row?.token_usage?.total_tokens).toBeGreaterThan(0);
  });

  test("includes live session rows even before index refresh", async () => {
    const dir = await mkTmpDir();
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

    await createRun({
      workspace_dir: dir,
      project_id,
      agent_id,
      provider: "cmd"
    });
    await buildRunMonitorSnapshot({ workspace_dir: dir, project_id, refresh_index: true });

    const { run_id: liveRunId } = await createRun({
      workspace_dir: dir,
      project_id,
      agent_id,
      provider: "cmd"
    });
    const launched = await launchSession({
      workspace_dir: dir,
      project_id,
      run_id: liveRunId,
      argv: [process.execPath, "-e", "setTimeout(() => process.exit(0), 3000);"]
    });
    await sleep(80);

    const snap = await buildRunMonitorSnapshot({
      workspace_dir: dir,
      project_id,
      refresh_index: false
    });
    expect(snap.index_rebuilt).toBe(false);
    expect(snap.index_synced).toBe(true);
    const liveRow = snap.rows.find((r) => r.run_id === liveRunId);
    expect(liveRow).toBeDefined();
    expect(liveRow?.live_status).toBe("running");
    expect(liveRow?.session_ref).toBe(launched.session_ref);

    await stopSession(launched.session_ref);
  });
});
