import { nowIso } from "../core/time.js";
import { listProjectTasks } from "../work/tasks_list.js";
import { updateTaskPlan } from "../work/tasks_plan_update.js";
import { listAgents, type ListedAgent } from "../org/agents_list.js";
import { buildRunMonitorSnapshot } from "./run_monitor.js";

export type AllocationRecommendation = {
  task_id: string;
  preferred_provider: string;
  preferred_model?: string;
  preferred_agent_id?: string;
  token_budget_hint: number;
  rationale: string;
};

export type AllocationForecastScenario = {
  scenario: "throughput_bias" | "cost_bias";
  projected_span_days: number;
  projected_tokens: number;
  projected_cost_usd: number;
  capacity_pressure: "low" | "moderate" | "high";
  bottleneck_team_id?: string;
  notes: string;
};

export type AllocationForecast = {
  mode: "simulation_v1";
  baseline: {
    projected_span_days: number;
    projected_tokens: number;
    projected_cost_usd: number;
    capacity_pressure: "low" | "moderate" | "high";
    bottleneck_team_id?: string;
  };
  recommended: {
    projected_span_days: number;
    projected_tokens: number;
    projected_cost_usd: number;
    capacity_pressure: "low" | "moderate" | "high";
    bottleneck_team_id?: string;
  };
  scenarios: AllocationForecastScenario[];
};

type Candidate = {
  agent_id: string;
  name: string;
  provider: string;
  model_hint?: string;
  team_id?: string;
  running_count: number;
  speed_index: number;
  cost_per_token: number;
};

type SimTask = {
  task_id: string;
  team_id: string;
  token_budget: number;
  baseline_duration_days: number;
  baseline_candidate: Candidate;
  recommended_candidate: Candidate;
  throughput_candidate: Candidate;
  cost_candidate: Candidate;
};

function round6(v: number): number {
  return Math.round(v * 1_000_000) / 1_000_000;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function suggestionTokenBudget(args: {
  duration_days: number;
  milestone_count: number;
  title: string;
}): number {
  const base = Math.max(1, args.duration_days) * 6000;
  const milestoneBoost = Math.max(0, args.milestone_count) * 3000;
  const codingBoost = /build|implement|refactor|code|fix|ship|rewrite/i.test(args.title) ? 6000 : 0;
  return Math.max(4000, base + milestoneBoost + codingBoost);
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * clamp(q, 0, 1);
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] == null) return sorted[base];
  return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
}

function capacityPressureLabel(ratio: number): "low" | "moderate" | "high" {
  if (ratio <= 0.5) return "low";
  if (ratio <= 1) return "moderate";
  return "high";
}

function estimateDurationDays(args: {
  baseline_duration_days: number;
  speed_index: number;
  team_pressure_ratio: number;
  running_count: number;
}): number {
  const speed = clamp(args.speed_index, 0.55, 1.75);
  const loadPenalty = 1 + args.running_count * 0.18 + Math.max(0, args.team_pressure_ratio - 1) * 0.28;
  return Math.max(0.5, (args.baseline_duration_days / speed) * loadPenalty);
}

