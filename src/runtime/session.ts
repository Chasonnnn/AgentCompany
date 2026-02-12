import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { nowIso } from "../core/time.js";
import { readYamlFile, writeYamlFile } from "../store/yaml.js";
import { ensureDir, writeFileAtomic } from "../store/fs.js";
import { RunYaml } from "../schemas/run.js";
import { AgentYaml } from "../schemas/agent.js";
import { enforcePolicy } from "../policy/enforce.js";
import type { ActorRole } from "../policy/policy.js";
import { executeCommandRun, type ExecuteCommandArgs, type ExecuteCommandResult } from "./execute_command.js";
import { appendEventJsonl, newEnvelope } from "./events.js";
import { withLaunchLane, type LaunchLanePriority } from "./launch_lane.js";
import { transitionSessionStatus, type SessionStatus } from "./session_state.js";
import { evaluateBudgetPreflight } from "./budget.js";
import {
  executeCodexAppServerRun,
  type ExecuteCodexAppServerResult
} from "./execute_codex_app_server.js";

export type LaunchSessionArgs = ExecuteCommandArgs & {
  session_ref?: string;
  prompt_text?: string;
  model?: string;
  lane_priority?: LaunchLanePriority;
  lane_workspace_limit?: number;
  lane_provider_limit?: number;
  lane_team_limit?: number;
  actor_id?: string;
  actor_role?: ActorRole;
  actor_team_id?: string;
};

export type SessionPollResult = {
  session_ref: string;
  project_id: string;
  run_id: string;
  status: SessionStatus;
  exit_code: number | null;
  signal: string | null;
  error?: string;
};

export type SessionCollectResult = SessionPollResult & {
  events_relpath: string;
  output_relpaths: string[];
};

export type SessionListArgs = {
  workspace_dir?: string;
  project_id?: string;
  run_id?: string;
  status?: SessionStatus;
};

export type SessionListItem = SessionPollResult & {
  workspace_dir: string;
  started_at_ms: number;
  ended_at_ms?: number;
  mode: "command" | "codex_app_server";
  pid?: number;
  pid_claimed_at_ms?: number;
  stop_marker_relpath?: string;
  protocol_thread_id?: string;
  protocol_turn_id?: string;
};

export type SessionLookup = {
  workspace_dir?: string;
};

type SessionRecord = {
  session_ref: string;
  project_id: string;
  run_id: string;
  status: SessionStatus;
  abort_controller: AbortController;
  promise: Promise<void>;
  result: ExecuteCommandResult | ExecuteCodexAppServerResult | null;
  error?: string;
  workspace_dir: string;
  started_at_ms: number;
  ended_at_ms?: number;
  mode: "command" | "codex_app_server";
  pid?: number;
  pid_claimed_at_ms?: number;
  stop_marker_relpath?: string;
  protocol_thread_id?: string;
  protocol_turn_id?: string;
};

const PersistedSessionRecord = z.object({
  schema_version: z.literal(1),
  type: z.literal("session_record"),
  session_ref: z.string().min(1),
  workspace_dir: z.string().min(1),
  project_id: z.string().min(1),
  run_id: z.string().min(1),
  status: z.enum(["running", "ended", "failed", "stopped"]),
  exit_code: z.number().int().nullable(),
  signal: z.string().nullable(),
  error: z.string().optional(),
  started_at_ms: z.number().int().nonnegative(),
  ended_at_ms: z.number().int().nonnegative().optional(),
  mode: z.enum(["command", "codex_app_server"]).default("command"),
  pid: z.number().int().positive().optional(),
  pid_claimed_at_ms: z.number().int().nonnegative().optional(),
  stop_marker_relpath: z.string().min(1).optional(),
  protocol_thread_id: z.string().min(1).optional(),
  protocol_turn_id: z.string().min(1).optional()
});

