import crypto from "node:crypto";
import { listAgents, type ListedAgent } from "../org/agents_list.js";
import { listProjects } from "../work/projects_list.js";
import { listProjectTasks } from "../work/tasks_list.js";
import { listJobs } from "./job_runner.js";
import { listIndexedEvents, listIndexedRuns, syncSqliteIndex } from "../index/sqlite.js";
import type { HeartbeatConfig, HeartbeatState } from "../schemas/heartbeat.js";

export type HeartbeatWorkerCandidate = {
  worker_agent_id: string;
  team_id?: string;
  score: number;
  components: {
    new_signal_points: number;
    due_points: number;
    overdue_points: number;
    stuck_points: number;
    recent_ok_penalty: number;
    quiet_hours_penalty: number;
  };
  counts: {
    new_signals: number;
    due_tasks: number;
    overdue_tasks: number;
    stuck_jobs: number;
  };
  context_hash: string;
  suppressed: boolean;
  suppression_reason?: string;
};

export type HeartbeatWakeTarget = {
  worker_agent_id: string;
  team_id?: string;
  project_id?: string;
  score: number;
  jitter_seconds: number;
  context_hash: string;
};

export type HeartbeatTriageResult = {
  generated_at: string;
  run_event_cursors: Record<string, number>;
  candidates: HeartbeatWorkerCandidate[];
  woken_workers: HeartbeatWakeTarget[];
  context_hashes: Record<string, string>;
};

function workerProjectKey(workerAgentId: string, projectId: string): string {
  return `${workerAgentId}::${projectId}`;
}

function bumpWorkerProjectCounter(
  map: Map<string, number>,
  workerAgentId: string,
  projectId: string,
  delta = 1
): void {
  const key = workerProjectKey(workerAgentId, projectId);
  map.set(key, (map.get(key) ?? 0) + delta);
}

function chooseWakeProjectId(args: {
  worker_agent_id: string;
  project_signal_scores: Map<string, number>;
  latest_project_id?: string;
}): string | undefined {
  const prefix = `${args.worker_agent_id}::`;
  const scored = [...args.project_signal_scores.entries()]
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, score]) => ({
      project_id: key.slice(prefix.length),
      score
    }))
    .filter((row) => row.project_id.length > 0);
  if (scored.length === 0) return args.latest_project_id;

  const maxScore = Math.max(...scored.map((row) => row.score));
  const tied = scored.filter((row) => row.score === maxScore).map((row) => row.project_id);
  if (args.latest_project_id && tied.includes(args.latest_project_id)) {
    return args.latest_project_id;
  }
  tied.sort((a, b) => a.localeCompare(b));
  return tied[0];
}

