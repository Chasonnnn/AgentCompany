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
import { routeRpcMethod } from "../src/server/router.js";
import { readYamlFile, writeYamlFile } from "../src/store/yaml.js";

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-"));
}

describe("usage analytics snapshot", () => {
  test("aggregates usage and costs by provider and exposes API route", async () => {
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

    const run1 = await createRun({ workspace_dir: dir, project_id, agent_id, provider: "cmd" });
    await executeCommandRun({
      workspace_dir: dir,
      project_id,
      run_id: run1.run_id,
      argv: [
        process.execPath,
        "-e",
        `process.stdout.write(${JSON.stringify(
          `${JSON.stringify({ usage: { prompt_tokens: 200, completion_tokens: 100, total_tokens: 300 } })}\n`
        )});`
      ]
    });

    const run2 = await createRun({ workspace_dir: dir, project_id, agent_id, provider: "cmd" });
    await executeCommandRun({
      workspace_dir: dir,
      project_id,
      run_id: run2.run_id,
      argv: [
        process.execPath,
        "-e",
        `process.stdout.write(${JSON.stringify(
          `${JSON.stringify({ tokenUsage: { input_tokens: 120, output_tokens: 80, total_tokens: 200 } })}\n`
        )});`
      ]
    });

    const analytics = (await routeRpcMethod("usage.analytics", {
      workspace_dir: dir
    })) as any;
    expect(analytics.totals.run_count).toBe(2);
    expect(analytics.totals.total_tokens).toBe(500);
    expect(analytics.totals.total_cost_usd).toBeGreaterThan(0);
    expect(analytics.by_provider.some((p: any) => p.provider === "cmd")).toBe(true);
    expect(Array.isArray(analytics.recent_runs)).toBe(true);
    expect(analytics.recent_runs.length).toBeGreaterThan(0);
  });
});
