import path from "node:path";
import { listAgents } from "../org/agents_list.js";
import { listProjects } from "../work/projects_list.js";
import { listIndexedRuns } from "../index/sqlite.js";
import type {
  HeartbeatConfig,
  HeartbeatState,
  HeartbeatWorkerReport
} from "../schemas/heartbeat.js";
import type { HeartbeatWakeTarget, HeartbeatWorkerCandidate } from "./heartbeat_triage.js";
import { buildHeartbeatTriage } from "./heartbeat_triage.js";
import {
  readHeartbeatConfig,
  readHeartbeatState,
  writeHeartbeatConfig,
  writeHeartbeatState
} from "./heartbeat_store.js";
import { submitJob, pollJob, collectJob } from "./job_runner.js";
import { applyHeartbeatWorkerReportActions } from "./heartbeat_actions.js";
import { newId } from "../core/ids.js";

type WorkspaceRuntime = {
  workspace_dir: string;
  observed: boolean;
  loop_running: boolean;
  tick_in_progress: boolean;
  timer: NodeJS.Timeout | null;
  next_scheduled_at?: string;
  last_error?: string;
  last_tick_summary?: HeartbeatTickSummary;
};

function workerKindFromProvider(provider: string): "codex" | "claude" | "gemini" {
  const p = provider.toLowerCase();
  if (p.startsWith("codex")) return "codex";
  if (p.startsWith("claude")) return "claude";
  return "gemini";
}

function parseIsoMs(value: string | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function newHeartbeatTickId(): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return `hbtick_${Date.now()}_${suffix}`;
}

function hashWorkerCandidates(candidates: HeartbeatWorkerCandidate[]): Record<string, HeartbeatWorkerCandidate> {
  const map: Record<string, HeartbeatWorkerCandidate> = {};
  for (const c of candidates) {
    map[c.worker_agent_id] = c;
  }
  return map;
}

function computeNextTickAt(config: HeartbeatConfig, baseMs: number): string {
  return new Date(baseMs + config.tick_interval_minutes * 60_000).toISOString();
}

async function waitForTerminalJob(args: {
  workspace_dir: string;
  project_id: string;
  job_id: string;
  timeout_ms: number;
  poll_interval_ms: number;
}): Promise<"queued" | "running" | "completed" | "canceled" | "timeout"> {
  const deadline = Date.now() + Math.max(1000, args.timeout_ms);
  while (Date.now() <= deadline) {
    const status = await pollJob({
      workspace_dir: args.workspace_dir,
      project_id: args.project_id,
      job_id: args.job_id
    });
    if (status.status === "completed" || status.status === "canceled") {
      return status.status;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(50, args.poll_interval_ms)));
  }
  return "timeout";
}

export type HeartbeatSubmittedJob = {
  worker_agent_id: string;
  project_id: string;
  job_id: string;
  jitter_seconds: number;
};

export type HeartbeatTickSummary = {
  tick_id: string;
  workspace_dir: string;
  reason: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  dry_run: boolean;
  enabled: boolean;
  skipped_due_to_running: boolean;
  skipped_reason?: string;
  config: HeartbeatConfig;
  candidates: HeartbeatWorkerCandidate[];
  woken_workers: HeartbeatWakeTarget[];
  jobs_submitted: HeartbeatSubmittedJob[];
  reports_processed: number;
  reports_ok: number;
  reports_actions: number;
  actions_executed: number;
  approvals_queued: number;
  deduped_actions: number;
  skipped_actions: number;
};

export type HeartbeatWorkspaceStatus = {
  workspace_dir: string;
  observed: boolean;
  config: HeartbeatConfig;
  state: HeartbeatState;
  runtime: {
    loop_running: boolean;
    tick_in_progress: boolean;
    next_scheduled_at?: string;
    last_error?: string;
    last_tick_summary?: HeartbeatTickSummary;
  };
};

