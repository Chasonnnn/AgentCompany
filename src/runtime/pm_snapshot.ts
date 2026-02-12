import { nowIso } from "../core/time.js";
import { listProjects } from "../work/projects_list.js";
import { listProjectTasks, type ListedTask } from "../work/tasks_list.js";
import { buildResourcesSnapshot } from "./resources_snapshot.js";
import { buildWorkspaceHomeSnapshot } from "./workspace_home.js";

type CpmNode = {
  task_id: string;
  duration_days: number;
  depends_on_task_ids: string[];
};

type CpmResolved = {
  topological_order: string[];
  earliest_start: Map<string, number>;
  earliest_finish: Map<string, number>;
  latest_start: Map<string, number>;
  latest_finish: Map<string, number>;
  critical_task_ids: Set<string>;
  project_span_days: number;
  status: "ok" | "dependency_cycle";
};

export type PmSnapshot = {
  workspace_dir: string;
  generated_at: string;
  scope: "workspace" | "project";
  workspace: {
    summary: {
      project_count: number;
      active_runs: number;
      pending_reviews: number;
      total_tokens: number;
      progress_pct: number;
      blocked_projects: number;
    };
    projects: Array<{
      project_id: string;
      name: string;
      task_count: number;
      progress_pct: number;
      blocked_tasks: number;
      active_runs: number;
      pending_reviews: number;
      risk_flags: string[];
    }>;
  };
  project?: {
    project_id: string;
    summary: {
      task_count: number;
      done_tasks: number;
      blocked_tasks: number;
      in_progress_tasks: number;
      progress_pct: number;
    };
    gantt: {
      cpm_status: "ok" | "dependency_cycle";
      project_span_days: number;
      tasks: Array<{
        task_id: string;
        title: string;
        status: string;
        team_id?: string;
        assignee_agent_id?: string;
        progress_pct: number;
        start_at: string;
        end_at: string;
        duration_days: number;
        slack_days: number;
        critical: boolean;
        depends_on_task_ids: string[];
      }>;
    };
  };
};

function parseIso(value: string | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function dateAtDay(baseMs: number, dayOffset: number): string {
  return new Date(baseMs + dayOffset * 86_400_000).toISOString();
}

function durationForTask(task: ListedTask): number {
  const s = task.frontmatter.schedule;
  if (s?.duration_days && s.duration_days > 0) return s.duration_days;
  const start = parseIso(s?.planned_start);
  const end = parseIso(s?.planned_end);
  if (start !== null && end !== null && end >= start) {
    return Math.max(1, Math.ceil((end - start) / 86_400_000));
  }
  return 1;
}

function buildCpm(nodes: CpmNode[]): CpmResolved {
  const ids = new Set(nodes.map((n) => n.task_id));
  const incoming = new Map<string, Set<string>>();
  const outgoing = new Map<string, Set<string>>();
  const duration = new Map(nodes.map((n) => [n.task_id, Math.max(1, n.duration_days)]));

  for (const node of nodes) {
    incoming.set(node.task_id, new Set());
    outgoing.set(node.task_id, new Set());
  }

  for (const node of nodes) {
    const deps = node.depends_on_task_ids.filter((d) => d !== node.task_id && ids.has(d));
    for (const dep of deps) {
      incoming.get(node.task_id)?.add(dep);
      outgoing.get(dep)?.add(node.task_id);
    }
  }

  const indegree = new Map<string, number>();
  for (const id of ids) indegree.set(id, incoming.get(id)?.size ?? 0);

  const queue = [...ids].filter((id) => (indegree.get(id) ?? 0) === 0).sort();
  const order: string[] = [];

  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of outgoing.get(id) ?? []) {
      const rem = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, rem);
      if (rem === 0) {
        queue.push(next);
        queue.sort();
      }
    }
  }

  const cycle = order.length !== ids.size;
  const topo = cycle ? [...ids] : order;

  const es = new Map<string, number>();
  const ef = new Map<string, number>();
  for (const id of topo) {
    let start = 0;
    for (const dep of incoming.get(id) ?? []) {
      start = Math.max(start, ef.get(dep) ?? 0);
    }
    es.set(id, start);
    ef.set(id, start + (duration.get(id) ?? 1));
  }

  const span = Math.max(0, ...[...ef.values()]);
  const ls = new Map<string, number>();
  const lf = new Map<string, number>();
  for (const id of [...topo].reverse()) {
    const children = [...(outgoing.get(id) ?? [])];
    const latestFinish =
      children.length === 0
        ? span
        : Math.min(...children.map((c) => ls.get(c) ?? span));
    lf.set(id, latestFinish);
    ls.set(id, latestFinish - (duration.get(id) ?? 1));
  }

  const critical = new Set<string>();
  for (const id of ids) {
    const slack = (ls.get(id) ?? 0) - (es.get(id) ?? 0);
    if (Math.abs(slack) < 0.0001) critical.add(id);
  }

  return {
    topological_order: topo,
    earliest_start: es,
    earliest_finish: ef,
    latest_start: ls,
    latest_finish: lf,
    critical_task_ids: critical,
    project_span_days: span,
    status: cycle ? "dependency_cycle" : "ok"
  };
}

