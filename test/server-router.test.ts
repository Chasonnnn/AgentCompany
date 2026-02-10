import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { initWorkspace } from "../src/workspace/init.js";
import { createTeam } from "../src/org/teams.js";
import { createAgent } from "../src/org/agents.js";
import { createProject } from "../src/work/projects.js";
import { routeRpcMethod } from "../src/server/router.js";

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-"));
}

describe("server router", () => {
  test("workspace.open and run.create/run.list route to core modules", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });

    const opened = await routeRpcMethod("workspace.open", { workspace_dir: dir });
    expect((opened as any).workspace_dir).toBe(dir);
    expect((opened as any).valid).toBe(true);

    const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });
    const { team_id } = await createTeam({ workspace_dir: dir, name: "Payments" });
    const { agent_id } = await createAgent({
      workspace_dir: dir,
      name: "Worker",
      role: "worker",
      provider: "cmd",
      team_id
    });

    const run = (await routeRpcMethod("run.create", {
      workspace_dir: dir,
      project_id,
      agent_id,
      provider: "cmd"
    })) as any;
    expect(typeof run.run_id).toBe("string");
    expect(run.run_id.startsWith("run_")).toBe(true);

    const runs = (await routeRpcMethod("run.list", {
      workspace_dir: dir,
      project_id
    })) as any[];
    expect(runs.some((r) => r.run_id === run.run_id)).toBe(true);
  });

  test("adapter.status returns codex/claude adapter states", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const adapters = (await routeRpcMethod("adapter.status", {
      workspace_dir: dir
    })) as any[];
    const names = adapters.map((a) => a.name);
    expect(names).toContain("codex_app_server");
    expect(names).toContain("codex_cli");
    expect(names).toContain("claude_cli");
  });
});