const SESSIONS = new Map<string, SessionRecord>();
const DETACHED_PID_REUSE_GUARD_MS = 30 * 60 * 1000;
const LAUNCH_METADATA_WAIT_MS = 800;
const LAUNCH_METADATA_POLL_MS = 20;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function runYamlPath(workspaceDir: string, projectId: string, runId: string): string {
  return path.join(workspaceDir, "work/projects", projectId, "runs", runId, "run.yaml");
}

function sessionsDir(workspaceDir: string): string {
  return path.join(workspaceDir, ".local", "sessions");
}

function sessionRecordPath(workspaceDir: string, sessionRef: string): string {
  return path.join(sessionsDir(workspaceDir), `${encodeURIComponent(sessionRef)}.yaml`);
}

function toListItem(rec: SessionRecord): SessionListItem {
  return {
    session_ref: rec.session_ref,
    workspace_dir: rec.workspace_dir,
    project_id: rec.project_id,
    run_id: rec.run_id,
    status: rec.status,
    exit_code: rec.result?.exit_code ?? null,
    signal: rec.result?.signal ?? null,
    error: rec.error,
    started_at_ms: rec.started_at_ms,
    ended_at_ms: rec.ended_at_ms,
    mode: rec.mode,
    pid: rec.pid,
    pid_claimed_at_ms: rec.pid_claimed_at_ms,
    stop_marker_relpath: rec.stop_marker_relpath,
    protocol_thread_id: rec.protocol_thread_id,
    protocol_turn_id: rec.protocol_turn_id
  };
}

function toPollResult(item: SessionListItem): SessionPollResult {
  return {
    session_ref: item.session_ref,
    project_id: item.project_id,
    run_id: item.run_id,
    status: item.status,
    exit_code: item.exit_code,
    signal: item.signal,
    error: item.error
  };
}

function matchesSessionFilters(item: SessionListItem, filters: SessionListArgs): boolean {
  if (filters.workspace_dir && item.workspace_dir !== filters.workspace_dir) return false;
  if (filters.project_id && item.project_id !== filters.project_id) return false;
  if (filters.run_id && item.run_id !== filters.run_id) return false;
  if (filters.status && item.status !== filters.status) return false;
  return true;
}

async function readRunStatus(
  workspaceDir: string,
  projectId: string,
  runId: string
): Promise<SessionStatus> {
  const run = RunYaml.parse(await readYamlFile(runYamlPath(workspaceDir, projectId, runId)));
  return run.status;
}

function isCodexAppServerProvider(provider: string): boolean {
  return provider === "codex_app_server" || provider === "codex-app-server";
}

async function readAgentTeamId(workspaceDir: string, agentId: string): Promise<string | undefined> {
  const p = path.join(workspaceDir, "org", "agents", agentId, "agent.yaml");
  try {
    const doc = AgentYaml.parse(await readYamlFile(p));
    return doc.team_id;
  } catch {
    return undefined;
  }
}

function summarizeBudgetFindings(
  findings: Array<{ scope: string; metric: string; severity: string; threshold: number; actual: number }>
): string {
  return findings
    .map(
      (f) =>
        `${f.scope}.${f.metric}.${f.severity}: actual=${Number(f.actual)} threshold=${Number(f.threshold)}`
    )
    .join("; ");
}