function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function parseIsoMs(value: string | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function isoAt(ms: number): string {
  return new Date(ms).toISOString();
}

function isQuietHours(now: Date, startHour: number, endHour: number): boolean {
  const h = now.getHours();
  if (startHour === endHour) return false;
  if (startHour < endHour) return h >= startHour && h < endHour;
  return h >= startHour || h < endHour;
}

function buildWorkerPool(agents: ListedAgent[], hierarchyMode: "standard" | "enterprise_v1"): ListedAgent[] {
  if (hierarchyMode === "enterprise_v1") {
    return agents
      .filter((a) => a.role === "director" || a.role === "worker")
      .sort((a, b) => a.agent_id.localeCompare(b.agent_id));
  }

  const workers = agents.filter((a) => a.role === "worker");
  const managers = agents.filter((a) => a.role === "manager");

  const byTeamWorkers = new Map<string, ListedAgent[]>();
  for (const w of workers) {
    if (!w.team_id) continue;
    const curr = byTeamWorkers.get(w.team_id) ?? [];
    curr.push(w);
    byTeamWorkers.set(w.team_id, curr);
  }

  const selected = new Map<string, ListedAgent>();
  for (const w of workers) selected.set(w.agent_id, w);

  for (const m of managers) {
    if (m.team_id && (byTeamWorkers.get(m.team_id)?.length ?? 0) > 0) continue;
    selected.set(m.agent_id, m);
  }

  return [...selected.values()].sort((a, b) => a.agent_id.localeCompare(b.agent_id));
}

function workerKindFromProvider(provider: string): "codex" | "claude" | "gemini" {
  const p = provider.toLowerCase();
  if (p.startsWith("codex")) return "codex";
  if (p.startsWith("claude")) return "claude";
  return "gemini";
}

export async function buildHeartbeatTriage(args: {
  workspace_dir: string;
  config: HeartbeatConfig;
  state: HeartbeatState;
  now?: Date;
  random?: () => number;
}): Promise<HeartbeatTriageResult> {
  const now = args.now ?? new Date();
  const nowMs = now.getTime();
  const random = args.random ?? Math.random;

  await syncSqliteIndex(args.workspace_dir).catch(() => {});

  const agents = await listAgents({ workspace_dir: args.workspace_dir });
  const workers = buildWorkerPool(agents, args.config.hierarchy_mode);
  const workersById = new Map(workers.map((w) => [w.agent_id, w]));
  const workersByTeam = new Map<string, string[]>();
  for (const w of workers) {
    if (!w.team_id) continue;
    const curr = workersByTeam.get(w.team_id) ?? [];
    curr.push(w.agent_id);
    workersByTeam.set(w.team_id, curr);
  }

  const newSignalsByWorker = new Map<string, number>();
  const dueByWorker = new Map<string, number>();
  const overdueByWorker = new Map<string, number>();
  const stuckByWorker = new Map<string, number>();
  const projectSignalScores = new Map<string, number>();
  const runEventCursors = { ...args.state.run_event_cursors };

  const bump = (map: Map<string, number>, key: string, delta = 1): void => {
    map.set(key, (map.get(key) ?? 0) + delta);
  };

  const indexedRuns = await listIndexedRuns({ workspace_dir: args.workspace_dir, limit: 5000 }).catch(() => []);
  const latestProjectByWorker = new Map<string, string>();
  for (const run of indexedRuns) {
    if (!latestProjectByWorker.has(run.agent_id)) {
      latestProjectByWorker.set(run.agent_id, run.project_id);
    }
  }
  for (const run of indexedRuns) {
    const cursorKey = `${run.project_id}::${run.run_id}`;
    const since = args.state.run_event_cursors[cursorKey] ?? 0;
    const events = await listIndexedEvents({
      workspace_dir: args.workspace_dir,
      project_id: run.project_id,
      run_id: run.run_id,
      since_seq: since,
      limit: 5000,
      order: "asc"
    }).catch(() => []);
    if (!events.length) continue;
    const maxSeq = Math.max(...events.map((e) => e.seq));
    runEventCursors[cursorKey] = maxSeq;

    if (workersById.has(run.agent_id)) {
      bump(newSignalsByWorker, run.agent_id, 1);
      bumpWorkerProjectCounter(projectSignalScores, run.agent_id, run.project_id, 5);
    }

    for (const ev of events) {
      if (ev.actor && workersById.has(ev.actor)) {
        bump(newSignalsByWorker, ev.actor, 1);
        bumpWorkerProjectCounter(projectSignalScores, ev.actor, run.project_id, 5);
      }
    }
  }

  const projects = await listProjects({ workspace_dir: args.workspace_dir });
  const horizonMs = args.config.due_horizon_minutes * 60_000;
  for (const project of projects) {
    const tasks = await listProjectTasks({
      workspace_dir: args.workspace_dir,
      project_id: project.project_id
    }).catch(() => []);
    for (const task of tasks) {
      const fm = task.frontmatter;
      if (fm.status === "done" || fm.status === "canceled") continue;
      const plannedEndMs = parseIsoMs(fm.schedule?.planned_end);
      if (plannedEndMs === null) continue;
      const targets: string[] = [];
      if (fm.assignee_agent_id && workersById.has(fm.assignee_agent_id)) {
        targets.push(fm.assignee_agent_id);
      } else if (fm.team_id && workersByTeam.has(fm.team_id)) {
        targets.push(...(workersByTeam.get(fm.team_id) ?? []));
      }
      if (!targets.length) continue;

      if (plannedEndMs < nowMs) {
        for (const t of targets) {
          bump(overdueByWorker, t, 1);
          bumpWorkerProjectCounter(projectSignalScores, t, project.project_id, 2);
        }
      } else if (plannedEndMs <= nowMs + horizonMs) {
        for (const t of targets) {
          bump(dueByWorker, t, 1);
          bumpWorkerProjectCounter(projectSignalScores, t, project.project_id, 3);
        }
      }
    }

    const jobs = await listJobs({
      workspace_dir: args.workspace_dir,
      project_id: project.project_id,
      status: "running",
      limit: 5000
    }).catch(() => []);
    for (const job of jobs) {
      const lastAttempt = job.attempts.at(-1);
      const startedMs = parseIsoMs(lastAttempt?.started_at);
      const failedAttempts = job.attempts.filter((a) => a.status === "failed").length;
      const runningTooLong =
        startedMs !== null && nowMs - startedMs >= args.config.stuck_job_running_minutes * 60_000;
      const isStuck = runningTooLong || failedAttempts >= 2;
      if (!isStuck) continue;

      const target = lastAttempt?.worker_agent_id;
      if (target && workersById.has(target)) {
        bump(stuckByWorker, target, 1);
        bumpWorkerProjectCounter(projectSignalScores, target, project.project_id, 4);
      }
    }
  }

  const quietHours = isQuietHours(now, args.config.quiet_hours_start_hour, args.config.quiet_hours_end_hour);

  const candidates: HeartbeatWorkerCandidate[] = workers.map((worker) => {
    const newSignals = newSignalsByWorker.get(worker.agent_id) ?? 0;
    const dueTasks = dueByWorker.get(worker.agent_id) ?? 0;
    const overdueTasks = overdueByWorker.get(worker.agent_id) ?? 0;
    const stuckJobs = stuckByWorker.get(worker.agent_id) ?? 0;

    const contextObj = {
      worker_agent_id: worker.agent_id,
      worker_kind: workerKindFromProvider(worker.provider),
      new_signals: newSignals,
      due_tasks: dueTasks,
      overdue_tasks: overdueTasks,
      stuck_jobs: stuckJobs,
      run_event_cursor_entries: Object.keys(runEventCursors).length
    };
    const contextHash = sha256Hex(JSON.stringify(contextObj));
    const prev = args.state.worker_state[worker.agent_id];
    const noContextChange = prev?.last_context_hash === contextHash;
    const lastOkMs = parseIsoMs(prev?.last_ok_at);
    const recentOk =
      lastOkMs !== null && nowMs - lastOkMs <= args.config.ok_suppression_minutes * 60_000;

    let score = 0;
    const components = {
      new_signal_points: 0,
      due_points: 0,
      overdue_points: 0,
      stuck_points: 0,
      recent_ok_penalty: 0,
      quiet_hours_penalty: 0
    };

    if (newSignals > 0) {
      score += 5;
      components.new_signal_points = 5;
    }
    if (dueTasks > 0) {
      score += 3;
      components.due_points = 3;
    }
    if (overdueTasks > 0) {
      score += 2;
      components.overdue_points = 2;
    }
    if (stuckJobs > 0) {
      score += 4;
      components.stuck_points = 4;
    }
    if (noContextChange && recentOk) {
      score -= 3;
      components.recent_ok_penalty = -3;
    }
    if (quietHours) {
      score -= 2;
      components.quiet_hours_penalty = -2;
    }

    const suppressedUntilMs = parseIsoMs(prev?.suppressed_until);
    const suppressed =
      noContextChange && suppressedUntilMs !== null && suppressedUntilMs > nowMs;

    return {
      worker_agent_id: worker.agent_id,
      team_id: worker.team_id,
      score,
      components,
      counts: {
        new_signals: newSignals,
        due_tasks: dueTasks,
        overdue_tasks: overdueTasks,
        stuck_jobs: stuckJobs
      },
      context_hash: contextHash,
      suppressed,
      suppression_reason: suppressed
        ? `suppressed_until=${isoAt(suppressedUntilMs!)}`
        : undefined
    } satisfies HeartbeatWorkerCandidate;
  });

  const woken = [...candidates]
    .filter((c) => !c.suppressed && c.score >= args.config.min_wake_score)
    .sort((a, b) => (a.score !== b.score ? b.score - a.score : a.worker_agent_id.localeCompare(b.worker_agent_id)))
    .slice(0, args.config.top_k_workers)
    .map((c) => ({
      worker_agent_id: c.worker_agent_id,
      team_id: c.team_id,
      project_id: chooseWakeProjectId({
        worker_agent_id: c.worker_agent_id,
        project_signal_scores: projectSignalScores,
        latest_project_id: latestProjectByWorker.get(c.worker_agent_id)
      }),
      score: c.score,
      jitter_seconds: Math.floor(Math.max(0, Math.min(1, random())) * (args.config.jitter_max_seconds + 1)),
      context_hash: c.context_hash
    } satisfies HeartbeatWakeTarget));

  const contextHashes = Object.fromEntries(candidates.map((c) => [c.worker_agent_id, c.context_hash]));

  return {
    generated_at: now.toISOString(),
    run_event_cursors: runEventCursors,
    candidates,
    woken_workers: woken,
    context_hashes: contextHashes
  };
}
