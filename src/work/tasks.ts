import fs from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../store/fs.js";
import {
  addMilestoneToTaskMarkdown,
  type AddMilestoneArgs,
  newTaskMarkdown,
  validateTaskMarkdown
} from "./task_markdown.js";

export type CreateTaskFileArgs = {
  workspace_dir: string;
  project_id: string;
  title: string;
  visibility: "private_agent" | "team" | "managers" | "org";
  team_id?: string;
  assignee_agent_id?: string;
};

export async function createTaskFile(args: CreateTaskFileArgs): Promise<{
  task_id: string;
  task_path: string;
}> {
  const md = newTaskMarkdown({
    project_id: args.project_id,
    title: args.title,
    visibility: args.visibility,
    team_id: args.team_id,
    assignee_agent_id: args.assignee_agent_id
  });

  const validated = validateTaskMarkdown(md);
  if (!validated.ok) {
    // This should not happen; treat as a hard error.
    const msg = validated.issues.map((i) => i.message).join("; ");
    throw new Error(`Internal error: generated invalid task markdown: ${msg}`);
  }

  const taskId = validated.frontmatter.id;
  const taskRel = path.join("work/projects", args.project_id, "tasks", `${taskId}.md`);
  const taskAbs = path.join(args.workspace_dir, taskRel);

  await writeFileAtomic(taskAbs, md);
  return { task_id: taskId, task_path: taskAbs };
}

export type AddTaskMilestoneFileArgs = {
  workspace_dir: string;
  project_id: string;
  task_id: string;
  milestone: AddMilestoneArgs;
};

export async function addTaskMilestone(args: AddTaskMilestoneFileArgs): Promise<{
  milestone_id: string;
}> {
  const taskPath = path.join(
    args.workspace_dir,
    "work/projects",
    args.project_id,
    "tasks",
    `${args.task_id}.md`
  );
  const md = await fs.readFile(taskPath, { encoding: "utf8" });
  const res = addMilestoneToTaskMarkdown(md, args.milestone);
  if (!res.ok) throw new Error(res.error);
  await writeFileAtomic(taskPath, res.markdown);
  return { milestone_id: res.milestone_id };
}

