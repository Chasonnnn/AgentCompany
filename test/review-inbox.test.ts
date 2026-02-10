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
import { proposeMemoryDelta } from "../src/memory/propose_memory_delta.js";
import { approveMemoryDelta } from "../src/memory/approve_memory_delta.js";
import { buildReviewInboxSnapshot } from "../src/runtime/review_inbox.js";
import { buildUiSnapshot } from "../src/runtime/ui_bundle.js";

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-"));
}

describe("review inbox snapshot", () => {
  test("returns pending approvals and recent decisions with parse-error flags", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });

    const { team_id } = await createTeam({ workspace_dir: dir, name: "Payments" });
    const { agent_id: workerId } = await createAgent({
      workspace_dir: dir,
      name: "Worker",
      role: "worker",
      provider: "codex",
      team_id
    });
    const { agent_id: managerId } = await createAgent({
      workspace_dir: dir,
      name: "Manager",
      role: "manager",
      provider: "codex",
      team_id
    });

    const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });
    const run = await createRun({
      workspace_dir: dir,
      project_id,
      agent_id: workerId,
      provider: "codex"
    });
    await executeCommandRun({
      workspace_dir: dir,
      project_id,
      run_id: run.run_id,
      argv: [process.execPath, "-e", "console.log('review-inbox')"]
    });

    const eventsPath = path.join(
      dir,
      "work/projects",
      project_id,
      "runs",
      run.run_id,
      "events.jsonl"
    );
    await fs.appendFile(eventsPath, "{malformed-json}\n", { encoding: "utf8" });

    const delta = await proposeMemoryDelta({
      workspace_dir: dir,
      project_id,
      title: "Capture parser warning",
      under_heading: "## Decisions",
      insert_lines: ["- Include parse error flags in review inbox snapshots."],
      visibility: "managers",
      produced_by: managerId,
      run_id: run.run_id,
      context_pack_id: run.context_pack_id
    });

    const inboxBefore = await buildReviewInboxSnapshot({
      workspace_dir: dir,
      project_id,
      refresh_index: true
    });
    expect(inboxBefore.index_rebuilt).toBe(true);
    const pending = inboxBefore.pending.find((p) => p.artifact_id === delta.artifact_id);
    expect(pending).toBeDefined();
    expect(pending?.parse_error_count).toBeGreaterThanOrEqual(1);

    await approveMemoryDelta({
      workspace_dir: dir,
      project_id,
      artifact_id: delta.artifact_id,
      actor_id: managerId,
      actor_role: "manager",
      actor_team_id: team_id,
      notes: "approved"
    });

    const inboxAfter = await buildReviewInboxSnapshot({
      workspace_dir: dir,
      project_id,
      sync_index: true
    });
    expect(inboxAfter.index_synced).toBe(true);
    expect(inboxAfter.pending.some((p) => p.artifact_id === delta.artifact_id)).toBe(false);
    const decision = inboxAfter.recent_decisions.find(
      (d) => d.subject_artifact_id === delta.artifact_id
    );
    expect(decision).toBeDefined();
    expect(decision?.parse_error_count).toBeGreaterThanOrEqual(1);

    const ui = await buildUiSnapshot({
      workspace_dir: dir,
      project_id,
      sync_index: true
    });
    expect(typeof ui.index_sync_worker.enabled).toBe("boolean");
    expect(Array.isArray(ui.monitor.rows)).toBe(true);
    expect(Array.isArray(ui.review_inbox.pending)).toBe(true);
    expect(ui.review_inbox.recent_decisions.some((d) => d.subject_artifact_id === delta.artifact_id)).toBe(true);
  });
});
