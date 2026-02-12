import path from "node:path";
import { nowIso } from "../core/time.js";
import { AgentYaml } from "../schemas/agent.js";
import { readYamlFile } from "../store/yaml.js";
import {
  indexDbPath,
  listIndexedAgentCounters,
  listIndexedRuns,
  rebuildSqliteIndex
} from "../index/sqlite.js";
import { pathExists } from "../store/fs.js";

function daysBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return 0;
  return Math.floor((to - from) / 86_400_000);
}

export type AgentProfileSnapshot = {
  workspace_dir: string;
  generated_at: string;
  agent: {
    agent_id: string;
    name: string;
    display_title?: string;
    avatar?: string;
    role: "ceo" | "director" | "manager" | "worker";
    provider: string;
    model_hint?: string;
    team_id?: string;
    created_at: string;
    tenure_days: number;
  };
  metrics: {
    total_runs: number;
    running_runs: number;
    ended_runs: number;
    failed_runs: number;
    stopped_runs: number;
    total_tokens: number;
    total_cost_usd: number;
    context_cycles_count: number | null;
    context_cycles_source: "provider_signal" | "unknown";
  };
};

export async function buildAgentProfileSnapshot(args: {
  workspace_dir: string;
  agent_id: string;
  project_id?: string;
}): Promise<AgentProfileSnapshot> {
  const agentPath = path.join(args.workspace_dir, "org", "agents", args.agent_id, "agent.yaml");
  const agent = AgentYaml.parse(await readYamlFile(agentPath));
  const now = nowIso();

  const dbExists = await pathExists(indexDbPath(args.workspace_dir));
  if (!dbExists) {
    await rebuildSqliteIndex(args.workspace_dir);
  }

  let metrics: AgentProfileSnapshot["metrics"];

  if (args.project_id) {
    const runs = await listIndexedRuns({
      workspace_dir: args.workspace_dir,
      project_id: args.project_id,
      limit: 10000
    });
    const filtered = runs.filter((r) => r.agent_id === args.agent_id);
    const knownRuns = filtered.filter((r) => r.context_cycles_source === "provider_signal");
    const unknownRuns = filtered.filter(
      (r) => r.context_cycles_source != null && r.context_cycles_source !== "provider_signal"
    );
    metrics = {
      total_runs: filtered.length,
      running_runs: filtered.filter((r) => r.status === "running").length,
      ended_runs: filtered.filter((r) => r.status === "ended").length,
      failed_runs: filtered.filter((r) => r.status === "failed").length,
      stopped_runs: filtered.filter((r) => r.status === "stopped").length,
      total_tokens: filtered.reduce((sum, r) => sum + (r.usage_total_tokens ?? 0), 0),
      total_cost_usd:
        Math.round(filtered.reduce((sum, r) => sum + (r.usage_cost_usd ?? 0), 0) * 1_000_000) / 1_000_000,
      context_cycles_count:
        knownRuns.length > 0 ? knownRuns.reduce((sum, r) => sum + (r.context_cycles_count ?? 0), 0) : null,
      context_cycles_source: knownRuns.length > 0 || unknownRuns.length === 0 ? "provider_signal" : "unknown"
    };
    if (knownRuns.length === 0) {
      metrics.context_cycles_source = "unknown";
    }
  } else {
    const counters = await listIndexedAgentCounters({
      workspace_dir: args.workspace_dir,
      limit: 10000
    });
    const row = counters.find((c) => c.agent_id === args.agent_id);
    const known = row?.context_cycles_known_runs ?? 0;
    metrics = {
      total_runs: row?.total_runs ?? 0,
      running_runs: row?.running_runs ?? 0,
      ended_runs: row?.ended_runs ?? 0,
      failed_runs: row?.failed_runs ?? 0,
      stopped_runs: row?.stopped_runs ?? 0,
      total_tokens: row?.total_tokens ?? 0,
      total_cost_usd: Math.round((row?.total_cost_usd ?? 0) * 1_000_000) / 1_000_000,
      context_cycles_count: known > 0 ? row?.context_cycles_count ?? 0 : null,
      context_cycles_source: known > 0 ? "provider_signal" : "unknown"
    };
  }

  return {
    workspace_dir: args.workspace_dir,
    generated_at: now,
    agent: {
      agent_id: agent.id,
      name: agent.name,
      display_title: agent.display_title,
      avatar: agent.avatar,
      role: agent.role,
      provider: agent.provider,
      model_hint: agent.model_hint,
      team_id: agent.team_id,
      created_at: agent.created_at,
      tenure_days: daysBetween(agent.created_at, now)
    },
    metrics
  };
}