export function resolveWakeProjectId(args: {
  wake_project_id?: string;
  worker_agent_id: string;
  latest_project_by_worker: Map<string, string>;
  global_fallback_project_id?: string;
}): string | undefined {
  if (args.wake_project_id) return args.wake_project_id;
  const latest = args.latest_project_by_worker.get(args.worker_agent_id);
  if (latest) return latest;
  return args.global_fallback_project_id;
}

export class HeartbeatService {
  private readonly runtimes = new Map<string, WorkspaceRuntime>();
  private closed = false;

  private key(workspaceDir: string): string {
    return path.resolve(workspaceDir);
  }

  private getOrCreateRuntime(workspaceDir: string): WorkspaceRuntime {
    const k = this.key(workspaceDir);
    const existing = this.runtimes.get(k);
    if (existing) return existing;
    const created: WorkspaceRuntime = {
      workspace_dir: workspaceDir,
      observed: false,
      loop_running: false,
      tick_in_progress: false,
      timer: null
    };
    this.runtimes.set(k, created);
    return created;
  }

  private clearTimer(runtime: WorkspaceRuntime): void {
    if (runtime.timer) {
      clearTimeout(runtime.timer);
      runtime.timer = null;
    }
    runtime.next_scheduled_at = undefined;
  }

  private async scheduleNextTick(workspaceDir: string): Promise<void> {
    if (this.closed) return;
    const runtime = this.getOrCreateRuntime(workspaceDir);
    if (!runtime.loop_running) return;
    this.clearTimer(runtime);

    const [config, state] = await Promise.all([
      readHeartbeatConfig(workspaceDir),
      readHeartbeatState(workspaceDir)
    ]);
    if (!config.enabled) return;

    const nowMs = Date.now();
    const explicitNextMs = parseIsoMs(state.next_tick_at);
    const nextMs =
      explicitNextMs !== null && explicitNextMs > nowMs
        ? explicitNextMs
        : nowMs + config.tick_interval_minutes * 60_000;
    const delayMs = Math.max(250, nextMs - nowMs);
    runtime.next_scheduled_at = new Date(nowMs + delayMs).toISOString();

    runtime.timer = setTimeout(() => {
      void this.tickWorkspace({
        workspace_dir: workspaceDir,
        reason: "interval"
      });
    }, delayMs);
    runtime.timer.unref?.();
  }

  async observeWorkspace(workspaceDir: string): Promise<void> {
    const runtime = this.getOrCreateRuntime(workspaceDir);
    runtime.observed = true;
    runtime.loop_running = true;
    await this.scheduleNextTick(workspaceDir);
  }

  async getConfig(args: { workspace_dir: string }): Promise<HeartbeatConfig> {
    return readHeartbeatConfig(args.workspace_dir);
  }

  async setConfig(args: {
    workspace_dir: string;
    config: Partial<HeartbeatConfig>;
  }): Promise<HeartbeatConfig> {
    const written = await writeHeartbeatConfig({
      workspace_dir: args.workspace_dir,
      config: args.config
    });
    const runtime = this.getOrCreateRuntime(args.workspace_dir);
    if (runtime.loop_running) {
      await this.scheduleNextTick(args.workspace_dir);
    }
    return written;
  }

  async getStatus(args: { workspace_dir: string }): Promise<HeartbeatWorkspaceStatus> {
    const runtime = this.getOrCreateRuntime(args.workspace_dir);
    const [config, state] = await Promise.all([
      readHeartbeatConfig(args.workspace_dir),
      readHeartbeatState(args.workspace_dir)
    ]);
    return {
      workspace_dir: args.workspace_dir,
      observed: runtime.observed,
      config,
      state,
      runtime: {
        loop_running: runtime.loop_running,
        tick_in_progress: runtime.tick_in_progress,
        next_scheduled_at: runtime.next_scheduled_at,
        last_error: runtime.last_error,
        last_tick_summary: runtime.last_tick_summary
      }
    };
  }

