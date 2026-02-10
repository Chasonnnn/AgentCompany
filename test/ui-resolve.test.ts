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
import { resolveInboxAndBuildUiSnapshot } from "../src/ui/resolve_and_snapshot.js";

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-"));
}

describe("ui resolve and snapshot", () => {
  test("returns resolved decision plus refreshed snapshot payload", async () => {
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
      title: "Resolve me",
      under_heading: "## Decisions",
      insert_lines: ["- This entry is denied in test."],
      visibility: "managers",
      produced_by: mgr.agent_id,
      run_id,
      context_pack_id
    });

    const res = await resolveInboxAndBuildUiSnapshot({
      workspace_dir: dir,
      project_id,
      artifact_id: proposed.artifact_id,
      decision: "denied",
      actor_id: mgr.agent_id,
      actor_role: "manager",
      actor_team_id: team_id,
      notes: "Declined"
    });

    expect(res.resolved.artifact_id).toBe(proposed.artifact_id);
    expect(res.resolved.decision).toBe("denied");
    expect(Array.isArray(res.snapshot.monitor.rows)).toBe(true);
    expect(Array.isArray(res.snapshot.review_inbox.pending)).toBe(true);
    expect(
      res.snapshot.review_inbox.pending.some((p) => p.artifact_id === proposed.artifact_id)
    ).toBe(false);
    expect(
      res.snapshot.review_inbox.recent_decisions.some(
        (d) => d.subject_artifact_id === proposed.artifact_id && d.decision === "denied"
      )
    ).toBe(true);
  });
});