async function appendBudgetPreflightEvents(args: {
  workspace_dir: string;
  project_id: string;
  run_id: string;
  session_ref: string;
  decisions: Array<Record<string, unknown>>;
  alerts: Array<Record<string, unknown>>;
  exceeded: Array<Record<string, unknown>>;
}): Promise<void> {
  const eventsPath = path.join(
    args.workspace_dir,
    "work/projects",
    args.project_id,
    "runs",
    args.run_id,
    "events.jsonl"
  );
  const now = nowIso();
  for (const decision of args.decisions) {
    await appendEventJsonl(
      eventsPath,
      newEnvelope({
        schema_version: 1,
        ts_wallclock: now,
        run_id: args.run_id,
        session_ref: args.session_ref,
        actor: "system",
        visibility: "org",
        type: "budget.decision",
        payload: { ...decision, phase: "preflight" }
      })
    );
  }
  for (const finding of args.alerts) {
    await appendEventJsonl(
      eventsPath,
      newEnvelope({
        schema_version: 1,
        ts_wallclock: now,
        run_id: args.run_id,
        session_ref: args.session_ref,
        actor: "system",
        visibility: "org",
        type: "budget.alert",
        payload: { ...finding, phase: "preflight" }
      })
    );
  }
  for (const finding of args.exceeded) {
    await appendEventJsonl(
      eventsPath,
      newEnvelope({
        schema_version: 1,
        ts_wallclock: now,
        run_id: args.run_id,
        session_ref: args.session_ref,
        actor: "system",
        visibility: "org",
        type: "budget.exceeded",
        payload: { ...finding, phase: "preflight" }
      })
    );
  }
}

async function markRunPrelaunchFailure(args: {
  workspace_dir: string;
  project_id: string;
  run_id: string;
  session_ref: string;
  reason: string;
  error: string;
  budget_exceeded?: boolean;
}): Promise<void> {
  const runPath = runYamlPath(args.workspace_dir, args.project_id, args.run_id);
  const endedAt = nowIso();
  try {
    const run = RunYaml.parse(await readYamlFile(runPath));
    if (run.status === "running") {
      await writeYamlFile(runPath, {
        ...run,
        status: "failed",
        ended_at: endedAt
      });
    }
  } catch {
    // Best-effort fallback: failure event is still appended below.
  }

  const eventsPath = path.join(
    args.workspace_dir,
    "work/projects",
    args.project_id,
    "runs",
    args.run_id,
    "events.jsonl"
  );
  await appendEventJsonl(
    eventsPath,
    newEnvelope({
      schema_version: 1,
      ts_wallclock: endedAt,
      run_id: args.run_id,
      session_ref: args.session_ref,
      actor: "system",
      visibility: "org",
      type: "run.failed",
      payload: {
        exit_code: null,
        signal: null,
        stopped: false,
        preflight: true,
        reason: args.reason,
        error: args.error,
        budget_exceeded: args.budget_exceeded === true
      }
    })
  ).catch(() => {});
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code !== "ESRCH";
  }
}

async function markOrphanedDetachedSession(item: SessionListItem): Promise<SessionListItem> {
  const endedAt = nowIso();
  const endedAtMs = Date.now();
  const stopMarkerRel =
    item.stop_marker_relpath ?? path.join("runs", item.run_id, "outputs", "stop_requested.flag");
  const stopMarkerAbs = path.join(item.workspace_dir, "work/projects", item.project_id, stopMarkerRel);
  const stopRequested = await fs
    .access(stopMarkerAbs)
    .then(() => true)
    .catch(() => false);
  const reconciledStatus: SessionStatus = stopRequested ? "stopped" : "failed";
  const runPath = runYamlPath(item.workspace_dir, item.project_id, item.run_id);
  try {
    const run = RunYaml.parse(await readYamlFile(runPath));
    if (run.status === "running") {
      await writeYamlFile(runPath, { ...run, status: reconciledStatus, ended_at: endedAt });
      const eventsPath = path.join(
        item.workspace_dir,
        "work/projects",
        item.project_id,
        "runs",
        item.run_id,
        "events.jsonl"
      );
      await appendEventJsonl(
        eventsPath,
        newEnvelope({
          schema_version: 1,
          ts_wallclock: endedAt,
          run_id: item.run_id,
          session_ref: item.session_ref,
          actor: "system",
          visibility: "org",
          type: reconciledStatus === "stopped" ? "run.stopped" : "run.failed",
          payload: {
            exit_code: null,
            signal: null,
            stopped: reconciledStatus === "stopped",
            orphaned: true
          }
        })
      ).catch(() => {});
    }
  } catch {
    // If run.yaml is unreadable, still reconcile the detached session record itself.
  }

  const reconciled: SessionListItem = {
    ...item,
    status: transitionSessionStatus(item.status, reconciledStatus),
    ended_at_ms: item.ended_at_ms ?? endedAtMs,
    error:
      item.error ??
      (reconciledStatus === "stopped"
        ? "Reconciled detached stop request after process exit."
        : "Reconciled orphaned detached session (pid not running).")
  };
  await persistSessionItem(reconciled);
  return reconciled;
}

