import path from "node:path";
import { nowIso } from "../core/time.js";
import { listSessions } from "./session.js";
import {
  indexDbPath,
  listIndexedRuns,
  listIndexedRunLastEvents,
  listIndexedRunEventTypeCounts,
  listIndexedRunParseErrorCounts,
  rebuildSqliteIndex,
  syncSqliteIndex
} from "../index/sqlite.js";
import { pathExists } from "../store/fs.js";
import { readYamlFile } from "../store/yaml.js";
import { RunYaml } from "../schemas/run.js";

export type RunMonitorSnapshotArgs = {
  workspace_dir: string;
  project_id?: string;
  limit?: number;
  refresh_index?: boolean;
  sync_index?: boolean;
};

export type RunMonitorRow = {
  project_id: string;
  run_id: string;
  created_at?: string;
  run_status: string;
  provider?: string;
  agent_id?: string;
  context_pack_id?: string;
  session_ref?: string;
  live_status?: string;
  live_exit_code?: number | null;
  live_signal?: string | null;
  live_error?: string;
  session_started_at_ms?: number;
  session_ended_at_ms?: number;
  last_event?: {
    seq: number;
    type: string;
    ts_wallclock: string | null;
    actor: string | null;
    visibility: string | null;
  };
  parse_error_count: number;
  policy_decision_count: number;
  policy_denied_count: number;
  budget_decision_count: number;
  budget_alert_count: number;
  budget_exceeded_count: number;
  token_usage?: {
    source: "provider_reported" | "estimated_chars";
    confidence: "high" | "low";
    total_tokens: number;
    input_tokens?: number;
    output_tokens?: number;
    cost_usd?: number;
  };
};

export type RunMonitorSnapshot = {
  workspace_dir: string;
  generated_at: string;
  index_rebuilt: boolean;
  index_synced: boolean;
  rows: RunMonitorRow[];
};

function runKey(projectId: string, runId: string): string {
  return `${projectId}::${runId}`;
}

async function readRunUsage(
  workspaceDir: string,
  projectId: string,
  runId: string
): Promise<RunMonitorRow["token_usage"]> {
  const p = path.join(workspaceDir, "work", "projects", projectId, "runs", runId, "run.yaml");
  try {
    const run = RunYaml.parse(await readYamlFile(p));
    if (!run.usage) return undefined;
    return {
      source: run.usage.source,
      confidence: run.usage.confidence,
      total_tokens: run.usage.total_tokens,
      input_tokens: run.usage.input_tokens,
      output_tokens: run.usage.output_tokens,
      cost_usd: run.usage.cost_usd
    };
  } catch {
    return undefined;
  }
}

