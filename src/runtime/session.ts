import fs from "node:fs/promises";
import path from "node:path";
import { readYamlFile } from "../store/yaml.js";
import { RunYaml } from "../schemas/run.js";
import { executeCommandRun, type ExecuteCommandArgs, type ExecuteCommandResult } from "./execute_command.js";

export type SessionStatus = "running" | "ended" | "failed" | "stopped";

export type LaunchSessionArgs = ExecuteCommandArgs & {
  session_ref?: string;
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
};

type SessionRecord = {
  session_ref: string;
  project_id: string;
  run_id: string;
  status: SessionStatus;
  abort_controller: AbortController;
  promise: Promise<void>;
  result: ExecuteCommandResult | null;
  error?: string;
  workspace_dir: string;
  started_at_ms: number;
  ended_at_ms?: number;
};

const SESSIONS = new Map<string, SessionRecord>();

function runYamlPath(workspaceDir: string, projectId: string, runId: string): string {
  return path.join(workspaceDir, "work/projects", projectId, "runs", runId, "run.yaml");
}

async function readRunStatus(
  workspaceDir: string,
  projectId: string,
  runId: string
): Promise<SessionStatus> {
  const run = RunYaml.parse(await readYamlFile(runYamlPath(workspaceDir, projectId, runId)));
  return run.status;
}

function ensureSession(session_ref: string): SessionRecord {
  const rec = SESSIONS.get(session_ref);
  if (!rec) throw new Error(`Unknown session_ref: ${session_ref}`);
  return rec;
}

export async function launchSession(args: LaunchSessionArgs): Promise<{ session_ref: string }> {
  const sessionRef = args.session_ref ?? `local_${args.run_id}`;
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
    started_at_ms: Date.now()
  };
  rec.promise = (async () => {
    try {
      rec.result = await executeCommandRun({
        ...args,
        abort_signal: abortController.signal
      });
      rec.status = await readRunStatus(args.workspace_dir, args.project_id, args.run_id);
    } catch (e) {
      rec.status = "failed";
      rec.error = e instanceof Error ? e.message : String(e);
    } finally {
      rec.ended_at_ms = Date.now();
    }
  })();
  SESSIONS.set(sessionRef, rec);

  return { session_ref: sessionRef };
}

export function pollSession(session_ref: string): SessionPollResult {
  const rec = ensureSession(session_ref);
  return {
    session_ref: rec.session_ref,
    project_id: rec.project_id,
    run_id: rec.run_id,
    status: rec.status,
    exit_code: rec.result?.exit_code ?? null,
    signal: rec.result?.signal ?? null,
    error: rec.error
  };
}

export async function collectSession(session_ref: string): Promise<SessionCollectResult> {
  const rec = ensureSession(session_ref);
  await rec.promise;

  const runDir = path.join(rec.workspace_dir, "work/projects", rec.project_id, "runs", rec.run_id);
  const outputsDir = path.join(runDir, "outputs");
  let outputRelpaths: string[] = [];
  try {
    const entries = await fs.readdir(outputsDir, { withFileTypes: true });
    outputRelpaths = entries
      .filter((e) => e.isFile())
      .map((e) => path.join("runs", rec.run_id, "outputs", e.name))
      .sort();
  } catch {
    // no outputs
  }

  const p = pollSession(session_ref);
  return {
    ...p,
    events_relpath: path.join("runs", rec.run_id, "events.jsonl"),
    output_relpaths: outputRelpaths
  };
}

export function stopSession(session_ref: string): SessionPollResult {
  const rec = ensureSession(session_ref);
  if (rec.status === "running") {
    rec.abort_controller.abort();
  }
  return pollSession(session_ref);
}

export function listSessions(filters: SessionListArgs = {}): SessionListItem[] {
  const out: SessionListItem[] = [];
  for (const rec of SESSIONS.values()) {
    if (filters.workspace_dir && rec.workspace_dir !== filters.workspace_dir) continue;
    if (filters.project_id && rec.project_id !== filters.project_id) continue;
    if (filters.run_id && rec.run_id !== filters.run_id) continue;
    if (filters.status && rec.status !== filters.status) continue;
    out.push({
      ...pollSession(rec.session_ref),
      workspace_dir: rec.workspace_dir,
      started_at_ms: rec.started_at_ms,
      ended_at_ms: rec.ended_at_ms
    });
  }
  out.sort((a, b) => {
    if (a.started_at_ms !== b.started_at_ms) return b.started_at_ms - a.started_at_ms;
    return a.session_ref.localeCompare(b.session_ref);
  });
  return out;
}
