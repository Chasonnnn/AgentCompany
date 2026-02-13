import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { initWorkspace } from "../src/workspace/init.js";
import { createTeam } from "../src/org/teams.js";
import { createAgent } from "../src/org/agents.js";
import { createProject } from "../src/work/projects.js";
import { createRun } from "../src/runtime/run.js";
import { createHeartbeatActionProposal } from "../src/heartbeat/action_proposal.js";
import { buildReviewInboxSnapshot } from "../src/runtime/review_inbox.js";
import { resolveInboxItem } from "../src/inbox/resolve.js";

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-review-heartbeat-"));
}

describe("review inbox heartbeat integration", () => {
  test("includes heartbeat proposals in pending and clears them after decision", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const { team_id } = await createTeam({ workspace_dir: dir, name: "Ops" });
    const manager = await createAgent({
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
      agent_id: manager.agent_id,
      provider: "codex"
    });

    const proposal = await createHeartbeatActionProposal({
      workspace_dir: dir,
      project_id,
      title: "Heartbeat approval",
      summary: "review inbox should show this",
      produced_by: manager.agent_id,
      run_id: run.run_id,
      context_pack_id: run.context_pack_id,
      proposed_action: {
        kind: "noop",
        idempotency_key: "review-inbox-heartbeat:noop:1",
        risk: "low",
        needs_approval: false,
        reason: "test"
      }
    });

    const before = await buildReviewInboxSnapshot({
      workspace_dir: dir,
      project_id,
      refresh_index: true
    });
    expect(
      before.pending.some(
        (p) => p.artifact_id === proposal.artifact_id && p.artifact_type === "heartbeat_action_proposal"
      )
    ).toBe(true);

    await resolveInboxItem({
      workspace_dir: dir,
      project_id,
      artifact_id: proposal.artifact_id,
      decision: "denied",
      actor_id: manager.agent_id,
      actor_role: "manager",
      actor_team_id: team_id
    });

    const after = await buildReviewInboxSnapshot({
      workspace_dir: dir,
      project_id,
      sync_index: true
    });
    expect(after.pending.some((p) => p.artifact_id === proposal.artifact_id)).toBe(false);
    expect(
      after.recent_decisions.some(
        (d) =>
          d.subject_artifact_id === proposal.artifact_id &&
          d.subject_kind === "heartbeat_action" &&
          d.decision === "denied"
      )
    ).toBe(true);
  });
});
