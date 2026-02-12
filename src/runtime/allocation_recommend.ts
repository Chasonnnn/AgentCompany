import { nowIso } from "../core/time.js";
import { listProjectTasks } from "../work/tasks_list.js";
import { updateTaskPlan } from "../work/tasks_plan_update.js";
import { listAgents } from "../org/agents_list.js";
import { buildRunMonitorSnapshot } from "./run_monitor.js";

export type AllocationRecommendation = {
  task_id: string;
  preferred_provider: string;
  preferred_model?: string;
  preferred_agent_id?: string;
  token_budget_hint: number;
  rationale: string;
};

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

export async function recommendTaskAllocations(args: {
  workspace_dir: string;
  project_id: string;
}): Promise<{
  workspace_dir: string;
  project_id: string;
  generated_at: string;
  recommendations: AllocationRecommendation[];
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
      limit: 500
    })
  ]);

  const workers = agents.filter((a) => a.role === "worker" || a.role === "manager");
  const runningByAgent = new Map<string, number>();
  for (const row of monitor.rows) {
    if ((row.live_status === "running" || row.run_status === "running") && row.agent_id) {
      runningByAgent.set(row.agent_id, (runningByAgent.get(row.agent_id) ?? 0) + 1);
    }
  }

  const recommendations: AllocationRecommendation[] = [];
  for (const task of tasks) {
    if (task.frontmatter.status === "done" || task.frontmatter.status === "canceled") continue;

    const preferredByAssignee =
      task.frontmatter.assignee_agent_id != null
        ? workers.find((a) => a.agent_id === task.frontmatter.assignee_agent_id)
        : undefined;

    const teamCandidates = task.frontmatter.team_id
      ? workers.filter((a) => a.team_id === task.frontmatter.team_id)
      : workers;

    const pool = teamCandidates.length ? teamCandidates : workers;
    const bestByLoad = [...pool].sort((a, b) => {
      const la = runningByAgent.get(a.agent_id) ?? 0;
      const lb = runningByAgent.get(b.agent_id) ?? 0;
      if (la !== lb) return la - lb;
      return a.name.localeCompare(b.name);
    })[0];

    const chosen = preferredByAssignee ?? bestByLoad;
    const duration = task.frontmatter.schedule?.duration_days ?? 1;
    const tokenBudget = suggestionTokenBudget({
      duration_days: duration,
      milestone_count: task.frontmatter.milestones.length,
      title: task.frontmatter.title
    });

    recommendations.push({
      task_id: task.task_id,
      preferred_provider: chosen?.provider ?? "codex",
      preferred_model: chosen?.model_hint,
      preferred_agent_id: chosen?.agent_id,
      token_budget_hint: tokenBudget,
      rationale: chosen
        ? `Selected ${chosen.name} based on team fit and active load.`
        : "No worker candidates found; fallback provider suggestion generated."
    });
  }

  return {
    workspace_dir: args.workspace_dir,
    project_id: args.project_id,
    generated_at: nowIso(),
    recommendations
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