  async tickWorkspace(args: {
    workspace_dir: string;
    dry_run?: boolean;
    reason?: string;
    force?: boolean;
  }): Promise<HeartbeatTickSummary> {
    const runtime = this.getOrCreateRuntime(args.workspace_dir);
    const config = await readHeartbeatConfig(args.workspace_dir);
    const startedAt = nowIso();
    const tickId = newHeartbeatTickId();
    const reason = args.reason?.trim() || "manual";
    const dryRun = args.dry_run === true;

    if (runtime.tick_in_progress) {
      const finishedAt = nowIso();
      const skipped: HeartbeatTickSummary = {
        tick_id: tickId,
        workspace_dir: args.workspace_dir,
        reason,
        started_at: startedAt,
        finished_at: finishedAt,
        duration_ms: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
        dry_run: dryRun,
        enabled: config.enabled,
        skipped_due_to_running: true,
        skipped_reason: "tick_already_in_progress",
        config,
        candidates: [],
        woken_workers: [],
        jobs_submitted: [],
        reports_processed: 0,
        reports_ok: 0,
        reports_actions: 0,
        actions_executed: 0,
        approvals_queued: 0,
        deduped_actions: 0,
        skipped_actions: 0
      };
      runtime.last_tick_summary = skipped;
      return skipped;
    }

    runtime.tick_in_progress = true;
    runtime.last_error = undefined;
    this.clearTimer(runtime);

    let state = await readHeartbeatState(args.workspace_dir);
    state.running = true;
    state.last_tick_id = tickId;
    state.last_tick_reason = reason;
    state.last_tick_at = startedAt;
    await writeHeartbeatState({ workspace_dir: args.workspace_dir, state });

    try {
      if (!config.enabled && !args.force) {
        state.running = false;
        state.next_tick_at = computeNextTickAt(config, Date.now());
        await writeHeartbeatState({ workspace_dir: args.workspace_dir, state });
        const finishedAt = nowIso();
        const summary: HeartbeatTickSummary = {
          tick_id: tickId,
          workspace_dir: args.workspace_dir,
          reason,
          started_at: startedAt,
          finished_at: finishedAt,
          duration_ms: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
          dry_run: dryRun,
          enabled: false,
          skipped_due_to_running: false,
          skipped_reason: "heartbeat_disabled",
          config,
          candidates: [],
          woken_workers: [],
          jobs_submitted: [],
          reports_processed: 0,
          reports_ok: 0,
          reports_actions: 0,
          actions_executed: 0,
          approvals_queued: 0,
          deduped_actions: 0,
          skipped_actions: 0
        };
        runtime.last_tick_summary = summary;
        return summary;
      }

      const triage = await buildHeartbeatTriage({
        workspace_dir: args.workspace_dir,
        config,
        state
      });
      state.run_event_cursors = triage.run_event_cursors;

      for (const candidate of triage.candidates) {
        const prev = state.worker_state[candidate.worker_agent_id] ?? {};
        state.worker_state[candidate.worker_agent_id] = {
          ...prev,
          last_context_hash: candidate.context_hash
        };
      }

      const candidateByWorker = hashWorkerCandidates(triage.candidates);
      const submittedJobs: HeartbeatSubmittedJob[] = [];
      let reportsProcessed = 0;
      let reportsOk = 0;
      let reportsActions = 0;
      let actionsExecuted = 0;
      let approvalsQueued = 0;
      let dedupedActions = 0;
      let skippedActions = 0;

      if (!dryRun) {
        const [agents, projects, indexedRuns] = await Promise.all([
          listAgents({ workspace_dir: args.workspace_dir }),
          listProjects({ workspace_dir: args.workspace_dir }),
          listIndexedRuns({ workspace_dir: args.workspace_dir, limit: 5000 }).catch(() => [])
        ]);
        const latestProjectByWorker = new Map<string, string>();
        for (const run of indexedRuns) {
          if (!latestProjectByWorker.has(run.agent_id)) {
            latestProjectByWorker.set(run.agent_id, run.project_id);
          }
        }
        const globalFallbackProjectId = projects[0]?.project_id;
        const agentById = new Map(agents.map((a) => [a.agent_id, a]));
        const coordinatorActorId =
          config.hierarchy_mode === "enterprise_v1" && config.executive_manager_agent_id
            ? config.executive_manager_agent_id
            : "heartbeat_coordinator";

        const wakeTargets = [...triage.woken_workers].sort((a, b) => {
          const roleRank = (agentId: string): number => {
            const role = agentById.get(agentId)?.role;
            if (role === "director") return 0;
            if (role === "worker") return 1;
            if (role === "manager") return 2;
            return 3;
          };
          const rankDiff = roleRank(a.worker_agent_id) - roleRank(b.worker_agent_id);
          if (rankDiff !== 0) return rankDiff;
          return a.worker_agent_id.localeCompare(b.worker_agent_id);
        });

        for (const wake of wakeTargets) {
          const agent = agentById.get(wake.worker_agent_id);
          if (!agent) continue;
          const routedProjectId = resolveWakeProjectId({
            wake_project_id: wake.project_id,
            worker_agent_id: wake.worker_agent_id,
            latest_project_by_worker: latestProjectByWorker,
            global_fallback_project_id: globalFallbackProjectId
          });
          if (!routedProjectId) continue;
          const targetRoleHint = agent.role === "director" ? "director" : "worker";
          const context = candidateByWorker[wake.worker_agent_id];
          const note = context
            ? `signals=${context.counts.new_signals}, due=${context.counts.due_tasks}, overdue=${context.counts.overdue_tasks}, stuck=${context.counts.stuck_jobs}, score=${wake.score}`
            : `score=${wake.score}`;
          const submitted = await submitJob({
            job: {
              schema_version: 1,
              type: "job",
              job_id: newId("job"),
              job_kind: "heartbeat",
              worker_kind: workerKindFromProvider(agent.provider),
              workspace_dir: args.workspace_dir,
              project_id: routedProjectId,
              goal: `Heartbeat triage check for worker ${wake.worker_agent_id}`,
              constraints: [
                "Use heartbeat_worker_report contract",
                "Return HEARTBEAT_OK only when no action is required"
              ],
              deliverables: ["Heartbeat worker report JSON"],
              permission_level: "read-only",
              context_refs: [
                { kind: "note", value: note },
                { kind: "note", value: `target_role=${targetRoleHint}` }
              ],
              max_context_refs: 8,
              worker_agent_id: wake.worker_agent_id,
              manager_actor_id: coordinatorActorId,
              manager_role: "manager"
            }
          });
          submittedJobs.push({
            worker_agent_id: wake.worker_agent_id,
            project_id: submitted.project_id,
            job_id: submitted.job_id,
            jitter_seconds: wake.jitter_seconds
          });
          const workerState = state.worker_state[wake.worker_agent_id] ?? {};
          state.worker_state[wake.worker_agent_id] = {
            ...workerState,
            last_wake_at: startedAt
          };
        }

        for (const submitted of submittedJobs) {
          const terminal = await waitForTerminalJob({
            workspace_dir: args.workspace_dir,
            project_id: submitted.project_id,
            job_id: submitted.job_id,
            timeout_ms: 120_000,
            poll_interval_ms: 250
          });
          if (terminal === "timeout") continue;
          if (terminal === "canceled") continue;

          const collected = await collectJob({
            workspace_dir: args.workspace_dir,
            project_id: submitted.project_id,
            job_id: submitted.job_id
          });
          const report = collected.heartbeat_report;
          if (!report) continue;

          reportsProcessed += 1;
          if (report.status === "ok") {
            reportsOk += 1;
            const ws = state.worker_state[submitted.worker_agent_id] ?? {};
            state.worker_state[submitted.worker_agent_id] = {
              ...ws,
              last_ok_at: nowIso(),
              last_report_status: "ok",
              suppressed_until: new Date(
                Date.now() + config.ok_suppression_minutes * 60_000
              ).toISOString()
            };
          } else {
            reportsActions += 1;
            const ws = state.worker_state[submitted.worker_agent_id] ?? {};
            state.worker_state[submitted.worker_agent_id] = {
              ...ws,
              last_report_status: "actions",
              suppressed_until: undefined
            };
          }

          const sourceAttempt = collected.attempts.at(-1);
          const sourceAgent = agentById.get(submitted.worker_agent_id);
          const directorAutoActor =
            config.hierarchy_mode === "enterprise_v1" &&
            config.allow_director_to_spawn_workers &&
            sourceAgent?.role === "director";
          const applied = await applyHeartbeatWorkerReportActions({
            workspace_dir: args.workspace_dir,
            report: report as HeartbeatWorkerReport,
            source_worker_agent_id: submitted.worker_agent_id,
            source_run_id: sourceAttempt?.run_id ?? "run_heartbeat",
            source_context_pack_id: sourceAttempt?.context_pack_id ?? "ctx_heartbeat",
            config,
            state,
            actor_id: directorAutoActor ? sourceAgent.agent_id : coordinatorActorId,
            actor_role: directorAutoActor ? "director" : "manager",
            actor_team_id: directorAutoActor ? sourceAgent.team_id : undefined
          });
          actionsExecuted += applied.summary.executed_actions;
          approvalsQueued += applied.summary.queued_for_approval;
          dedupedActions += applied.summary.deduped_actions;
          skippedActions += applied.summary.skipped_actions;
        }
      }

      state.stats.ticks_total += 1;
      state.stats.workers_woken_total += triage.woken_workers.length;
      state.stats.reports_ok_total += reportsOk;
      state.stats.reports_actions_total += reportsActions;
      state.stats.actions_executed_total += actionsExecuted;
      state.stats.approvals_queued_total += approvalsQueued;
      state.stats.deduped_actions_total += dedupedActions;
      state.running = false;
      state.next_tick_at = computeNextTickAt(config, Date.now());

      await writeHeartbeatState({
        workspace_dir: args.workspace_dir,
        state
      });

      const finishedAt = nowIso();
      const summary: HeartbeatTickSummary = {
        tick_id: tickId,
        workspace_dir: args.workspace_dir,
        reason,
        started_at: startedAt,
        finished_at: finishedAt,
        duration_ms: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
        dry_run: dryRun,
        enabled: true,
        skipped_due_to_running: false,
        config,
        candidates: triage.candidates,
        woken_workers: triage.woken_workers,
        jobs_submitted: dryRun ? [] : submittedJobs,
        reports_processed: reportsProcessed,
        reports_ok: reportsOk,
        reports_actions: reportsActions,
        actions_executed: actionsExecuted,
        approvals_queued: approvalsQueued,
        deduped_actions: dedupedActions,
        skipped_actions: skippedActions
      };
      runtime.last_tick_summary = summary;
      return summary;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      runtime.last_error = message;
      state.running = false;
      state.next_tick_at = computeNextTickAt(config, Date.now());
      await writeHeartbeatState({
        workspace_dir: args.workspace_dir,
        state
      });
      throw error;
    } finally {
      runtime.tick_in_progress = false;
      if (runtime.loop_running && !this.closed) {
        await this.scheduleNextTick(args.workspace_dir);
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const runtime of this.runtimes.values()) {
      runtime.loop_running = false;
      this.clearTimer(runtime);
    }
  }
}

let DEFAULT_HEARTBEAT_SERVICE: HeartbeatService | null = null;

export function setDefaultHeartbeatService(service: HeartbeatService | null): void {
  DEFAULT_HEARTBEAT_SERVICE = service;
}

export function getDefaultHeartbeatService(): HeartbeatService {
  if (!DEFAULT_HEARTBEAT_SERVICE) {
    DEFAULT_HEARTBEAT_SERVICE = new HeartbeatService();
  }
  return DEFAULT_HEARTBEAT_SERVICE;
}
