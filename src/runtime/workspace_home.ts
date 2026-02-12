import { nowIso } from "../core/time.js";
import { listProjects } from "../work/projects_list.js";
import { buildRunMonitorSnapshot } from "./run_monitor.js";
import { buildReviewInboxSnapshot } from "./review_inbox.js";
import { readProjectRepoLinks } from "../work/project_repo_links.js";
import { listProjectTasks } from "../work/tasks_list.js";

export type WorkspaceProjectTile = {
  project_id: string;
  name: string;
  status: "active" | "archived";
  created_at: string;
  repo_ids: string[];
  pending_reviews: number;
  active_runs: number;
  task_count: number;
  progress_pct: number;
  blocked_tasks: number;
  risk_flags: string[];
};

export type WorkspaceHomeSnapshot = {
  workspace_dir: string;
  generated_at: string;
  projects: WorkspaceProjectTile[];
  summary: {
    project_count: number;
    pending_reviews: number;
    active_runs: number;
    task_count: number;
    progress_pct: number;
    blocked_projects: number;
  };
};

export async function buildWorkspaceHomeSnapshot(args: {
  workspace_dir: string;
}): Promise<WorkspaceHomeSnapshot> {
  const [projects, monitor, inbox] = await Promise.all([
    listProjects({ workspace_dir: args.workspace_dir }),
    buildRunMonitorSnapshot({
      workspace_dir: args.workspace_dir,
      limit: 500
    }),
    buildReviewInboxSnapshot({
      workspace_dir: args.workspace_dir,
      pending_limit: 500,
      decisions_limit: 200
    })
  ]);

  const pendingByProject = new Map<string, number>();
  for (const p of inbox.pending) {
    pendingByProject.set(p.project_id, (pendingByProject.get(p.project_id) ?? 0) + 1);
  }
  const activeByProject = new Map<string, number>();
  for (const row of monitor.rows) {
    if (row.live_status === "running" || row.run_status === "running") {
      activeByProject.set(row.project_id, (activeByProject.get(row.project_id) ?? 0) + 1);
    }
  }

  const tiles: WorkspaceProjectTile[] = [];
  for (const p of projects) {
    const [repos, tasks] = await Promise.all([
      readProjectRepoLinks({
        workspace_dir: args.workspace_dir,
        project_id: p.project_id
      }),
      listProjectTasks({
        workspace_dir: args.workspace_dir,
        project_id: p.project_id
      })
    ]);
    const blockedTasks = tasks.filter((t) => t.frontmatter.status === "blocked").length;
    const progressPct =
      tasks.length > 0
        ? Math.round((tasks.reduce((sum, t) => sum + t.progress_ratio, 0) / tasks.length) * 1000) / 10
        : 0;
    const riskFlags: string[] = [];
    if ((pendingByProject.get(p.project_id) ?? 0) > 0) riskFlags.push("pending_reviews");
    if (blockedTasks > 0) riskFlags.push("blocked_tasks");
    tiles.push({
      project_id: p.project_id,
      name: p.name,
      status: p.status,
      created_at: p.created_at,
      repo_ids: repos.repos.map((r) => r.repo_id),
      pending_reviews: pendingByProject.get(p.project_id) ?? 0,
      active_runs: activeByProject.get(p.project_id) ?? 0,
      task_count: tasks.length,
      progress_pct: progressPct,
      blocked_tasks: blockedTasks,
      risk_flags: riskFlags
    });
  }

  return {
    workspace_dir: args.workspace_dir,
    generated_at: nowIso(),
    projects: tiles,
    summary: {
      project_count: tiles.length,
      pending_reviews: tiles.reduce((n, p) => n + p.pending_reviews, 0),
      active_runs: tiles.reduce((n, p) => n + p.active_runs, 0),
      task_count: tiles.reduce((n, p) => n + p.task_count, 0),
      progress_pct:
        tiles.length > 0
          ? Math.round((tiles.reduce((n, p) => n + p.progress_pct, 0) / tiles.length) * 10) / 10
          : 0,
      blocked_projects: tiles.filter((p) => p.blocked_tasks > 0).length
    }
  };
}