async function persistSessionItem(item: SessionListItem): Promise<void> {
  await ensureDir(sessionsDir(item.workspace_dir));
  await writeYamlFile(sessionRecordPath(item.workspace_dir, item.session_ref), {
    schema_version: 1,
    type: "session_record",
    session_ref: item.session_ref,
    workspace_dir: item.workspace_dir,
    project_id: item.project_id,
    run_id: item.run_id,
    status: item.status,
    exit_code: item.exit_code,
    signal: item.signal,
    error: item.error,
    started_at_ms: item.started_at_ms,
    ended_at_ms: item.ended_at_ms,
    mode: item.mode,
    pid: item.pid,
    pid_claimed_at_ms: item.pid_claimed_at_ms,
    stop_marker_relpath: item.stop_marker_relpath,
    protocol_thread_id: item.protocol_thread_id,
    protocol_turn_id: item.protocol_turn_id
  });
}

async function loadPersistedSession(
  workspaceDir: string,
  sessionRef: string
): Promise<SessionListItem | null> {
  const p = sessionRecordPath(workspaceDir, sessionRef);
  try {
    const rec = PersistedSessionRecord.parse(await readYamlFile(p));
    return {
      session_ref: rec.session_ref,
      workspace_dir: rec.workspace_dir,
      project_id: rec.project_id,
      run_id: rec.run_id,
      status: rec.status,
      exit_code: rec.exit_code,
      signal: rec.signal,
      error: rec.error,
      started_at_ms: rec.started_at_ms,
      ended_at_ms: rec.ended_at_ms,
      mode: rec.mode,
      pid: rec.pid,
      pid_claimed_at_ms: rec.pid_claimed_at_ms,
      stop_marker_relpath: rec.stop_marker_relpath,
      protocol_thread_id: rec.protocol_thread_id,
      protocol_turn_id: rec.protocol_turn_id
    };
  } catch {
    return null;
  }
}

async function reconcilePersistedSession(item: SessionListItem): Promise<SessionListItem> {
  if (item.status !== "running") return item;
  try {
    const run = RunYaml.parse(
      await readYamlFile(runYamlPath(item.workspace_dir, item.project_id, item.run_id))
    );
    if (run.status !== "running") {
      return {
        ...item,
        status: transitionSessionStatus(item.status, run.status),
        ended_at_ms: item.ended_at_ms ?? (run.ended_at ? Date.parse(run.ended_at) : undefined)
      };
    }
    if (item.pid) {
      const stopMarkerRel =
        item.stop_marker_relpath ?? path.join("runs", item.run_id, "outputs", "stop_requested.flag");
      const stopMarkerAbs = path.join(item.workspace_dir, "work/projects", item.project_id, stopMarkerRel);
      const stopRequested = await fs
        .access(stopMarkerAbs)
        .then(() => true)
        .catch(() => false);
      if (stopRequested && isProcessAlive(item.pid)) {
        try {
          process.kill(item.pid, "SIGKILL");
        } catch {
          // Best-effort escalation for detached stop requests.
        }
      }
      if (!isProcessAlive(item.pid)) {
        return markOrphanedDetachedSession(item);
      }
    }
    return {
      ...item,
      error: item.error ?? "Session process is detached from this runtime (possible restart)."
    };
  } catch {
    return item;
  }
}

