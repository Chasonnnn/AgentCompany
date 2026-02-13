import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { initWorkspace } from "../src/workspace/init.js";
import { createProject } from "../src/work/projects.js";
import { listComments } from "../src/comments/comment.js";
import { DEFAULT_HEARTBEAT_CONFIG, DEFAULT_HEARTBEAT_STATE } from "../src/schemas/heartbeat.js";
import { applyHeartbeatWorkerReportActions } from "../src/runtime/heartbeat_actions.js";

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-heartbeat-actions-"));
}

function cloneDefaults() {
  return {
    config: structuredClone(DEFAULT_HEARTBEAT_CONFIG),
    state: structuredClone(DEFAULT_HEARTBEAT_STATE)
  };
}

describe("heartbeat actions", () => {
  test("dedupes duplicate idempotency keys", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const { config, state } = cloneDefaults();

    const applied = await applyHeartbeatWorkerReportActions({
      workspace_dir: dir,
      report: {
        schema_version: 1,
        type: "heartbeat_worker_report",
        status: "actions",
        summary: "duplicates",
        actions: [
          {
            kind: "noop",
            idempotency_key: "dup:no-op:1",
            risk: "low",
            needs_approval: false,
            reason: "first"
          },
          {
            kind: "noop",
            idempotency_key: "dup:no-op:1",
            risk: "low",
            needs_approval: false,
            reason: "second"
          }
        ]
      },
      source_worker_agent_id: "agent_worker",
      source_run_id: "run_worker",
      source_context_pack_id: "ctx_worker",
      config,
      state,
      actor_id: "agent_manager",
      actor_role: "manager"
    });

    expect(applied.summary.executed_actions).toBe(1);
    expect(applied.summary.deduped_actions).toBe(1);
    expect(applied.summary.queued_for_approval).toBe(0);
    expect(applied.state.idempotency["dup:no-op:1"]?.status).toBe("executed");
  });

  test("enforces per-tick budget and queues overflow actions for approval", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });
    const { config, state } = cloneDefaults();
    config.max_auto_actions_per_tick = 1;
    config.max_auto_actions_per_hour = 50;
    config.quiet_hours_start_hour = 23;
    config.quiet_hours_end_hour = 23; // disabled

    const applied = await applyHeartbeatWorkerReportActions({
      workspace_dir: dir,
      report: {
        schema_version: 1,
        type: "heartbeat_worker_report",
        status: "actions",
        summary: "budget",
        actions: [
          {
            kind: "add_comment",
            idempotency_key: "budget:comment:1",
            risk: "low",
            needs_approval: false,
            project_id,
            body: "first",
            target_agent_id: "agent_target"
          },
          {
            kind: "add_comment",
            idempotency_key: "budget:comment:2",
            risk: "low",
            needs_approval: false,
            project_id,
            body: "second",
            target_agent_id: "agent_target"
          }
        ]
      },
      source_worker_agent_id: "agent_worker",
      source_run_id: "run_worker",
      source_context_pack_id: "ctx_worker",
      config,
      state,
      actor_id: "agent_manager",
      actor_role: "manager"
    });

    expect(applied.summary.executed_actions).toBe(1);
    expect(applied.summary.queued_for_approval).toBe(1);
    expect(applied.summary.proposal_artifact_ids).toHaveLength(1);

    const comments = await listComments({
      workspace_dir: dir,
      project_id
    });
    expect(comments).toHaveLength(1);
  });

  test("quiet hours defer low-risk comments to approval artifacts", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });
    const { config, state } = cloneDefaults();
    const nowHour = new Date().getHours();
    config.quiet_hours_start_hour = nowHour;
    config.quiet_hours_end_hour = (nowHour + 1) % 24;
    config.max_auto_actions_per_tick = 10;
    config.max_auto_actions_per_hour = 50;

    const applied = await applyHeartbeatWorkerReportActions({
      workspace_dir: dir,
      report: {
        schema_version: 1,
        type: "heartbeat_worker_report",
        status: "actions",
        summary: "quiet-hours",
        actions: [
          {
            kind: "add_comment",
            idempotency_key: "quiet:comment:1",
            risk: "low",
            needs_approval: false,
            project_id,
            body: "defer this in quiet hours",
            target_agent_id: "agent_target"
          }
        ]
      },
      source_worker_agent_id: "agent_worker",
      source_run_id: "run_worker",
      source_context_pack_id: "ctx_worker",
      config,
      state,
      actor_id: "agent_manager",
      actor_role: "manager"
    });

    expect(applied.summary.executed_actions).toBe(0);
    expect(applied.summary.queued_for_approval).toBe(1);
    expect(applied.summary.proposal_artifact_ids).toHaveLength(1);

    const proposalId = applied.summary.proposal_artifact_ids[0]!;
    const proposalPath = path.join(dir, "work", "projects", project_id, "artifacts", `${proposalId}.md`);
    await fs.access(proposalPath);

    const comments = await listComments({
      workspace_dir: dir,
      project_id
    });
    expect(comments).toHaveLength(0);
  });
});
