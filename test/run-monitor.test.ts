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
import { appendEventJsonl, newEnvelope } from "../src/runtime/events.js";
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
    expect(row?.policy_decision_count).toBeGreaterThanOrEqual(0);
    expect(row?.policy_denied_count).toBeGreaterThanOrEqual(0);
    expect(row?.budget_decision_count).toBeGreaterThanOrEqual(0);
    expect(row?.budget_alert_count).toBeGreaterThanOrEqual(0);
    expect(row?.budget_exceeded_count).toBeGreaterThanOrEqual(0);
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

  test("includes latest policy/budget explainability details", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const { team_id } = await createTeam({ workspace_dir: dir, name: "Payments" });
    const { agent_id } = await createAgent({
      workspace_dir: dir,
      name: "Manager",
      role: "manager",
      provider: "cmd",
      team_id
    });
    const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });
    const { run_id } = await createRun({
      workspace_dir: dir,
      project_id,
      agent_id,
      provider: "cmd"
    });

    const eventsPath = path.join(dir, "work/projects", project_id, "runs", run_id, "events.jsonl");
    await appendEventJsonl(
      eventsPath,
      newEnvelope({
        schema_version: 1,
        ts_wallclock: new Date().toISOString(),
        run_id,
        session_ref: `local_${run_id}`,
        actor: agent_id,
        visibility: "managers",
        type: "policy.denied",
        payload: {
          action: "read",
          policy: {
            allowed: false,
            rule_id: "vis.team.mismatch",
            reason: "team_mismatch"
          }
        }
      })
    );
    await appendEventJsonl(
      eventsPath,
      newEnvelope({
        schema_version: 1,
        ts_wallclock: new Date().toISOString(),
        run_id,
        session_ref: `local_${run_id}`,
        actor: "system",
        visibility: "org",
        type: "budget.decision",
        payload: {
          scope: "run",
          metric: "tokens",
          severity: "soft",
          threshold: 10,
          actual: 12,
          result: "alert"
        }
      })
    );

    const snap = await buildRunMonitorSnapshot({
      workspace_dir: dir,
      project_id,
      refresh_index: true
    });
    const row = snap.rows.find((r) => r.run_id === run_id);
    expect(row?.latest_policy_denied?.rule_id).toBe("vis.team.mismatch");
    expect(row?.latest_policy_denied?.reason).toBe("team_mismatch");
    expect(row?.latest_budget_decision?.scope).toBe("run");
    expect(row?.latest_budget_decision?.result).toBe("alert");
  });
});
