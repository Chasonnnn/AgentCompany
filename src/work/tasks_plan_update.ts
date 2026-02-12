import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { nowIso } from "../core/time.js";
import { parseFrontMatter } from "../artifacts/frontmatter.js";
import {
  TaskFrontMatter,
  TaskSchedule,
  TaskExecutionPlan,
  type TaskFrontMatter as TaskFrontMatterType,
  type TaskSchedule as TaskScheduleType,
  type TaskExecutionPlan as TaskExecutionPlanType
} from "./task_markdown.js";
import { writeFileAtomic } from "../store/fs.js";

function rebuildTaskMarkdown(frontmatter: TaskFrontMatterType, body: string): string {
  const fmText = YAML.stringify(frontmatter, { aliasDuplicateObjects: false }).trimEnd();
  return `---\n${fmText}\n---\n${body.startsWith("\n") ? body : `\n${body}`}`;
}

export async function updateTaskPlan(args: {
  workspace_dir: string;
  project_id: string;
  task_id: string;
  schedule?: TaskScheduleType;
  execution_plan?: TaskExecutionPlanType;
  clear_schedule?: boolean;
  clear_execution_plan?: boolean;
}): Promise<{ task_id: string; task_path: string; frontmatter: TaskFrontMatterType }> {
  const taskPath = path.join(
    args.workspace_dir,
    "work",
    "projects",
    args.project_id,
    "tasks",
    `${args.task_id}.md`
  );

  const markdown = await fs.readFile(taskPath, { encoding: "utf8" });
  const parsed = parseFrontMatter(markdown);
  if (!parsed.ok) throw new Error(parsed.error);

  const fmParsed = TaskFrontMatter.safeParse(parsed.frontmatter);
  if (!fmParsed.success) throw new Error("Task frontmatter is invalid");

  const next: TaskFrontMatterType = {
    ...fmParsed.data
  };

  if (args.clear_schedule) {
    delete next.schedule;
  } else if (args.schedule) {
    const schedule = TaskSchedule.parse(args.schedule);
    if (schedule.depends_on_task_ids.includes(args.task_id)) {
      throw new Error("schedule.depends_on_task_ids cannot contain the task itself");
    }
    next.schedule = {
      ...schedule,
      depends_on_task_ids: [...new Set(schedule.depends_on_task_ids.filter(Boolean))]
    };
  }

  if (args.clear_execution_plan) {
    delete next.execution_plan;
  } else if (args.execution_plan) {
    const plan = TaskExecutionPlan.parse(args.execution_plan);
    next.execution_plan = {
      ...next.execution_plan,
      ...plan,
      applied_at: plan.applied_by ? nowIso() : plan.applied_at ?? next.execution_plan?.applied_at
    };
  }

  const normalized = TaskFrontMatter.parse(next);
  const rebuilt = rebuildTaskMarkdown(normalized, parsed.body);
  await writeFileAtomic(taskPath, rebuilt);

  return {
    task_id: normalized.id,
    task_path: taskPath,
    frontmatter: normalized
  };
}