function progressPct(tasks: ListedTask[]): number {
  if (tasks.length === 0) return 0;
  const ratio = tasks.reduce((sum, t) => sum + t.progress_ratio, 0) / tasks.length;
  return Math.round(ratio * 1000) / 10;
}

async function projectSnapshot(args: {
  workspace_dir: string;
  project_id: string;
}): Promise<{
  summary: {
    task_count: number;
    done_tasks: number;
    blocked_tasks: number;
    in_progress_tasks: number;
    progress_pct: number;
  };
  gantt: {
    cpm_status: "ok" | "dependency_cycle";
    project_span_days: number;
    tasks: Array<{
      task_id: string;
      title: string;
      status: string;
      team_id?: string;
      assignee_agent_id?: string;
      progress_pct: number;
      start_at: string;
      end_at: string;
      duration_days: number;
      slack_days: number;
      critical: boolean;
      depends_on_task_ids: string[];
    }>;
  };
}> {
  const tasks = await listProjectTasks({
    workspace_dir: args.workspace_dir,
    project_id: args.project_id
  });

  const nodes: CpmNode[] = tasks.map((t) => ({
    task_id: t.task_id,
    duration_days: durationForTask(t),
    depends_on_task_ids: t.frontmatter.schedule?.depends_on_task_ids ?? []
  }));
  const cpm = buildCpm(nodes);

  const explicitStarts = tasks
    .map((t) => parseIso(t.frontmatter.schedule?.planned_start))
    .filter((v): v is number => v !== null);
  const baseMs = explicitStarts.length ? Math.min(...explicitStarts) : Date.now();

  const bars = tasks.map((t) => {
    const startExplicit = parseIso(t.frontmatter.schedule?.planned_start);
    const endExplicit = parseIso(t.frontmatter.schedule?.planned_end);
    const duration = durationForTask(t);
    const es = cpm.earliest_start.get(t.task_id) ?? 0;
    const ef = cpm.earliest_finish.get(t.task_id) ?? es + duration;
    const ls = cpm.latest_start.get(t.task_id) ?? es;

    const startAt = startExplicit !== null ? new Date(startExplicit).toISOString() : dateAtDay(baseMs, es);
    const endAt =
      endExplicit !== null && endExplicit >= (startExplicit ?? Number.MIN_SAFE_INTEGER)
        ? new Date(endExplicit).toISOString()
        : dateAtDay(baseMs, Math.max(ef, es + 1));

    return {
      task_id: t.task_id,
      title: t.frontmatter.title,
      status: t.frontmatter.status,
      team_id: t.frontmatter.team_id,
      assignee_agent_id: t.frontmatter.assignee_agent_id,
      progress_pct: Math.round(t.progress_ratio * 1000) / 10,
      start_at: startAt,
      end_at: endAt,
      duration_days: duration,
      slack_days: Math.max(0, ls - es),
      critical: cpm.critical_task_ids.has(t.task_id),
      depends_on_task_ids: t.frontmatter.schedule?.depends_on_task_ids ?? []
    };
  });

  const done = tasks.filter((t) => t.frontmatter.status === "done").length;
  const blocked = tasks.filter((t) => t.frontmatter.status === "blocked").length;
  const inProgress = tasks.filter((t) => t.frontmatter.status === "in_progress").length;

  return {
    summary: {
      task_count: tasks.length,
      done_tasks: done,
      blocked_tasks: blocked,
      in_progress_tasks: inProgress,
      progress_pct: progressPct(tasks)
    },
    gantt: {
      cpm_status: cpm.status,
      project_span_days: cpm.project_span_days,
      tasks: bars.sort((a, b) => (a.start_at < b.start_at ? -1 : a.start_at > b.start_at ? 1 : 0))
    }
  };
}

