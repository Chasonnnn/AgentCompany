import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { describe, expect, test } from "vitest";
import { initWorkspace } from "../src/workspace/init.js";
import { createTeam } from "../src/org/teams.js";
import { createAgent } from "../src/org/agents.js";
import { createProject } from "../src/work/projects.js";
import { createTaskFile } from "../src/work/tasks.js";
import { parseFrontMatter } from "../src/artifacts/frontmatter.js";
import { TaskFrontMatter } from "../src/work/task_markdown.js";
import { refreshAgentContextIndex } from "../src/eval/agent_context_index.js";

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-"));
}

describe("agent context index", () => {
  test("refreshes per-agent AGENTS.md context index from assigned tasks", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });

    const { team_id } = await createTeam({ workspace_dir: dir, name: "Payments" });
    const workerA = await createAgent({
      workspace_dir: dir,
      name: "Worker A",
      role: "worker",
      provider: "codex",
      team_id
    });
    const workerB = await createAgent({
      workspace_dir: dir,
      name: "Worker B",
      role: "worker",
      provider: "codex",
      team_id
    });

    const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });

    const taskA = await createTaskFile({
      workspace_dir: dir,
      project_id,
      title: "Task A",
      visibility: "team",
      team_id,
      assignee_agent_id: workerA.agent_id
    });
    const taskB = await createTaskFile({
      workspace_dir: dir,
      project_id,
      title: "Task B",
      visibility: "team",
      team_id,
      assignee_agent_id: workerB.agent_id
    });

    const taskAMd = await fs.readFile(taskA.task_path, { encoding: "utf8" });
    const parsed = parseFrontMatter(taskAMd);
    if (!parsed.ok) throw new Error(parsed.error);
    const fm = TaskFrontMatter.parse(parsed.frontmatter);
    fm.scope = {
      repo_id: "repo_payments",
      workdir_rel: "repos/payments",
      paths: ["src/core", "README.md"],
      requires_worktree_isolation: true
    };
    const fmText = YAML.stringify(fm, { aliasDuplicateObjects: false }).trimEnd();
    const rebuilt = `---\n${fmText}\n---\n${parsed.body.startsWith("\n") ? parsed.body : `\n${parsed.body}`}`;
    await fs.writeFile(taskA.task_path, rebuilt, { encoding: "utf8" });

    const first = await refreshAgentContextIndex({
      workspace_dir: dir,
      agent_id: workerA.agent_id,
      project_id,
      max_tasks: 20,
      max_scope_paths: 20
    });

    expect(first.assignment_count).toBe(1);
    expect(first.reference_count).toBeGreaterThan(0);
    expect(first.updated).toBe(true);

    const guidancePath = path.join(dir, first.agents_md_relpath);
    const guidance = await fs.readFile(guidancePath, { encoding: "utf8" });
    expect(guidance.includes("<!-- managed: context-index -->")).toBe(true);
    expect(guidance.includes(path.join("work/projects", project_id, "tasks", `${taskA.task_id}.md`))).toBe(
      true
    );
    expect(guidance.includes(path.join("work/projects", project_id, "tasks", `${taskB.task_id}.md`))).toBe(
      false
    );
    expect(guidance.includes("task_scope_repo_id")).toBe(true);
    expect(guidance.includes("task_scope_path")).toBe(true);

    const second = await refreshAgentContextIndex({
      workspace_dir: dir,
      agent_id: workerA.agent_id,
      project_id,
      max_tasks: 20,
      max_scope_paths: 20
    });
    const guidanceAfter = await fs.readFile(guidancePath, { encoding: "utf8" });
    expect(second.assignment_count).toBe(1);
    expect(second.updated).toBe(false);
    expect(guidanceAfter.split("<!-- managed: context-index -->").length - 1).toBe(1);
  });
});
