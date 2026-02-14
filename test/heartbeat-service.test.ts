import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { initWorkspace } from "../src/workspace/init.js";
import { createTeam } from "../src/org/teams.js";
import { createAgent } from "../src/org/agents.js";
import { createProject } from "../src/work/projects.js";
import { createTaskFile } from "../src/work/tasks.js";
import { updateTaskPlan } from "../src/work/tasks_plan_update.js";
import { createRun } from "../src/runtime/run.js";
import { HeartbeatService, resolveWakeProjectId } from "../src/runtime/heartbeat_service.js";

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-heartbeat-service-"));
}

function isoIn(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

describe("heartbeat service", () => {
  test("observeWorkspace auto-starts loop and status is readable", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const service = new HeartbeatService();

    await service.observeWorkspace(dir);
    const status = await service.getStatus({ workspace_dir: dir });
    expect(status.observed).toBe(true);
    expect(status.runtime.loop_running).toBe(true);
    expect(status.config.enabled).toBe(true);

    await service.close();
  });

  test(
    "tickWorkspace computes candidates/wake targets with jitter and updates next tick time",
    async () => {
      const dir = await mkTmpDir();
      await initWorkspace({ root_dir: dir, company_name: "Acme" });
      const service = new HeartbeatService();
      const { team_id } = await createTeam({ workspace_dir: dir, name: "Ops" });
      const worker = await createAgent({
        workspace_dir: dir,
        name: "Worker",
        role: "worker",
        provider: "codex",
        team_id
      });
      const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });
      await createRun({
        workspace_dir: dir,
        project_id,
        agent_id: worker.agent_id,
        provider: "codex"
      });
      const task = await createTaskFile({
        workspace_dir: dir,
        project_id,
        title: "Due soon",
        visibility: "team",
        assignee_agent_id: worker.agent_id,
        team_id
      });
      await updateTaskPlan({
        workspace_dir: dir,
        project_id,
        task_id: task.task_id,
        schedule: {
          planned_end: isoIn(30),
          depends_on_task_ids: []
        }
      });

      await service.setConfig({
        workspace_dir: dir,
        config: {
          top_k_workers: 1,
          min_wake_score: 1,
          quiet_hours_start_hour: 23,
          quiet_hours_end_hour: 23
        }
      });

      const tick = await service.tickWorkspace({
        workspace_dir: dir,
        dry_run: true,
        reason: "test"
      });
      expect(tick.skipped_due_to_running).toBe(false);
      expect(tick.woken_workers.length).toBe(1);
      expect(tick.woken_workers[0]?.jitter_seconds).toBeGreaterThanOrEqual(0);
      expect(tick.woken_workers[0]?.jitter_seconds).toBeLessThanOrEqual(tick.config.jitter_max_seconds);
      expect(tick.reports_processed).toBe(0);

      const status = await service.getStatus({ workspace_dir: dir });
      expect(typeof status.state.next_tick_at).toBe("string");
      expect(status.runtime.last_tick_summary?.tick_id).toBe(tick.tick_id);

      await service.close();
    },
    20_000
  );

  test("does not overlap ticks for the same workspace", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const service = new HeartbeatService();

    const [a, b] = await Promise.all([
      service.tickWorkspace({ workspace_dir: dir, dry_run: true, reason: "parallel-a" }),
      service.tickWorkspace({ workspace_dir: dir, dry_run: true, reason: "parallel-b" })
    ]);
    expect(a.skipped_due_to_running || b.skipped_due_to_running).toBe(true);

    await service.close();
  });

  test("persists enterprise hierarchy config fields", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const service = new HeartbeatService();

    await service.observeWorkspace(dir);
    const cfg = await service.setConfig({
      workspace_dir: dir,
      config: {
        hierarchy_mode: "enterprise_v1",
        executive_manager_agent_id: "agent_exec_mgr",
        allow_director_to_spawn_workers: true
      }
    });
    expect(cfg.hierarchy_mode).toBe("enterprise_v1");
    expect(cfg.executive_manager_agent_id).toBe("agent_exec_mgr");
    expect(cfg.allow_director_to_spawn_workers).toBe(true);

    const status = await service.getStatus({ workspace_dir: dir });
    expect(status.config.hierarchy_mode).toBe("enterprise_v1");
    expect(status.config.executive_manager_agent_id).toBe("agent_exec_mgr");
    expect(status.config.allow_director_to_spawn_workers).toBe(true);

    await service.close();
  });

  test("resolveWakeProjectId prefers wake target, then latest worker project, then global fallback", () => {
    expect(
      resolveWakeProjectId({
        wake_project_id: "proj_wake",
        worker_agent_id: "agent_w",
        latest_project_by_worker: new Map([["agent_w", "proj_latest"]]),
        global_fallback_project_id: "proj_global"
      })
    ).toBe("proj_wake");

    expect(
      resolveWakeProjectId({
        wake_project_id: undefined,
        worker_agent_id: "agent_w",
        latest_project_by_worker: new Map([["agent_w", "proj_latest"]]),
        global_fallback_project_id: "proj_global"
      })
    ).toBe("proj_latest");

    expect(
      resolveWakeProjectId({
        wake_project_id: undefined,
        worker_agent_id: "agent_unknown",
        latest_project_by_worker: new Map([["agent_w", "proj_latest"]]),
        global_fallback_project_id: "proj_global"
      })
    ).toBe("proj_global");
  });
});
