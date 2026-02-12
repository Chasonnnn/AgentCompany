import { nowIso } from "../core/time.js";
import { buildUsageAnalyticsSnapshot } from "./usage_analytics.js";
import { buildRunMonitorSnapshot } from "./run_monitor.js";
import { listIndexedAgentCounters, listIndexedRuns, readIndexStats, syncSqliteIndex } from "../index/sqlite.js";

export type ResourcesSnapshot = {
  workspace_dir: string;
  generated_at: string;
  project_id?: string;
  totals: {
    agents: number;
    workers: number;
    active_workers: number;
    runs_indexed: number;
    total_tokens: number;
    total_cost_usd: number;
    context_cycles_total: number;
    context_cycles_known_runs: number;
    context_cycles_unknown_runs: number;
  };
  providers: Array<{
    provider: string;
    run_count: number;
    total_tokens: number;
    total_cost_usd: number;
  }>;
  models: Array<{
    model: string;
    agent_count: number;
  }>;
};

export async function buildResourcesSnapshot(args: {
  workspace_dir: string;
  project_id?: string;
}): Promise<ResourcesSnapshot> {
  await syncSqliteIndex(args.workspace_dir);

  const [agentCounters, usage, monitor, stats, projectRuns] = await Promise.all([
    listIndexedAgentCounters({ workspace_dir: args.workspace_dir, limit: 10000 }),
    buildUsageAnalyticsSnapshot({
      workspace_dir: args.workspace_dir,
      project_id: args.project_id,
      limit: 5000,
      sync_index: false
    }),
    buildRunMonitorSnapshot({
      workspace_dir: args.workspace_dir,
      project_id: args.project_id,
      limit: 5000,
      sync_index: false
    }),
    readIndexStats(args.workspace_dir),
    listIndexedRuns({ workspace_dir: args.workspace_dir, project_id: args.project_id, limit: 10000 })
  ]);

  const activeWorkerIds = new Set(
    monitor.rows
      .filter((r) => (r.live_status === "running" || r.run_status === "running") && r.agent_id)
      .map((r) => String(r.agent_id))
  );

  const workerIds = new Set(
    agentCounters.filter((a) => a.role === "worker").map((a) => a.agent_id)
  );

  const modelCounts = new Map<string, number>();
  for (const a of agentCounters) {
    const model = (a.model_hint ?? `${a.provider} (default)`).trim();
    modelCounts.set(model, (modelCounts.get(model) ?? 0) + 1);
  }

  const projectCycles = {
    total: 0,
    known_runs: 0,
    unknown_runs: 0
  };
  for (const run of projectRuns) {
    if (run.context_cycles_source === "provider_signal") {
      projectCycles.known_runs += 1;
      projectCycles.total += run.context_cycles_count ?? 0;
    } else if (run.context_cycles_source) {
      projectCycles.unknown_runs += 1;
    }
  }

  const workspaceCycles = {
    total: agentCounters.reduce((sum, row) => sum + row.context_cycles_count, 0),
    known_runs: agentCounters.reduce((sum, row) => sum + row.context_cycles_known_runs, 0),
    unknown_runs: agentCounters.reduce((sum, row) => sum + row.context_cycles_unknown_runs, 0)
  };

  const totalTokens =
    args.project_id == null
      ? agentCounters.reduce((sum, row) => sum + row.total_tokens, 0)
      : usage.totals.total_tokens;
  const totalCost =
    args.project_id == null
      ? agentCounters.reduce((sum, row) => sum + row.total_cost_usd, 0)
      : usage.totals.total_cost_usd;

  return {
    workspace_dir: args.workspace_dir,
    generated_at: nowIso(),
    project_id: args.project_id,
    totals: {
      agents: agentCounters.length,
      workers: workerIds.size,
      active_workers: [...activeWorkerIds].filter((id) => workerIds.has(id)).length,
      runs_indexed: args.project_id == null ? stats.runs : projectRuns.length,
      total_tokens: totalTokens,
      total_cost_usd: Math.round(totalCost * 1_000_000) / 1_000_000,
      context_cycles_total: args.project_id == null ? workspaceCycles.total : projectCycles.total,
      context_cycles_known_runs: args.project_id == null ? workspaceCycles.known_runs : projectCycles.known_runs,
      context_cycles_unknown_runs:
        args.project_id == null ? workspaceCycles.unknown_runs : projectCycles.unknown_runs
    },
    providers: usage.by_provider.map((p) => ({
      provider: p.provider,
      run_count: p.run_count,
      total_tokens: p.total_tokens,
      total_cost_usd: p.total_cost_usd
    })),
    models: [...modelCounts.entries()]
      .map(([model, agent_count]) => ({ model, agent_count }))
      .sort((a, b) => b.agent_count - a.agent_count || a.model.localeCompare(b.model))
  };
}
