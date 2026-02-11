import path from "node:path";
import { nowIso } from "../core/time.js";
import { readYamlFile } from "../store/yaml.js";
import { RunYaml } from "../schemas/run.js";
import {
  indexDbPath,
  listIndexedRunParseErrorCounts,
  listIndexedRuns,
  rebuildSqliteIndex,
  syncSqliteIndex
} from "../index/sqlite.js";
import { pathExists } from "../store/fs.js";

export type UsageAnalyticsSnapshotArgs = {
  workspace_dir: string;
  project_id?: string;
  limit?: number;
  refresh_index?: boolean;
  sync_index?: boolean;
};

export type UsageAnalyticsRecentRun = {
  project_id: string;
  run_id: string;
  provider: string;
  status: string;
  created_at: string;
  usage_source: "provider_reported" | "estimated_chars" | null;
  usage_confidence: "high" | "low" | null;
  total_tokens: number;
  cost_usd: number | null;
  parse_error_count: number;
};

export type UsageAnalyticsByProvider = {
  provider: string;
  run_count: number;
  total_tokens: number;
  total_cost_usd: number;
  average_tokens_per_run: number;
  average_cost_usd_per_run: number;
  parse_error_runs: number;
};

export type UsageAnalyticsSnapshot = {
  workspace_dir: string;
  generated_at: string;
  index_rebuilt: boolean;
  index_synced: boolean;
  totals: {
    run_count: number;
    total_tokens: number;
    total_cost_usd: number;
    priced_run_count: number;
    unpriced_run_count: number;
    provider_reported_count: number;
    estimated_count: number;
    parse_error_run_count: number;
  };
  by_provider: UsageAnalyticsByProvider[];
  recent_runs: UsageAnalyticsRecentRun[];
};

function runUsagePath(workspaceDir: string, projectId: string, runId: string): string {
  return path.join(workspaceDir, "work/projects", projectId, "runs", runId, "run.yaml");
}

function asNonNegativeNumber(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  return v;
}

function round6(v: number): number {
  return Math.round(v * 1_000_000) / 1_000_000;
}

export async function buildUsageAnalyticsSnapshot(
  args: UsageAnalyticsSnapshotArgs
): Promise<UsageAnalyticsSnapshot> {
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

  const [indexedRuns, parseErrors] = await Promise.all([
    listIndexedRuns({
      workspace_dir: args.workspace_dir,
      project_id: args.project_id,
      limit
    }),
    listIndexedRunParseErrorCounts({
      workspace_dir: args.workspace_dir,
      project_id: args.project_id,
      limit
    })
  ]);
  const parseByRun = new Map<string, number>();
  for (const p of parseErrors) {
    parseByRun.set(`${p.project_id}::${p.run_id}`, p.parse_error_count);
  }

  const recentRuns: UsageAnalyticsRecentRun[] = [];
  for (const run of indexedRuns) {
    let usageSource: UsageAnalyticsRecentRun["usage_source"] = null;
    let usageConfidence: UsageAnalyticsRecentRun["usage_confidence"] = null;
    let tokens = 0;
    let costUsd: number | null = null;
    try {
      const doc = RunYaml.parse(await readYamlFile(runUsagePath(args.workspace_dir, run.project_id, run.run_id)));
      usageSource = doc.usage?.source ?? null;
      usageConfidence = doc.usage?.confidence ?? null;
      tokens = doc.usage?.total_tokens ?? 0;
      costUsd = asNonNegativeNumber(doc.usage?.cost_usd);
    } catch {
      // keep defaults
    }
    recentRuns.push({
      project_id: run.project_id,
      run_id: run.run_id,
      provider: run.provider,
      status: run.status,
      created_at: run.created_at,
      usage_source: usageSource,
      usage_confidence: usageConfidence,
      total_tokens: tokens,
      cost_usd: costUsd,
      parse_error_count: parseByRun.get(`${run.project_id}::${run.run_id}`) ?? 0
    });
  }

  const byProviderMap = new Map<string, UsageAnalyticsByProvider>();
  for (const run of recentRuns) {
    const entry =
      byProviderMap.get(run.provider) ??
      ({
        provider: run.provider,
        run_count: 0,
        total_tokens: 0,
        total_cost_usd: 0,
        average_tokens_per_run: 0,
        average_cost_usd_per_run: 0,
        parse_error_runs: 0
      } satisfies UsageAnalyticsByProvider);
    entry.run_count += 1;
    entry.total_tokens += run.total_tokens;
    entry.total_cost_usd += run.cost_usd ?? 0;
    if (run.parse_error_count > 0) entry.parse_error_runs += 1;
    byProviderMap.set(run.provider, entry);
  }

  const byProvider = [...byProviderMap.values()]
    .map((e) => ({
      ...e,
      total_cost_usd: round6(e.total_cost_usd),
      average_tokens_per_run: e.run_count > 0 ? Math.round(e.total_tokens / e.run_count) : 0,
      average_cost_usd_per_run: e.run_count > 0 ? round6(e.total_cost_usd / e.run_count) : 0
    }))
    .sort((a, b) => {
      if (a.total_tokens !== b.total_tokens) return b.total_tokens - a.total_tokens;
      return a.provider.localeCompare(b.provider);
    });

  const pricedRunCount = recentRuns.filter((r) => r.cost_usd !== null).length;
  const totalCost = recentRuns.reduce((sum, r) => sum + (r.cost_usd ?? 0), 0);
  return {
    workspace_dir: args.workspace_dir,
    generated_at: nowIso(),
    index_rebuilt: indexRebuilt,
    index_synced: indexSynced,
    totals: {
      run_count: recentRuns.length,
      total_tokens: recentRuns.reduce((sum, r) => sum + r.total_tokens, 0),
      total_cost_usd: round6(totalCost),
      priced_run_count: pricedRunCount,
      unpriced_run_count: recentRuns.length - pricedRunCount,
      provider_reported_count: recentRuns.filter((r) => r.usage_source === "provider_reported").length,
      estimated_count: recentRuns.filter((r) => r.usage_source === "estimated_chars").length,
      parse_error_run_count: recentRuns.filter((r) => r.parse_error_count > 0).length
    },
    by_provider: byProvider,
    recent_runs: recentRuns
  };
}
