import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { initWorkspace } from "../src/workspace/init.js";
import { createTeam } from "../src/org/teams.js";
import { createAgent } from "../src/org/agents.js";
import { routeRpcMethod } from "../src/server/router.js";
import { createTaskFile } from "../src/work/tasks.js";

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-"));
}

describe("pm snapshot + allocations", () => {
  test("returns workspace/project PM snapshots and applies task-level allocation plans", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });

    const team = await createTeam({ workspace_dir: dir, name: "Frontend" });
    const ceo = await createAgent({
      workspace_dir: dir,
      name: "CEO",
      role: "ceo",
      provider: "manual"
    });
    const worker = await createAgent({
      workspace_dir: dir,
      name: "FE Worker",
      role: "worker",
      provider: "codex",
      team_id: team.team_id,
      model_hint: "gpt-5-codex"
    });

    const created = (await routeRpcMethod("workspace.project.create_with_defaults", {
      workspace_dir: dir,
      name: "PM Rewrite",
      ceo_actor_id: ceo.agent_id
    })) as any;

    const task = await createTaskFile({
      workspace_dir: dir,
      project_id: created.project_id,
      title: "Deliver sidebar redesign",
      visibility: "team",
      team_id: team.team_id,
      assignee_agent_id: worker.agent_id
    });

    await routeRpcMethod("task.update_plan", {
      workspace_dir: dir,
      project_id: created.project_id,
      task_id: task.task_id,
      schedule: {
        planned_start: "2026-02-20T00:00:00.000Z",
        duration_days: 5,
        depends_on_task_ids: []
      }
    });

    const workspacePm = (await routeRpcMethod("pm.snapshot", {
      workspace_dir: dir,
      scope: "workspace"
    })) as any;
    expect(workspacePm.workspace.summary.project_count).toBeGreaterThanOrEqual(1);

    const projectPm = (await routeRpcMethod("pm.snapshot", {
      workspace_dir: dir,
      scope: "project",
      project_id: created.project_id
    })) as any;
    expect(projectPm.project.gantt.tasks.some((t: any) => t.task_id === task.task_id)).toBe(true);
    expect(["ok", "dependency_cycle"]).toContain(projectPm.project.gantt.cpm_status);

    const recs = (await routeRpcMethod("pm.recommend_allocations", {
      workspace_dir: dir,
      project_id: created.project_id
    })) as any;
    expect(Array.isArray(recs.recommendations)).toBe(true);
    expect(recs.forecast.mode).toBe("simulation_v1");
    expect(typeof recs.forecast.baseline.projected_span_days).toBe("number");
    expect(typeof recs.forecast.recommended.projected_span_days).toBe("number");
    expect(Array.isArray(recs.forecast.scenarios)).toBe(true);
    expect(recs.forecast.scenarios.length).toBeGreaterThanOrEqual(2);

    const first = recs.recommendations.find((r: any) => r.task_id === task.task_id);
    expect(first).toBeDefined();

    await routeRpcMethod("pm.apply_allocations", {
      workspace_dir: dir,
      project_id: created.project_id,
      applied_by: ceo.agent_id,
      items: [
        {
          task_id: task.task_id,
          preferred_provider: first.preferred_provider,
          preferred_model: first.preferred_model,
          preferred_agent_id: first.preferred_agent_id,
          token_budget_hint: first.token_budget_hint
        }
      ]
    });

    const tasks = (await routeRpcMethod("task.list", {
      workspace_dir: dir,
      project_id: created.project_id
    })) as any;
    const updated = tasks.tasks.find((t: any) => t.frontmatter.id === task.task_id);
    expect(updated.frontmatter.execution_plan.preferred_model).toBe(first.preferred_model);
    expect(updated.frontmatter.execution_plan.applied_by).toBe(ceo.agent_id);
  }, 15000);
});
