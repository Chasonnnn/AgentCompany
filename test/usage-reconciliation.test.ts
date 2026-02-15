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

describe("usage reconciliation", () => {
  test("records billing statements and reconciles against internal usage totals", async () => {
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

    const { team_id } = await createTeam({ workspace_dir: dir, name: "Ops" });
    const { agent_id } = await createAgent({
      workspace_dir: dir,
      name: "Worker",
      role: "worker",
      provider: "cmd",
      team_id
    });
    const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });

    const run = await createRun({ workspace_dir: dir, project_id, agent_id, provider: "cmd" });
    await executeCommandRun({
      workspace_dir: dir,
      project_id,
      run_id: run.run_id,
      argv: [
        process.execPath,
        "-e",
        `process.stdout.write(${JSON.stringify(
          `${JSON.stringify({ usage: { prompt_tokens: 240, completion_tokens: 120, total_tokens: 360 } })}\n`
        )});`
      ]
    });

    const recorded = (await routeRpcMethod("usage.reconciliation.record", {
      workspace_dir: dir,
      provider: "cmd",
      period_start: "2026-01-01T00:00:00.000Z",
      period_end: "2026-12-31T23:59:59.999Z",
      billed_cost_usd: 0.0115,
      billed_tokens: 380,
      currency: "USD",
      source: "manual",
      external_ref: "invoice-cmd-2026-02"
    })) as any;
    expect(recorded.statement.provider).toBe("cmd");
    expect(recorded.statement.billed_tokens).toBe(380);

    const snapshot = (await routeRpcMethod("usage.reconciliation.snapshot", {
      workspace_dir: dir,
      period_start: "2026-01-01T00:00:00.000Z",
      period_end: "2026-12-31T23:59:59.999Z"
    })) as any;

    const cmd = snapshot.by_provider.find((row: any) => row.provider === "cmd");
    expect(cmd).toBeDefined();
    expect(cmd.internal_run_count).toBeGreaterThanOrEqual(1);
    expect(cmd.internal_tokens).toBe(360);
    expect(cmd.billed_tokens).toBe(380);
    expect(typeof cmd.token_delta).toBe("number");
    expect(typeof cmd.cost_delta_usd).toBe("number");
    expect(snapshot.totals.provider_count).toBeGreaterThanOrEqual(1);
    expect(snapshot.totals.billed_cost_usd).toBeGreaterThan(0);
  });
});