async function listPersistedSessions(workspaceDir: string): Promise<SessionListItem[]> {
  let files: string[] = [];
  try {
    files = (await fs.readdir(sessionsDir(workspaceDir)))
      .filter((f) => f.endsWith(".yaml"))
      .sort();
  } catch {
    return [];
  }

  const out: SessionListItem[] = [];
  for (const fileName of files) {
    const rawRef = fileName.slice(0, -5);
    const sessionRef = decodeURIComponent(rawRef);
    const loaded = await loadPersistedSession(workspaceDir, sessionRef);
    if (!loaded) continue;
    out.push(await reconcilePersistedSession(loaded));
  }
  return out;
}

async function resolveSessionSnapshot(
  session_ref: string,
  lookup: SessionLookup
): Promise<SessionListItem> {
  const live = SESSIONS.get(session_ref);
  if (live) return toListItem(live);

  if (!lookup.workspace_dir) {
    throw new Error(`Unknown session_ref: ${session_ref}. Provide workspace_dir for persisted lookup.`);
  }
  const persisted = await loadPersistedSession(lookup.workspace_dir, session_ref);
  if (!persisted) {
    throw new Error(`Unknown session_ref: ${session_ref}`);
  }
  return await reconcilePersistedSession(persisted);
}

export async function launchSession(args: LaunchSessionArgs): Promise<{ session_ref: string }> {
  const runDoc = RunYaml.parse(
    await readYamlFile(runYamlPath(args.workspace_dir, args.project_id, args.run_id))
  );
  const agentTeamId = await readAgentTeamId(args.workspace_dir, runDoc.agent_id);

  return withLaunchLane(
    args.workspace_dir,
    {
      provider: runDoc.provider,
      team_id: agentTeamId,
      priority: args.lane_priority ?? "normal",
      workspace_limit: args.lane_workspace_limit,
      provider_limit: args.lane_provider_limit,
      team_limit: args.lane_team_limit
    },
    async () => {
      const sessionRef = args.session_ref ?? `local_${args.run_id}`;
      const actorId = args.actor_id?.trim() ? args.actor_id.trim() : "human";
      const actorRole = args.actor_role ?? "human";
      const actorTeamId = args.actor_team_id?.trim() ? args.actor_team_id.trim() : undefined;
      try {
        await enforcePolicy({
          workspace_dir: args.workspace_dir,
          project_id: args.project_id,
          run_id: args.run_id,
          actor_id: actorId,
          actor_role: actorRole,
          actor_team_id: actorTeamId,
          action: "launch",
          resource: {
            resource_id: args.run_id,
            kind: "run",
            visibility: agentTeamId ? "team" : "org",
            team_id: agentTeamId,
            producing_actor_id: runDoc.agent_id
          }
        });

        const preflight = await evaluateBudgetPreflight({
          workspace_dir: args.workspace_dir,
          project_id: args.project_id,
          task_id: args.task_id,
          run_budget: args.budget
        });
        await appendBudgetPreflightEvents({
          workspace_dir: args.workspace_dir,
          project_id: args.project_id,
          run_id: args.run_id,
          session_ref: sessionRef,
          decisions: preflight.decisions.map((d) => ({ ...d })),
          alerts: preflight.alerts.map((d) => ({ ...d })),
          exceeded: preflight.exceeded.map((d) => ({ ...d }))
        });
        if (preflight.exceeded.length > 0) {
          throw new Error(
            `Budget preflight blocked launch: ${summarizeBudgetFindings(preflight.exceeded)}`
          );
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const lower = msg.toLowerCase();
        const isPolicy = lower.includes("policy denied");
        const isBudget = lower.includes("budget preflight");
        await markRunPrelaunchFailure({
          workspace_dir: args.workspace_dir,
          project_id: args.project_id,
          run_id: args.run_id,
          session_ref: sessionRef,
          reason: isPolicy
            ? "policy_denied"
            : isBudget
              ? "budget_preflight_exceeded"
              : "launch_preflight_failed",
          error: msg,
          budget_exceeded: isBudget
        });
        throw e;
      }

      const protocolMode = isCodexAppServerProvider(runDoc.provider);
      const protocolPrompt = args.prompt_text ?? args.stdin_text;
      const existing = SESSIONS.get(sessionRef);
      if (existing && existing.status === "running") {
        throw new Error(`Session already running: ${sessionRef}`);
      }

      const abortController = new AbortController();
      const rec: SessionRecord = {
        session_ref: sessionRef,
        project_id: args.project_id,
        run_id: args.run_id,
        status: "running",
        abort_controller: abortController,
        result: null,
        workspace_dir: args.workspace_dir,
        promise: Promise.resolve(),
        started_at_ms: Date.now(),
        mode: protocolMode ? "codex_app_server" : "command"
      };
      SESSIONS.set(sessionRef, rec);
      await persistSessionItem(toListItem(rec));

      rec.promise = (async () => {
        try {
          if (protocolMode) {
            if (!protocolPrompt || !protocolPrompt.trim()) {
              throw new Error(
                "prompt_text (or stdin_text) is required for codex_app_server session launches"
              );
            }
            rec.result = await executeCodexAppServerRun({
              workspace_dir: args.workspace_dir,
              project_id: args.project_id,
              run_id: args.run_id,
              prompt_text: protocolPrompt,
              model: args.model,
              repo_id: args.repo_id,
              workdir_rel: args.workdir_rel,
              task_id: args.task_id,
              milestone_id: args.milestone_id,
              budget: args.budget,
              env: args.env,
              session_ref: sessionRef,
              on_state_update: ({ pid, stop_marker_relpath, thread_id, turn_id }) => {
                if (pid !== undefined) {
                  rec.pid = pid;
                  rec.pid_claimed_at_ms = Date.now();
                }
                if (stop_marker_relpath !== undefined) rec.stop_marker_relpath = stop_marker_relpath;
                if (thread_id !== undefined) rec.protocol_thread_id = thread_id;
                if (turn_id !== undefined) rec.protocol_turn_id = turn_id;
                void persistSessionItem(toListItem(rec)).catch(() => {});
              },
              abort_signal: abortController.signal
            });
          } else {
            rec.result = await executeCommandRun({
              ...args,
              session_ref: sessionRef,
              on_child_spawn: ({ pid, stop_marker_relpath }) => {
                rec.pid = pid;
                rec.pid_claimed_at_ms = Date.now();
                rec.stop_marker_relpath = stop_marker_relpath;
                void persistSessionItem(toListItem(rec)).catch(() => {});
              },
              abort_signal: abortController.signal
            });
          }
          rec.status = transitionSessionStatus(
            rec.status,
            await readRunStatus(args.workspace_dir, args.project_id, args.run_id)
          );
        } catch (e) {
          rec.status = transitionSessionStatus(rec.status, "failed");
          rec.error = e instanceof Error ? e.message : String(e);
        } finally {
          rec.ended_at_ms = Date.now();
          await persistSessionItem(toListItem(rec));
        }
      })();

      const end = Date.now() + LAUNCH_METADATA_WAIT_MS;
      while (Date.now() < end) {
        if (rec.pid !== undefined) break;
        if (rec.status !== "running") break;
        await sleep(LAUNCH_METADATA_POLL_MS);
      }
      await persistSessionItem(toListItem(rec));

      return { session_ref: sessionRef };
    }
  );
}

export async function pollSession(
  session_ref: string,
  lookup: SessionLookup = {}
): Promise<SessionPollResult> {
  const item = await resolveSessionSnapshot(session_ref, lookup);
  return toPollResult(item);
}

async function collectFromSessionItem(item: SessionListItem): Promise<SessionCollectResult> {
  const runDir = path.join(item.workspace_dir, "work/projects", item.project_id, "runs", item.run_id);
  const outputsDir = path.join(runDir, "outputs");
  let outputRelpaths: string[] = [];
  try {
    const entries = await fs.readdir(outputsDir, { withFileTypes: true });
    outputRelpaths = entries
      .filter((e) => e.isFile())
      .map((e) => path.join("runs", item.run_id, "outputs", e.name))
      .sort();
  } catch {
    // no outputs
  }

  const poll = toPollResult(item);
  return {
    ...poll,
    events_relpath: path.join("runs", item.run_id, "events.jsonl"),
    output_relpaths: outputRelpaths
  };
}

export async function collectSession(
  session_ref: string,
  lookup: SessionLookup = {}
): Promise<SessionCollectResult> {
  const live = SESSIONS.get(session_ref);
  if (live) {
    await live.promise;
    return collectFromSessionItem(toListItem(live));
  }
  const persisted = await resolveSessionSnapshot(session_ref, lookup);
  return collectFromSessionItem(persisted);
}

export async function stopSession(
  session_ref: string,
  lookup: SessionLookup = {}
): Promise<SessionPollResult> {
  const live = SESSIONS.get(session_ref);
  if (live) {
    if (live.status === "running") {
      live.abort_controller.abort();
    }
    return pollSession(session_ref, lookup);
  }

  const persisted = await resolveSessionSnapshot(session_ref, lookup);
  if (persisted.status === "running") {
    if (persisted.pid) {
      if (!isProcessAlive(persisted.pid)) {
        const reconciled = await markOrphanedDetachedSession(persisted);
        return toPollResult(reconciled);
      }
      if (
        persisted.pid_claimed_at_ms !== undefined &&
        Date.now() - persisted.pid_claimed_at_ms > DETACHED_PID_REUSE_GUARD_MS
      ) {
        return {
          ...toPollResult(persisted),
          error:
            "Refusing to signal detached session pid: fingerprint is stale and PID may have been reused. Relaunch session control to proceed safely."
        };
      }
      const stopMarkerRel =
        persisted.stop_marker_relpath ??
        path.join("runs", persisted.run_id, "outputs", "stop_requested.flag");
      const stopMarkerAbs = path.join(
        persisted.workspace_dir,
        "work/projects",
        persisted.project_id,
        stopMarkerRel
      );
      await writeFileAtomic(stopMarkerAbs, new Date().toISOString()).catch(() => {});
      try {
        process.kill(persisted.pid, "SIGTERM");
        setTimeout(() => {
          try {
            process.kill(persisted.pid!, "SIGKILL");
          } catch {
            // already exited
          }
        }, 1500).unref();
        return {
          ...toPollResult(persisted),
          error: "Stop signal sent to detached session process."
        };
      } catch (e) {
        return {
          ...toPollResult(persisted),
          error: `Failed to stop detached session pid=${persisted.pid}: ${
            e instanceof Error ? e.message : String(e)
          }`
        };
      }
    }
    return {
      ...toPollResult(persisted),
      error:
        persisted.error ??
        "Cannot stop detached session: process handle is unavailable in this runtime."
    };
  }
  return toPollResult(persisted);
}

export async function listSessions(filters: SessionListArgs = {}): Promise<SessionListItem[]> {
  const outByRef = new Map<string, SessionListItem>();

  for (const rec of SESSIONS.values()) {
    const item = toListItem(rec);
    if (!matchesSessionFilters(item, filters)) continue;
    outByRef.set(item.session_ref, item);
  }

  if (filters.workspace_dir) {
    const persisted = await listPersistedSessions(filters.workspace_dir);
    for (const item of persisted) {
      if (!matchesSessionFilters(item, filters)) continue;
      if (!outByRef.has(item.session_ref)) outByRef.set(item.session_ref, item);
    }
  }

  const out = [...outByRef.values()];
  out.sort((a, b) => {
    if (a.started_at_ms !== b.started_at_ms) return b.started_at_ms - a.started_at_ms;
    return a.session_ref.localeCompare(b.session_ref);
  });
  return out;
}

// Test helper: simulate runtime restart by clearing in-memory session process handles.
export function resetSessionStateForTests(): void {
  SESSIONS.clear();
}