export async function buildPmSnapshot(args: {
  workspace_dir: string;
  scope: "workspace" | "project";
  project_id?: string;
}): Promise<PmSnapshot> {
  const [projects, home, resources] = await Promise.all([
    listProjects({ workspace_dir: args.workspace_dir }),
    buildWorkspaceHomeSnapshot({ workspace_dir: args.workspace_dir }),
    buildResourcesSnapshot({ workspace_dir: args.workspace_dir })
  ]);

  const pendingMap = new Map(home.projects.map((p) => [p.project_id, p.pending_reviews]));
  const activeMap = new Map(home.projects.map((p) => [p.project_id, p.active_runs]));

  const projectRows = await Promise.all(
    projects.map(async (project) => {
      const p = await projectSnapshot({
        workspace_dir: args.workspace_dir,
        project_id: project.project_id
      });
      const riskFlags: string[] = [];
      if (p.summary.blocked_tasks > 0) riskFlags.push("blocked_tasks");
      if ((pendingMap.get(project.project_id) ?? 0) > 0) riskFlags.push("pending_reviews");
      if (p.gantt.cpm_status === "dependency_cycle") riskFlags.push("dependency_cycle");
      return {
        project_id: project.project_id,
        name: project.name,
        task_count: p.summary.task_count,
        progress_pct: p.summary.progress_pct,
        blocked_tasks: p.summary.blocked_tasks,
        active_runs: activeMap.get(project.project_id) ?? 0,
        pending_reviews: pendingMap.get(project.project_id) ?? 0,
        risk_flags: riskFlags
      };
    })
  );

  const workspaceSummary = {
    project_count: projectRows.length,
    active_runs: projectRows.reduce((sum, p) => sum + p.active_runs, 0),
    pending_reviews: projectRows.reduce((sum, p) => sum + p.pending_reviews, 0),
    total_tokens: resources.totals.total_tokens,
    progress_pct:
      projectRows.length > 0
        ? Math.round((projectRows.reduce((sum, p) => sum + p.progress_pct, 0) / projectRows.length) * 10) /
          10
        : 0,
    blocked_projects: projectRows.filter((p) => p.blocked_tasks > 0).length
  };

  const out: PmSnapshot = {
    workspace_dir: args.workspace_dir,
    generated_at: nowIso(),
    scope: args.scope,
    workspace: {
      summary: workspaceSummary,
      projects: projectRows
    }
  };

  if (args.scope === "project" && args.project_id) {
    const p = await projectSnapshot({
      workspace_dir: args.workspace_dir,
      project_id: args.project_id
    });
    out.project = {
      project_id: args.project_id,
      summary: p.summary,
      gantt: p.gantt
    };
  }

  return out;
}
