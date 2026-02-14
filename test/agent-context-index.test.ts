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
  test("writes per-agent context_index.md from assigned tasks and role/skills files without mutating AGENTS.md", async () => {
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
    expect(typeof first.context_index_relpath).toBe("string");

    const contextPath = path.join(dir, first.context_index_relpath);
    const context = await fs.readFile(contextPath, { encoding: "utf8" });
    const rolePath = path.join(dir, "org/agents", workerA.agent_id, "role.md");
    const skillsPath = path.join(dir, "org/agents", workerA.agent_id, "skills_index.md");
    await fs.access(rolePath);
    await fs.access(skillsPath);
    const roleContent = await fs.readFile(rolePath, { encoding: "utf8" });
    const skillsContent = await fs.readFile(skillsPath, { encoding: "utf8" });
    expect(roleContent).toContain("Escalation");
    expect(skillsContent).toContain("Approved Skills");

    expect(context.includes(path.join("work/projects", project_id, "tasks", `${taskA.task_id}.md`))).toBe(
      true
    );
    expect(context.includes(path.join("work/projects", project_id, "tasks", `${taskB.task_id}.md`))).toBe(
      false
    );
    expect(context.includes("task_scope_repo_id")).toBe(true);
    expect(context.includes("task_scope_path")).toBe(true);
    expect(context.includes(`org/agents/${workerA.agent_id}/role.md`)).toBe(true);
    expect(context.includes(`org/agents/${workerA.agent_id}/skills_index.md`)).toBe(true);

    const agentsPath = path.join(dir, "org/agents", workerA.agent_id, "AGENTS.md");
    let agents = "";
    try {
      agents = await fs.readFile(agentsPath, { encoding: "utf8" });
    } catch {
      agents = "";
    }
    expect(agents.includes("<!-- managed: context-index -->")).toBe(false);

    const second = await refreshAgentContextIndex({
      workspace_dir: dir,
      agent_id: workerA.agent_id,
      project_id,
      max_tasks: 20,
      max_scope_paths: 20
    });
    const contextAfter = await fs.readFile(contextPath, { encoding: "utf8" });
    expect(second.assignment_count).toBe(1);
    expect(second.updated).toBe(false);
    expect(contextAfter).toBe(context);
  });
});
