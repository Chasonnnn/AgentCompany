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
import { rebuildSqliteIndex } from "../src/index/sqlite.js";
import { writeYamlFile } from "../src/store/yaml.js";
import { DEFAULT_HEARTBEAT_CONFIG, DEFAULT_HEARTBEAT_STATE } from "../src/schemas/heartbeat.js";
import { buildHeartbeatTriage } from "../src/runtime/heartbeat_triage.js";

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-heartbeat-triage-"));
}

function isoIn(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

async function writeRunningJob(args: {
  workspace_dir: string;
  project_id: string;
  job_id: string;
  worker_agent_id: string;
  started_at: string;
}): Promise<void> {
  const jobDir = path.join(args.workspace_dir, "work", "projects", args.project_id, "jobs", args.job_id);
  await fs.mkdir(jobDir, { recursive: true });
  await writeYamlFile(path.join(jobDir, "job.yaml"), {
    schema_version: 1,
    type: "job_record",
    job: {
      schema_version: 1,
      type: "job",
      job_id: args.job_id,
      job_kind: "execution",
      worker_kind: "codex",
      workspace_dir: args.workspace_dir,
      project_id: args.project_id,
      goal: "triage test",
      constraints: [],
      deliverables: [],
      permission_level: "read-only",
      context_refs: [],
      worker_agent_id: args.worker_agent_id
    },
    created_at: args.started_at,
    updated_at: args.started_at,
    status: "running",
    cancellation_requested: false,
    current_attempt: 1,
    attempts: [
      {
        attempt: 1,
        run_id: "run_stuck",
        context_pack_id: "ctx_stuck",
        session_ref: "local_run_stuck",
        worker_kind: "codex",
        worker_agent_id: args.worker_agent_id,
        provider: "codex",
        started_at: args.started_at,
        status: "running"
      }
    ]
  });
}

describe("heartbeat triage", () => {
  test(
    "scores workers and enforces top-k wakeup",
    async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });

    const { team_id: teamA } = await createTeam({ workspace_dir: dir, name: "Team A" });
    const { team_id: teamB } = await createTeam({ workspace_dir: dir, name: "Team B" });

    const workerA = await createAgent({
      workspace_dir: dir,
      name: "Worker A",
      role: "worker",
      provider: "codex",
      team_id: teamA
    });
    const workerB = await createAgent({
      workspace_dir: dir,
      name: "Worker B",
      role: "worker",
      provider: "codex",
      team_id: teamB
    });
    const workerC = await createAgent({
      workspace_dir: dir,
      name: "Worker C",
      role: "worker",
      provider: "codex",
      team_id: teamA
    });

    for (let i = 0; i < 7; i += 1) {
      await createAgent({
        workspace_dir: dir,
        name: `Worker Extra ${i}`,
        role: "worker",
        provider: "codex",
        team_id: i % 2 === 0 ? teamA : teamB
      });
    }

    const { project_id } = await createProject({ workspace_dir: dir, name: "Heartbeat Proj" });

    await createRun({
      workspace_dir: dir,
      project_id,
      agent_id: workerA.agent_id,
      provider: "codex"
    });

    const task = await createTaskFile({
      workspace_dir: dir,
      project_id,
      title: "Due task",
      visibility: "team",
      assignee_agent_id: workerB.agent_id,
      team_id: teamB
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

    await writeRunningJob({
      workspace_dir: dir,
      project_id,
      job_id: "job_stuck",
      worker_agent_id: workerC.agent_id,
      started_at: isoIn(-90)
    });

    await rebuildSqliteIndex(dir);

    const triage = await buildHeartbeatTriage({
      workspace_dir: dir,
      config: {
        ...DEFAULT_HEARTBEAT_CONFIG,
        top_k_workers: 2,
        min_wake_score: 3,
        quiet_hours_start_hour: 23,
        quiet_hours_end_hour: 23
      },
      state: DEFAULT_HEARTBEAT_STATE,
      random: () => 0
    });

    expect(triage.candidates.length).toBeGreaterThanOrEqual(10);
    expect(triage.woken_workers).toHaveLength(2);
    const wokeIds = new Set(triage.woken_workers.map((w) => w.worker_agent_id));
    expect(wokeIds.has(workerA.agent_id) || wokeIds.has(workerB.agent_id) || wokeIds.has(workerC.agent_id)).toBe(
      true
    );
    expect(triage.woken_workers.every((w) => w.jitter_seconds === 0)).toBe(true);
    },
    20_000
  );

  test("suppresses wake when recent HEARTBEAT_OK and no context change", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });

    const { team_id } = await createTeam({ workspace_dir: dir, name: "Team A" });
    const worker = await createAgent({
      workspace_dir: dir,
      name: "Worker A",
      role: "worker",
      provider: "codex",
      team_id
    });
    const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });

    const run = await createRun({
      workspace_dir: dir,
      project_id,
      agent_id: worker.agent_id,
      provider: "codex"
    });
    await rebuildSqliteIndex(dir);

    const first = await buildHeartbeatTriage({
      workspace_dir: dir,
      config: {
        ...DEFAULT_HEARTBEAT_CONFIG,
        top_k_workers: 2,
        min_wake_score: 1,
        quiet_hours_start_hour: 23,
        quiet_hours_end_hour: 23
      },
      state: DEFAULT_HEARTBEAT_STATE,
      random: () => 0
    });
    expect(first.woken_workers.some((w) => w.worker_agent_id === worker.agent_id)).toBe(true);

    const noSignalBaseline = await buildHeartbeatTriage({
      workspace_dir: dir,
      config: {
        ...DEFAULT_HEARTBEAT_CONFIG,
        top_k_workers: 2,
        min_wake_score: 1,
        quiet_hours_start_hour: 23,
        quiet_hours_end_hour: 23
      },
      state: {
        ...DEFAULT_HEARTBEAT_STATE,
        run_event_cursors: first.run_event_cursors
      },
      random: () => 0
    });

    const noChangeState = {
      ...DEFAULT_HEARTBEAT_STATE,
      run_event_cursors: first.run_event_cursors,
      worker_state: {
        [worker.agent_id]: {
          last_ok_at: new Date().toISOString(),
          last_context_hash: noSignalBaseline.context_hashes[worker.agent_id],
          suppressed_until: isoIn(30),
          last_report_status: "ok"
        }
      }
    };

    const second = await buildHeartbeatTriage({
      workspace_dir: dir,
      config: {
        ...DEFAULT_HEARTBEAT_CONFIG,
        top_k_workers: 2,
        min_wake_score: 1,
        quiet_hours_start_hour: 23,
        quiet_hours_end_hour: 23
      },
      state: noChangeState,
      random: () => 0
    });

    expect(second.woken_workers.some((w) => w.worker_agent_id === worker.agent_id)).toBe(false);
    const candidate = second.candidates.find((c) => c.worker_agent_id === worker.agent_id);
    expect(candidate?.suppressed).toBe(true);

    // keep ts from "unused variable" in a way that's semantically useful for this test setup
    expect(typeof run.run_id).toBe("string");
  });
});