function chooseCandidate(args: {
  candidates: Candidate[];
  mode: "balanced" | "throughput" | "cost";
  global_cost_per_token: number;
}): Candidate {
  if (args.candidates.length === 0) {
    throw new Error("chooseCandidate requires at least one candidate");
  }
  if (args.candidates.length === 1) return args.candidates[0];
  const weights =
    args.mode === "throughput"
      ? { speed: 0.76, cost: 0.08, load: 0.16 }
      : args.mode === "cost"
        ? { speed: 0.24, cost: 0.58, load: 0.18 }
        : { speed: 0.52, cost: 0.26, load: 0.22 };

  let best = args.candidates[0];
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const candidate of args.candidates) {
    const speedScore = candidate.speed_index;
    const loadScore = 1 / (1 + candidate.running_count);
    const costBase = args.global_cost_per_token > 0 ? args.global_cost_per_token : 0.00001;
    const candidateCost = candidate.cost_per_token > 0 ? candidate.cost_per_token : costBase;
    const costScore = costBase / candidateCost;
    const score =
      speedScore * weights.speed +
      costScore * weights.cost +
      loadScore * weights.load;
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

function aggregateScenario(args: {
  tasks: SimTask[];
  selection: (task: SimTask) => Candidate;
  team_pressure_by_team: Map<string, number>;
  label: string;
  notes: string;
}): {
  projected_span_days: number;
  projected_tokens: number;
  projected_cost_usd: number;
  bottleneck_team_id?: string;
  capacity_pressure: "low" | "moderate" | "high";
  notes: string;
} {
  const durationByTeam = new Map<string, number>();
  let projectedTokens = 0;
  let projectedCost = 0;
  let maxPressure = 0;
  for (const task of args.tasks) {
    const candidate = args.selection(task);
    const teamPressure = args.team_pressure_by_team.get(task.team_id) ?? 0;
    const duration = estimateDurationDays({
      baseline_duration_days: task.baseline_duration_days,
      speed_index: candidate.speed_index,
      team_pressure_ratio: teamPressure,
      running_count: candidate.running_count
    });
    durationByTeam.set(task.team_id, (durationByTeam.get(task.team_id) ?? 0) + duration);
    projectedTokens += task.token_budget;
    projectedCost += task.token_budget * candidate.cost_per_token;
    maxPressure = Math.max(maxPressure, teamPressure);
  }
  let bottleneckTeamId: string | undefined;
  let span = 0;
  for (const [teamId, duration] of durationByTeam.entries()) {
    if (duration > span) {
      span = duration;
      bottleneckTeamId = teamId;
    }
  }
  const capacityPressure = capacityPressureLabel(maxPressure);
  return {
    projected_span_days: round2(Math.max(0, span)),
    projected_tokens: Math.round(projectedTokens),
    projected_cost_usd: round6(projectedCost),
    bottleneck_team_id: bottleneckTeamId,
    capacity_pressure: capacityPressure,
    notes: `${args.label}: ${args.notes}`
  };
}

export async function recommendTaskAllocations(args: {
  workspace_dir: string;
  project_id: string;
}): Promise<{
  workspace_dir: string;
  project_id: string;
  generated_at: string;
  recommendations: AllocationRecommendation[];
  forecast: AllocationForecast;
}> {
  const [tasks, agents, monitor] = await Promise.all([
    listProjectTasks({
      workspace_dir: args.workspace_dir,
      project_id: args.project_id
    }),
    listAgents({ workspace_dir: args.workspace_dir }),
    buildRunMonitorSnapshot({
      workspace_dir: args.workspace_dir,
      project_id: args.project_id,
      limit: 2000
    })
  ]);

  const workers = agents.filter((a) => a.role === "worker" || a.role === "manager");
  const runningByAgent = new Map<string, number>();
  for (const row of monitor.rows) {
    if ((row.live_status === "running" || row.run_status === "running") && row.agent_id) {
      runningByAgent.set(row.agent_id, (runningByAgent.get(row.agent_id) ?? 0) + 1);
    }
  }

  const speedTotals = new Map<string, { tokens: number; hours: number }>();
  const costTotals = new Map<string, { tokens: number; cost: number }>();
  for (const row of monitor.rows) {
    const provider = row.provider?.trim();
    if (!provider || !row.token_usage) continue;
    const tokens = row.token_usage.total_tokens;
    const cost = row.token_usage.cost_usd ?? 0;
    if (tokens > 0) {
      const c = costTotals.get(provider) ?? { tokens: 0, cost: 0 };
      c.tokens += tokens;
      c.cost += cost;
      costTotals.set(provider, c);
    }
    if (tokens > 0 && row.session_started_at_ms != null && row.session_ended_at_ms != null) {
      const elapsedMs = row.session_ended_at_ms - row.session_started_at_ms;
      if (elapsedMs > 0) {
        const elapsedHours = Math.max(0.05, elapsedMs / 3_600_000);
        const s = speedTotals.get(provider) ?? { tokens: 0, hours: 0 };
        s.tokens += tokens;
        s.hours += elapsedHours;
        speedTotals.set(provider, s);
      }
    }
  }

  const speedValues = [...speedTotals.values()]
    .filter((row) => row.tokens > 0 && row.hours > 0)
    .map((row) => row.tokens / row.hours);
  const medianSpeed = quantile(speedValues, 0.5) || 1;
  const globalCostPerToken = (() => {
    const totals = [...costTotals.values()].reduce(
      (acc, row) => {
        acc.tokens += row.tokens;
        acc.cost += row.cost;
        return acc;
      },
      { tokens: 0, cost: 0 }
    );
    if (totals.tokens <= 0) return 0.00001;
    return totals.cost / totals.tokens;
  })();

  const teamCapacity = new Map<string, number>();
  for (const worker of workers) {
    if (!worker.team_id) continue;
    teamCapacity.set(worker.team_id, (teamCapacity.get(worker.team_id) ?? 0) + 1);
  }
  const teamPressureByTeam = new Map<string, number>();
  for (const [teamId, capacity] of teamCapacity.entries()) {
    const running = workers
      .filter((worker) => worker.team_id === teamId)
      .reduce((sum, worker) => sum + (runningByAgent.get(worker.agent_id) ?? 0), 0);
    teamPressureByTeam.set(teamId, running / Math.max(1, capacity));
  }

  function providerSpeedIndex(provider: string): number {
    const stats = speedTotals.get(provider);
    if (!stats || stats.tokens <= 0 || stats.hours <= 0) return 1;
    const tokensPerHour = stats.tokens / stats.hours;
    return clamp(tokensPerHour / Math.max(medianSpeed, 0.01), 0.55, 1.75);
  }

  function providerCostPerToken(provider: string): number {
    const stats = costTotals.get(provider);
    if (!stats || stats.tokens <= 0) return globalCostPerToken;
    return stats.cost / stats.tokens;
  }

  function makeCandidate(agent: ListedAgent): Candidate {
    return {
      agent_id: agent.agent_id,
      name: agent.name,
      provider: agent.provider,
      model_hint: agent.model_hint,
      team_id: agent.team_id,
      running_count: runningByAgent.get(agent.agent_id) ?? 0,
      speed_index: providerSpeedIndex(agent.provider),
      cost_per_token: providerCostPerToken(agent.provider)
    };
  }

  const recommendations: AllocationRecommendation[] = [];
  const simTasks: SimTask[] = [];
  for (const task of tasks) {
    if (task.frontmatter.status === "done" || task.frontmatter.status === "canceled") continue;
    const duration = task.frontmatter.schedule?.duration_days ?? 1;
    const tokenBudget = suggestionTokenBudget({
      duration_days: duration,
      milestone_count: task.frontmatter.milestones.length,
      title: task.frontmatter.title
    });

    const teamCandidates = task.frontmatter.team_id
      ? workers.filter((agent) => agent.team_id === task.frontmatter.team_id)
      : workers;
    const poolAgents = (teamCandidates.length ? teamCandidates : workers).map(makeCandidate);
    const baselineAssignee =
      task.frontmatter.assignee_agent_id != null
        ? poolAgents.find((agent) => agent.agent_id === task.frontmatter.assignee_agent_id)
        : undefined;
    const baselineByLoad = [...poolAgents].sort((a, b) => {
      if (a.running_count !== b.running_count) return a.running_count - b.running_count;
      return a.name.localeCompare(b.name);
    })[0];
    const fallback = makeCandidate({
      agent_id: "auto",
      name: "Auto",
      role: "worker",
      provider: "codex",
      created_at: nowIso()
    });
    const baseline = baselineAssignee ?? baselineByLoad ?? fallback;
    const recommended = poolAgents.length
      ? chooseCandidate({
          candidates: poolAgents,
          mode: "balanced",
          global_cost_per_token: globalCostPerToken
        })
      : baseline;
    const throughputChoice = poolAgents.length
      ? chooseCandidate({
          candidates: poolAgents,
          mode: "throughput",
          global_cost_per_token: globalCostPerToken
        })
      : recommended;
    const costChoice = poolAgents.length
      ? chooseCandidate({
          candidates: poolAgents,
          mode: "cost",
          global_cost_per_token: globalCostPerToken
        })
      : recommended;

    const taskTeamId = task.frontmatter.team_id ?? "unassigned";
    const teamPressure = teamPressureByTeam.get(taskTeamId) ?? 0;
    const baselineDuration = estimateDurationDays({
      baseline_duration_days: duration,
      speed_index: baseline.speed_index,
      team_pressure_ratio: teamPressure,
      running_count: baseline.running_count
    });
    const recommendedDuration = estimateDurationDays({
      baseline_duration_days: duration,
      speed_index: recommended.speed_index,
      team_pressure_ratio: teamPressure,
      running_count: recommended.running_count
    });
    const baselineCost = tokenBudget * baseline.cost_per_token;
    const recommendedCost = tokenBudget * recommended.cost_per_token;
    const durationDelta = round2(recommendedDuration - baselineDuration);
    const costDelta = round6(recommendedCost - baselineCost);

    recommendations.push({
      task_id: task.task_id,
      preferred_provider: recommended.provider,
      preferred_model: recommended.model_hint,
      preferred_agent_id: recommended.agent_id === "auto" ? undefined : recommended.agent_id,
      token_budget_hint: tokenBudget,
      rationale:
        `Selected ${recommended.name} for balanced speed/cost/load scoring. ` +
        `Estimated duration delta ${durationDelta >= 0 ? "+" : ""}${durationDelta}d, ` +
        `cost delta ${costDelta >= 0 ? "+" : ""}${costDelta.toFixed(6)} USD.`
    });

    simTasks.push({
      task_id: task.task_id,
      team_id: taskTeamId,
      token_budget: tokenBudget,
      baseline_duration_days: duration,
      baseline_candidate: baseline,
      recommended_candidate: recommended,
      throughput_candidate: throughputChoice,
      cost_candidate: costChoice
    });
  }

  const baselineScenario = aggregateScenario({
    tasks: simTasks,
    selection: (task) => task.baseline_candidate,
    team_pressure_by_team: teamPressureByTeam,
    label: "Baseline",
    notes: "Current assignee/load defaults."
  });
  const recommendedScenario = aggregateScenario({
    tasks: simTasks,
    selection: (task) => task.recommended_candidate,
    team_pressure_by_team: teamPressureByTeam,
    label: "Recommended",
    notes: "Balanced scoring across speed, cost, and load."
  });
  const throughputScenario = aggregateScenario({
    tasks: simTasks,
    selection: (task) => task.throughput_candidate,
    team_pressure_by_team: teamPressureByTeam,
    label: "Throughput Bias",
    notes: "Prioritizes faster providers/agents."
  });
  const costScenario = aggregateScenario({
    tasks: simTasks,
    selection: (task) => task.cost_candidate,
    team_pressure_by_team: teamPressureByTeam,
    label: "Cost Bias",
    notes: "Prioritizes lower expected spend."
  });

  return {
    workspace_dir: args.workspace_dir,
    project_id: args.project_id,
    generated_at: nowIso(),
    recommendations,
    forecast: {
      mode: "simulation_v1",
      baseline: {
        projected_span_days: baselineScenario.projected_span_days,
        projected_tokens: baselineScenario.projected_tokens,
        projected_cost_usd: baselineScenario.projected_cost_usd,
        capacity_pressure: baselineScenario.capacity_pressure,
        bottleneck_team_id: baselineScenario.bottleneck_team_id
      },
      recommended: {
        projected_span_days: recommendedScenario.projected_span_days,
        projected_tokens: recommendedScenario.projected_tokens,
        projected_cost_usd: recommendedScenario.projected_cost_usd,
        capacity_pressure: recommendedScenario.capacity_pressure,
        bottleneck_team_id: recommendedScenario.bottleneck_team_id
      },
      scenarios: [
        {
          scenario: "throughput_bias",
          projected_span_days: throughputScenario.projected_span_days,
          projected_tokens: throughputScenario.projected_tokens,
          projected_cost_usd: throughputScenario.projected_cost_usd,
          capacity_pressure: throughputScenario.capacity_pressure,
          bottleneck_team_id: throughputScenario.bottleneck_team_id,
          notes: throughputScenario.notes
        },
        {
          scenario: "cost_bias",
          projected_span_days: costScenario.projected_span_days,
          projected_tokens: costScenario.projected_tokens,
          projected_cost_usd: costScenario.projected_cost_usd,
          capacity_pressure: costScenario.capacity_pressure,
          bottleneck_team_id: costScenario.bottleneck_team_id,
          notes: costScenario.notes
        }
      ]
    }
  };
}

export async function applyTaskAllocations(args: {
  workspace_dir: string;
  project_id: string;
  applied_by: string;
  items: Array<{
    task_id: string;
    preferred_provider?: string;
    preferred_model?: string;
    preferred_agent_id?: string;
    token_budget_hint?: number;
  }>;
}): Promise<{
  workspace_dir: string;
  project_id: string;
  applied_at: string;
  updated_task_ids: string[];
}> {
  const appliedAt = nowIso();
  const updatedTaskIds: string[] = [];

  for (const item of args.items) {
    if (!item.task_id) continue;
    await updateTaskPlan({
      workspace_dir: args.workspace_dir,
      project_id: args.project_id,
      task_id: item.task_id,
      execution_plan: {
        preferred_provider: item.preferred_provider,
        preferred_model: item.preferred_model,
        preferred_agent_id: item.preferred_agent_id,
        token_budget_hint: item.token_budget_hint,
        applied_by: args.applied_by,
        applied_at: appliedAt
      }
    });
    updatedTaskIds.push(item.task_id);
  }

  return {
    workspace_dir: args.workspace_dir,
    project_id: args.project_id,
    applied_at: appliedAt,
    updated_task_ids: [...new Set(updatedTaskIds)]
  };
}
