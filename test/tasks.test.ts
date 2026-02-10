import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { initWorkspace } from "../src/workspace/init.js";
import { createProject } from "../src/work/projects.js";
import { createTaskFile } from "../src/work/tasks.js";
import {
  addMilestoneToTaskMarkdown,
  newTaskMarkdown,
  validateTaskMarkdown
} from "../src/work/task_markdown.js";
import { validateWorkspace } from "../src/workspace/validate.js";

async function mkTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-"));
  return dir;
}

describe("tasks", () => {
  test("new task validates (draft)", () => {
    const md = newTaskMarkdown({
      project_id: "proj_123",
      title: "Implement Run Monitor",
      visibility: "team"
    });
    const res = validateTaskMarkdown(md);
    expect(res.ok).toBe(true);
  });

  test("add milestone appends milestone with default evidence for coding", () => {
    const md0 = newTaskMarkdown({
      project_id: "proj_123",
      title: "Implement Run Monitor",
      visibility: "team"
    });
    const res = addMilestoneToTaskMarkdown(md0, {
      title: "M1: list runs",
      kind: "coding",
      acceptance_criteria: ["Lists runs with status"],
      status: "ready"
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const v = validateTaskMarkdown(res.markdown);
    expect(v.ok).toBe(true);

    expect(res.markdown).toContain("milestones:");
    expect(res.markdown).toContain("requires_patch: true");
    expect(res.markdown).toContain("requires_tests: true");
  });

  test("workspace validation reports invalid task markdown", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });
    const { task_id, task_path } = await createTaskFile({
      workspace_dir: dir,
      project_id,
      title: "Bad Task",
      visibility: "team"
    });
    expect(task_id).toBeTruthy();

    // Break required heading.
    const raw = await fs.readFile(task_path, { encoding: "utf8" });
    await fs.writeFile(task_path, raw.replace("## Milestones", "## NotMilestones"), {
      encoding: "utf8"
    });

    const res = await validateWorkspace(dir);
    expect(res.ok).toBe(false);
  });
});
