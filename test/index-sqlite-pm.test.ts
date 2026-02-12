import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { initWorkspace } from "../src/workspace/init.js";
import { createTeam } from "../src/org/teams.js";
import { createAgent } from "../src/org/agents.js";
import { createTaskFile } from "../src/work/tasks.js";
import { routeRpcMethod } from "../src/server/router.js";
import {
  rebuildSqliteIndex,
  listIndexedConversations,
  listIndexedMessages,
  listIndexedTasks,
  listIndexedTaskMilestones,
  listIndexedAgentCounters,
  readIndexStats
} from "../src/index/sqlite.js";

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-"));
}

describe("sqlite PM projections", () => {
  test("indexes conversations/messages/tasks/milestones/agent counters", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });

    const team = await createTeam({ workspace_dir: dir, name: "Security" });
    const ceo = await createAgent({
      workspace_dir: dir,
      name: "CEO",
      role: "ceo",
      provider: "manual"
    });
    const worker = await createAgent({
      workspace_dir: dir,
      name: "Sec Worker",
      role: "worker",
      provider: "codex",
      team_id: team.team_id
    });

    const project = (await routeRpcMethod("workspace.project.create_with_defaults", {
      workspace_dir: dir,
      name: "Projection Project",
      ceo_actor_id: ceo.agent_id
    })) as any;

    const convs = (await routeRpcMethod("conversation.list", {
      workspace_dir: dir,
      scope: "project",
      project_id: project.project_id
    })) as any[];
    const execConv = convs.find((c) => c.slug === "executive-meeting");
    expect(execConv).toBeDefined();

    await routeRpcMethod("conversation.message.send", {
      workspace_dir: dir,
      scope: "project",
      project_id: project.project_id,
      conversation_id: execConv.id,
      author_id: ceo.agent_id,
      author_role: "ceo",
      body: "Ship PM dashboard this week"
    });

    const task = await createTaskFile({
      workspace_dir: dir,
      project_id: project.project_id,
      title: "Harden auth flow",
      visibility: "team",
      team_id: team.team_id,
      assignee_agent_id: worker.agent_id
    });

    await routeRpcMethod("task.update_plan", {
      workspace_dir: dir,
      project_id: project.project_id,
      task_id: task.task_id,
      schedule: { duration_days: 2, depends_on_task_ids: [] },
      execution_plan: {
        preferred_provider: "codex",
        preferred_model: "gpt-5-codex",
        preferred_agent_id: worker.agent_id,
        token_budget_hint: 12000,
        applied_by: ceo.agent_id
      }
    });

    await rebuildSqliteIndex(dir);

    const idxConvs = await listIndexedConversations({ workspace_dir: dir, project_id: project.project_id });
    expect(idxConvs.some((c) => c.slug === "executive-meeting")).toBe(true);

    const idxMsgs = await listIndexedMessages({ workspace_dir: dir, conversation_id: execConv.id });
    expect(idxMsgs.length).toBeGreaterThanOrEqual(1);

    const idxTasks = await listIndexedTasks({ workspace_dir: dir, project_id: project.project_id });
    expect(idxTasks.some((t) => t.task_id === task.task_id)).toBe(true);

    const idxMilestones = await listIndexedTaskMilestones({ workspace_dir: dir, project_id: project.project_id });
    expect(Array.isArray(idxMilestones)).toBe(true);

    const counters = await listIndexedAgentCounters({ workspace_dir: dir });
    expect(counters.some((c) => c.agent_id === worker.agent_id)).toBe(true);

    const stats = await readIndexStats(dir);
    expect(stats.conversations).toBeGreaterThanOrEqual(1);
    expect(stats.messages).toBeGreaterThanOrEqual(1);
    expect(stats.tasks).toBeGreaterThanOrEqual(1);
  });
});
