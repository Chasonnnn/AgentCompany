import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { initWorkspace } from "../src/workspace/init.js";
import { createTeam } from "../src/org/teams.js";
import { createAgent } from "../src/org/agents.js";
import { createProject } from "../src/work/projects.js";
import { createRun } from "../src/runtime/run.js";
import { listComments } from "../src/comments/comment.js";
import { resolveInboxItem } from "../src/inbox/resolve.js";
import { createHeartbeatActionProposal } from "../src/heartbeat/action_proposal.js";
import { buildReviewInboxSnapshot } from "../src/runtime/review_inbox.js";
import { readHeartbeatState } from "../src/runtime/heartbeat_store.js";
import { DEFAULT_HEARTBEAT_CONFIG, DEFAULT_HEARTBEAT_STATE } from "../src/schemas/heartbeat.js";
import { applyHeartbeatWorkerReportActions } from "../src/runtime/heartbeat_actions.js";

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-heartbeat-approval-"));
}

describe("heartbeat approval flow", () => {
  test("risky heartbeat action creates proposal and appears in pending inbox", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });

    const applied = await applyHeartbeatWorkerReportActions({
      workspace_dir: dir,
      report: {
        schema_version: 1,
        type: "heartbeat_worker_report",
        status: "actions",
        summary: "risk gate",
        actions: [
          {
            kind: "add_comment",
            idempotency_key: "approval:risky:1",
            risk: "medium",
            needs_approval: false,
            project_id,
            body: "manager should review this",
            target_agent_id: "agent_target"
          }
        ]
      },
      source_worker_agent_id: "agent_worker",
      source_run_id: "run_worker",
      source_context_pack_id: "ctx_worker",
      config: {
        ...structuredClone(DEFAULT_HEARTBEAT_CONFIG),
        quiet_hours_start_hour: 23,
        quiet_hours_end_hour: 23
      },
      state: structuredClone(DEFAULT_HEARTBEAT_STATE),
      actor_id: "agent_manager",
      actor_role: "manager"
    });

    expect(applied.summary.queued_for_approval).toBe(1);
    const proposalId = applied.summary.proposal_artifact_ids[0];
    expect(typeof proposalId).toBe("string");

    const inbox = await buildReviewInboxSnapshot({
      workspace_dir: dir,
      project_id,
      refresh_index: true
    });
    expect(
      inbox.pending.some(
        (p) => p.artifact_id === proposalId && p.artifact_type === "heartbeat_action_proposal"
      )
    ).toBe(true);
  });

  test("approved proposal executes idempotently and records review", async () => {
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
      title: "Approve heartbeat action",
      summary: "should create one comment",
      produced_by: manager.agent_id,
      run_id: run.run_id,
      context_pack_id: run.context_pack_id,
      proposed_action: {
        kind: "add_comment",
        idempotency_key: "approval:execute-once:1",
        risk: "low",
        needs_approval: false,
        project_id,
        body: "approved comment action",
        target_agent_id: "agent_target"
      }
    });

    const resolved = await resolveInboxItem({
      workspace_dir: dir,
      project_id,
      artifact_id: proposal.artifact_id,
      decision: "approved",
      actor_id: manager.agent_id,
      actor_role: "manager",
      actor_team_id: team_id
    });
    expect(resolved.decision).toBe("approved");
    expect(resolved.subject_kind).toBe("heartbeat_action");

    const comments = await listComments({
      workspace_dir: dir,
      project_id
    });
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("approved comment action");

    const hbState = await readHeartbeatState(dir);
    expect(hbState.idempotency["approval:execute-once:1"]?.status).toBe("executed");
    expect(hbState.idempotency["approval:execute-once:1"]?.execution_count).toBe(1);
  });

  test("denied proposal records review and does not execute action", async () => {
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
      title: "Deny heartbeat action",
      summary: "should not create comment",
      produced_by: manager.agent_id,
      run_id: run.run_id,
      context_pack_id: run.context_pack_id,
      proposed_action: {
        kind: "add_comment",
        idempotency_key: "approval:deny:1",
        risk: "low",
        needs_approval: false,
        project_id,
        body: "this should not execute",
        target_agent_id: "agent_target"
      }
    });

    const resolved = await resolveInboxItem({
      workspace_dir: dir,
      project_id,
      artifact_id: proposal.artifact_id,
      decision: "denied",
      actor_id: manager.agent_id,
      actor_role: "manager",
      actor_team_id: team_id,
      notes: "not now"
    });
    expect(resolved.decision).toBe("denied");
    expect(resolved.subject_kind).toBe("heartbeat_action");

    const comments = await listComments({
      workspace_dir: dir,
      project_id
    });
    expect(comments).toHaveLength(0);

    const inbox = await buildReviewInboxSnapshot({
      workspace_dir: dir,
      project_id,
      sync_index: true
    });
    expect(
      inbox.recent_decisions.some(
        (d) =>
          d.subject_artifact_id === proposal.artifact_id &&
          d.decision === "denied" &&
          d.subject_kind === "heartbeat_action"
      )
    ).toBe(true);
  });
});
