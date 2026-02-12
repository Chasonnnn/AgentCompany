import fs from "node:fs/promises";
import path from "node:path";
import { parseFrontMatter } from "../artifacts/frontmatter.js";
import { TaskFrontMatter, type TaskFrontMatter as TaskFrontMatterType } from "./task_markdown.js";

export type ListedTask = {
  task_id: string;
  project_id: string;
  relpath: string;
  abs_path: string;
  frontmatter: TaskFrontMatterType;
  progress_ratio: number;
  milestone_counts: {
    total: number;
    done: number;
    in_progress: number;
    blocked: number;
    ready: number;
    draft: number;
  };
};

function taskProgress(frontmatter: TaskFrontMatterType): {
  progress_ratio: number;
  milestone_counts: ListedTask["milestone_counts"];
} {
  const counts = {
    total: frontmatter.milestones.length,
    done: 0,
    in_progress: 0,
    blocked: 0,
    ready: 0,
    draft: 0
  };
  for (const ms of frontmatter.milestones) {
    if (ms.status === "done") counts.done += 1;
    else if (ms.status === "in_progress") counts.in_progress += 1;
    else if (ms.status === "blocked") counts.blocked += 1;
    else if (ms.status === "ready") counts.ready += 1;
    else counts.draft += 1;
  }
  const ratio = counts.total > 0 ? counts.done / counts.total : frontmatter.status === "done" ? 1 : 0;
  return {
    progress_ratio: Math.max(0, Math.min(1, ratio)),
    milestone_counts: counts
  };
}

async function listTaskFiles(tasksDir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(tasksDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

export async function listProjectTasks(args: {
  workspace_dir: string;
  project_id: string;
}): Promise<ListedTask[]> {
  const tasksDir = path.join(args.workspace_dir, "work", "projects", args.project_id, "tasks");
  const files = await listTaskFiles(tasksDir);
  const out: ListedTask[] = [];

  for (const file of files) {
    const abs = path.join(tasksDir, file);
    let markdown = "";
    try {
      markdown = await fs.readFile(abs, { encoding: "utf8" });
    } catch {
      continue;
    }
    const parsed = parseFrontMatter(markdown);
    if (!parsed.ok) continue;
    const fm = TaskFrontMatter.safeParse(parsed.frontmatter);
    if (!fm.success) continue;
    const progress = taskProgress(fm.data);
    out.push({
      task_id: fm.data.id,
      project_id: args.project_id,
      relpath: path.join("work", "projects", args.project_id, "tasks", file),
      abs_path: abs,
      frontmatter: fm.data,
      progress_ratio: progress.progress_ratio,
      milestone_counts: progress.milestone_counts
    });
  }

  out.sort((a, b) => {
    if (a.frontmatter.created_at !== b.frontmatter.created_at) {
      return a.frontmatter.created_at < b.frontmatter.created_at ? 1 : -1;
    }
    return a.task_id.localeCompare(b.task_id);
  });

  return out;
}