export async function buildRunMonitorSnapshot(args: RunMonitorSnapshotArgs): Promise<RunMonitorSnapshot> {
  const limit = Math.max(1, Math.min(args.limit ?? 200, 5000));
  let indexRebuilt = false;
  let indexSynced = false;
  const dbPath = indexDbPath(args.workspace_dir);
  const dbExists = await pathExists(dbPath);
  if (args.refresh_index || !dbExists) {
    await rebuildSqliteIndex(args.workspace_dir);
    indexRebuilt = true;
  } else if (args.sync_index !== false) {
    await syncSqliteIndex(args.workspace_dir);
    indexSynced = true;
  }

  const [runs, lastEvents, parseErrors, eventTypeCounts] = await Promise.all([
    listIndexedRuns({
      workspace_dir: args.workspace_dir,
      project_id: args.project_id,
      limit
    }),
    listIndexedRunLastEvents({
      workspace_dir: args.workspace_dir,
      project_id: args.project_id,
      limit
    }),
    listIndexedRunParseErrorCounts({
      workspace_dir: args.workspace_dir,
      project_id: args.project_id,
      limit
    }),
    listIndexedRunEventTypeCounts({
      workspace_dir: args.workspace_dir,
      project_id: args.project_id,
      types: [
        "policy.decision",
        "policy.denied",
        "budget.decision",
        "budget.alert",
        "budget.exceeded"
      ],
      limit: limit * 8
    })
  ]);

  const lastByRun = new Map<string, (typeof lastEvents)[number]>();
  for (const ev of lastEvents) {
    lastByRun.set(runKey(ev.project_id, ev.run_id), ev);
  }
  const parseCountByRun = new Map<string, number>();
  for (const e of parseErrors) {
    parseCountByRun.set(runKey(e.project_id, e.run_id), e.parse_error_count);
  }
  const eventCountsByRun = new Map<
    string,
    {
      policy_decision_count: number;
      policy_denied_count: number;
      budget_decision_count: number;
      budget_alert_count: number;
      budget_exceeded_count: number;
    }
  >();
  for (const row of eventTypeCounts) {
    const key = runKey(row.project_id, row.run_id);
    const curr = eventCountsByRun.get(key) ?? {
      policy_decision_count: 0,
      policy_denied_count: 0,
      budget_decision_count: 0,
      budget_alert_count: 0,
      budget_exceeded_count: 0
    };
    if (row.type === "policy.decision") curr.policy_decision_count = row.event_count;
    else if (row.type === "policy.denied") curr.policy_denied_count = row.event_count;
    else if (row.type === "budget.decision") curr.budget_decision_count = row.event_count;
    else if (row.type === "budget.alert") curr.budget_alert_count = row.event_count;
    else if (row.type === "budget.exceeded") curr.budget_exceeded_count = row.event_count;
    eventCountsByRun.set(key, curr);
  }

  const sessions = await listSessions({
    workspace_dir: args.workspace_dir,
    project_id: args.project_id
  });
  const sessionByRun = new Map<string, (typeof sessions)[number]>();
  for (const s of sessions) {
    sessionByRun.set(runKey(s.project_id, s.run_id), s);
  }

  const rows: RunMonitorRow[] = [];
  const seen = new Set<string>();

  for (const run of runs) {
    const key = runKey(run.project_id, run.run_id);
    seen.add(key);
    const session = sessionByRun.get(key);
    const last = lastByRun.get(key);
    const counts = eventCountsByRun.get(key);
    rows.push({
      project_id: run.project_id,
      run_id: run.run_id,
      created_at: run.created_at,
      run_status: run.status,
      provider: run.provider,
      agent_id: run.agent_id,
      context_pack_id: run.context_pack_id,
      session_ref: session?.session_ref,
      live_status: session?.status,
      live_exit_code: session?.exit_code,
      live_signal: session?.signal,
      live_error: session?.error,
      session_started_at_ms: session?.started_at_ms,
      session_ended_at_ms: session?.ended_at_ms,
      last_event: last
        ? {
            seq: last.seq,
            type: last.type,
            ts_wallclock: last.ts_wallclock,
            actor: last.actor,
            visibility: last.visibility
          }
        : undefined,
      parse_error_count: parseCountByRun.get(key) ?? 0,
      policy_decision_count: counts?.policy_decision_count ?? 0,
      policy_denied_count: counts?.policy_denied_count ?? 0,
      budget_decision_count: counts?.budget_decision_count ?? 0,
      budget_alert_count: counts?.budget_alert_count ?? 0,
      budget_exceeded_count: counts?.budget_exceeded_count ?? 0
    });
  }

  // Include sessions that haven't been indexed yet.
  for (const session of sessions) {
    const key = runKey(session.project_id, session.run_id);
    if (seen.has(key)) continue;
    const counts = eventCountsByRun.get(key);
    rows.push({
      project_id: session.project_id,
      run_id: session.run_id,
      run_status: session.status,
      session_ref: session.session_ref,
      live_status: session.status,
      live_exit_code: session.exit_code,
      live_signal: session.signal,
      live_error: session.error,
      session_started_at_ms: session.started_at_ms,
      session_ended_at_ms: session.ended_at_ms,
      parse_error_count: parseCountByRun.get(key) ?? 0,
      policy_decision_count: counts?.policy_decision_count ?? 0,
      policy_denied_count: counts?.policy_denied_count ?? 0,
      budget_decision_count: counts?.budget_decision_count ?? 0,
      budget_alert_count: counts?.budget_alert_count ?? 0,
      budget_exceeded_count: counts?.budget_exceeded_count ?? 0
    });
  }

  rows.sort((a, b) => {
    const aLive = a.live_status === "running" ? 1 : 0;
    const bLive = b.live_status === "running" ? 1 : 0;
    if (aLive !== bLive) return bLive - aLive;
    const aTs = a.created_at ?? "";
    const bTs = b.created_at ?? "";
    if (aTs !== bTs) return aTs < bTs ? 1 : -1;
    return a.run_id.localeCompare(b.run_id);
  });

  for (const row of rows) {
    row.token_usage = await readRunUsage(args.workspace_dir, row.project_id, row.run_id);
  }

  return {
    workspace_dir: args.workspace_dir,
    generated_at: nowIso(),
    index_rebuilt: indexRebuilt,
    index_synced: indexSynced,
    rows: rows.slice(0, limit)
  };
}
