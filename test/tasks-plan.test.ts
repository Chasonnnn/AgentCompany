import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { initWorkspace } from "../src/workspace/init.js";
import { createProject } from "../src/work/projects.js";
import { createTaskFile } from "../src/work/tasks.js";
import { listProjectTasks } from "../src/work/tasks_list.js";
import { updateTaskPlan } from "../src/work/tasks_plan_update.js";
import { validateTaskMarkdown } from "../src/work/task_markdown.js";

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-"));
}

describe("task planning metadata", () => {
  test("updates schedule + execution plan while keeping task markdown valid", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const { project_id } = await createProject({ workspace_dir: dir, name: "Planner" });
    const { task_id, task_path } = await createTaskFile({
      workspace_dir: dir,
      project_id,
      title: "Plan deployment",
      visibility: "team"
    });

    await updateTaskPlan({
      workspace_dir: dir,
      project_id,
      task_id,
      schedule: {
        planned_start: "2026-02-15T00:00:00.000Z",
        duration_days: 3,
        depends_on_task_ids: []
      },
      execution_plan: {
        preferred_provider: "codex",
        preferred_model: "gpt-5-codex",
        preferred_agent_id: "agent_worker_planner",
        token_budget_hint: 42000,
        applied_by: "human_ceo"
      }
    });

    const tasks = await listProjectTasks({ workspace_dir: dir, project_id });
    const task = tasks.find((t) => t.frontmatter.id === task_id);
    expect(task).toBeDefined();
    expect(task?.frontmatter.schedule?.duration_days).toBe(3);
    expect(task?.frontmatter.execution_plan?.preferred_model).toBe("gpt-5-codex");

    const md = await fs.readFile(task_path, { encoding: "utf8" });
    const valid = validateTaskMarkdown(md);
    expect(valid.ok).toBe(true);
  });
});
