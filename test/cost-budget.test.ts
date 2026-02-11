import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { initWorkspace } from "../src/workspace/init.js";
import { createTeam } from "../src/org/teams.js";
import { createAgent } from "../src/org/agents.js";
import { createProject } from "../src/work/projects.js";
import { createRun } from "../src/runtime/run.js";
import { executeCommandRun } from "../src/runtime/execute_command.js";
import { readYamlFile, writeYamlFile } from "../src/store/yaml.js";
import { RunYaml } from "../src/schemas/run.js";
import { createTaskFile } from "../src/work/tasks.js";
import { parseFrontMatter } from "../src/artifacts/frontmatter.js";
import { buildRunMonitorSnapshot } from "../src/runtime/run_monitor.js";

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-"));
}

async function readJsonl(filePath: string): Promise<any[]> {
  const s = await fs.readFile(filePath, { encoding: "utf8" });
  return s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

describe("cost accounting + budget enforcement", () => {
  test("writes run usage with computed USD cost from provider pricing", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const machinePath = path.join(dir, ".local/machine.yaml");
    const machineDoc = await readYamlFile(machinePath);
    await writeYamlFile(machinePath, {
      ...machineDoc,
      provider_pricing_usd_per_1k_tokens: {
        cmd: {
          input: 0.02,
          cached_input: 0.01,
          output: 0.03,
          reasoning_output: 0.03
        }
      }
    });

    const { team_id } = await createTeam({ workspace_dir: dir, name: "Payments" });
    const { agent_id } = await createAgent({
      workspace_dir: dir,
      name: "Worker",
      role: "worker",
      provider: "cmd",
      team_id
    });
    const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });
    const { run_id } = await createRun({ workspace_dir: dir, project_id, agent_id, provider: "cmd" });

    const usageLine = JSON.stringify({
      tokenUsage: {
        input_tokens: 500,
        cached_input_tokens: 100,
        output_tokens: 200,
        reasoning_output_tokens: 50,
        total_tokens: 850
      }
    });
    const res = await executeCommandRun({
      workspace_dir: dir,
      project_id,
      run_id,
      argv: [process.execPath, "-e", `process.stdout.write(${JSON.stringify(`${usageLine}\n`)});`]
    });
    expect(res.exit_code).toBe(0);

    const runDoc = RunYaml.parse(
      await readYamlFile(path.join(dir, "work/projects", project_id, "runs", run_id, "run.yaml"))
    );
    expect(runDoc.usage?.source).toBe("provider_reported");
    expect(runDoc.usage?.total_tokens).toBe(850);
    expect(runDoc.usage?.cost_usd).toBeCloseTo(0.0185, 6);
  });

  test("enforces project/task budgets with alert and hard-fail events", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });

    const machinePath = path.join(dir, ".local/machine.yaml");
    const machineDoc = await readYamlFile(machinePath);
    await writeYamlFile(machinePath, {
      ...machineDoc,
      provider_pricing_usd_per_1k_tokens: {
        cmd: {
          input: 0.02,
          cached_input: 0.01,
          output: 0.03,
          reasoning_output: 0.03
        }
      }
    });

    const { team_id } = await createTeam({ workspace_dir: dir, name: "Payments" });
    const { agent_id } = await createAgent({
      workspace_dir: dir,
      name: "Worker",
      role: "worker",
      provider: "cmd",
      team_id
    });
    const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });

    const projectPath = path.join(dir, "work/projects", project_id, "project.yaml");
    const projectDoc = await readYamlFile(projectPath);
    await writeYamlFile(projectPath, {
      ...projectDoc,
      budget: {
        soft_cost_usd: 0.005,
        hard_cost_usd: 0.01
      }
    });

    const { task_id, task_path } = await createTaskFile({
      workspace_dir: dir,
      project_id,
      title: "Budgeted task",
      visibility: "team",
      assignee_agent_id: agent_id
    });
    const taskMd = await fs.readFile(task_path, { encoding: "utf8" });
    const parsed = parseFrontMatter(taskMd);
    if (!parsed.ok) throw new Error(parsed.error);
    const updatedTask = [
      "---",
      JSON.stringify(
        {
          ...parsed.frontmatter,
          budget: {
            soft_cost_usd: 0.005,
            hard_cost_usd: 0.01
          }
        },
        null,
        2
      ),
      "---",
      parsed.body
    ].join("\n");
    await fs.writeFile(task_path, updatedTask, { encoding: "utf8" });

    const { run_id } = await createRun({ workspace_dir: dir, project_id, agent_id, provider: "cmd" });
    const usageLine = JSON.stringify({
      tokenUsage: {
        input_tokens: 500,
        cached_input_tokens: 100,
        output_tokens: 200,
        reasoning_output_tokens: 50,
        total_tokens: 850
      }
    });
    await executeCommandRun({
      workspace_dir: dir,
      project_id,
      run_id,
      task_id,
      argv: [process.execPath, "-e", `process.stdout.write(${JSON.stringify(`${usageLine}\n`)});`]
    });

    const runDoc = RunYaml.parse(
      await readYamlFile(path.join(dir, "work/projects", project_id, "runs", run_id, "run.yaml"))
    );
    expect(runDoc.status).toBe("failed");
    expect(runDoc.usage?.cost_usd).toBeCloseTo(0.0185, 6);

    const events = await readJsonl(
      path.join(dir, "work/projects", project_id, "runs", run_id, "events.jsonl")
    );
    expect(events.some((e) => e.type === "budget.alert")).toBe(true);
    expect(events.some((e) => e.type === "budget.exceeded")).toBe(true);
    expect(events.some((e) => e.type === "budget.decision")).toBe(true);
    expect(
      events.some(
        (e) =>
          e.type === "budget.decision" &&
          e.payload?.result === "exceeded" &&
          e.payload?.scope === "project"
      )
    ).toBe(true);

    const snap = await buildRunMonitorSnapshot({
      workspace_dir: dir,
      project_id,
      refresh_index: true
    });
    const row = snap.rows.find((r) => r.run_id === run_id);
    expect(row).toBeDefined();
    expect((row?.budget_alert_count ?? 0) > 0).toBe(true);
    expect((row?.budget_exceeded_count ?? 0) > 0).toBe(true);
    expect((row?.budget_decision_count ?? 0) > 0).toBe(true);
  });
});
