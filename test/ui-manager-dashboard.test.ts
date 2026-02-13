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
import {
  buildManagerDashboardJson,
  buildManagerDashboardText,
  parseManagerDashboardCommand,
  managerDashboardHelpText
} from "../src/ui/manager_dashboard.js";

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-"));
}

describe("ui manager dashboard", () => {
  test("parses dashboard commands", () => {
    expect(parseManagerDashboardCommand("refresh")).toEqual({ kind: "refresh" });
    expect(parseManagerDashboardCommand("r")).toEqual({ kind: "refresh" });
    expect(parseManagerDashboardCommand("q")).toEqual({ kind: "quit" });
    expect(parseManagerDashboardCommand("h")).toEqual({ kind: "help" });
    expect(parseManagerDashboardCommand("a art_123 ship it")).toEqual({
      kind: "resolve",
      decision: "approved",
      artifact_id: "art_123",
      notes: "ship it"
    });
    expect(parseManagerDashboardCommand("d art_456")).toEqual({
      kind: "resolve",
      decision: "denied",
      artifact_id: "art_456",
      notes: undefined
    });
    expect(parseManagerDashboardCommand("approve")).toEqual({
      kind: "invalid",
      error: "artifact_id is required"
    });
    expect(parseManagerDashboardCommand("weird")).toEqual({
      kind: "invalid",
      error: "Unknown command: weird"
    });
  });

  test("builds dashboard text from snapshot data", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const { team_id } = await createTeam({ workspace_dir: dir, name: "Payments" });
    const mgr = await createAgent({
      workspace_dir: dir,
      name: "Manager",
      role: "manager",
      provider: "cmd",
      team_id
    });
    const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });
    const { run_id, context_pack_id } = await createRun({
      workspace_dir: dir,
      project_id,
      agent_id: mgr.agent_id,
      provider: "cmd"
    });

    const proposed = await proposeMemoryDelta({
      workspace_dir: dir,
      project_id,
      title: "Dashboard pending",
      scope_kind: "project_memory",
      sensitivity: "internal",
      rationale: "Create a governed pending item for dashboard rendering.",
      under_heading: "## Decisions",
      insert_lines: ["- pending dashboard item"],
      visibility: "managers",
      produced_by: mgr.agent_id,
      run_id,
      context_pack_id,
      evidence: ["art_evidence_dashboard_text"]
    });

    const text = await buildManagerDashboardText({
      workspace_dir: dir,
      project_id,
      actor_id: mgr.agent_id,
      actor_role: "manager",
      actor_team_id: team_id
    });

    expect(text).toContain("=== Manager Dashboard ===");
    expect(text).toContain(`workspace: ${dir}`);
    expect(text).toContain("Pending approvals (1):");
    expect(text).toContain(proposed.artifact_id);
    expect(text).toContain("Commands:");
    expect(text).toContain(managerDashboardHelpText().split("\n")[0]!);
  });

  test("builds compact dashboard JSON payload", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const { team_id } = await createTeam({ workspace_dir: dir, name: "Payments" });
    const mgr = await createAgent({
      workspace_dir: dir,
      name: "Manager",
      role: "manager",
      provider: "cmd",
      team_id
    });
    const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });
    const { run_id, context_pack_id } = await createRun({
      workspace_dir: dir,
      project_id,
      agent_id: mgr.agent_id,
      provider: "cmd"
    });
    const proposed = await proposeMemoryDelta({
      workspace_dir: dir,
      project_id,
      title: "Dashboard pending JSON",
      scope_kind: "project_memory",
      sensitivity: "internal",
      rationale: "Create a governed pending item for dashboard JSON payload.",
      under_heading: "## Decisions",
      insert_lines: ["- pending dashboard json item"],
      visibility: "managers",
      produced_by: mgr.agent_id,
      run_id,
      context_pack_id,
      evidence: ["art_evidence_dashboard_json"]
    });

    const payload = await buildManagerDashboardJson({
      workspace_dir: dir,
      project_id,
      actor_id: mgr.agent_id,
      actor_role: "manager",
      actor_team_id: team_id
    });

    expect(payload.workspace_dir).toBe(dir);
    expect(payload.counts.pending).toBeGreaterThanOrEqual(1);
    expect(payload.counts.runs).toBeGreaterThanOrEqual(1);
    expect(payload.pending.some((p) => p.artifact_id === proposed.artifact_id)).toBe(true);
    expect(typeof payload.index_sync_worker.enabled).toBe("boolean");
  });
});
