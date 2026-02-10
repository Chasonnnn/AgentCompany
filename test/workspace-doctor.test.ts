import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { initWorkspace } from "../src/workspace/init.js";
import { doctorWorkspace } from "../src/workspace/doctor.js";
import { setProviderBin } from "../src/machine/machine.js";
import { createTeam } from "../src/org/teams.js";
import { createAgent } from "../src/org/agents.js";
import { createProject } from "../src/work/projects.js";
import { createRun } from "../src/runtime/run.js";

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-"));
}

describe("workspace doctor", () => {
  test("reports provider failure when no CLI adapters are available", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });

    await setProviderBin(dir, "codex", "/definitely-missing/codex");
    await setProviderBin(dir, "claude", "/definitely-missing/claude");

    const report = await doctorWorkspace({ workspace_dir: dir });
    const providers = report.checks.find((c) => c.id === "providers.cli");
    expect(providers?.status).toBe("fail");
    expect(report.ok).toBe(false);
  });

  test("rebuild-index mode warns on malformed event lines", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });

    await setProviderBin(dir, "codex", process.execPath);
    await setProviderBin(dir, "claude", process.execPath);

    const { team_id } = await createTeam({ workspace_dir: dir, name: "Payments" });
    const { agent_id } = await createAgent({
      workspace_dir: dir,
      name: "Worker",
      role: "worker",
      provider: "codex",
      team_id
    });
    const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });
    const { run_id } = await createRun({
      workspace_dir: dir,
      project_id,
      agent_id,
      provider: "codex"
    });
    const eventsPath = path.join(dir, "work/projects", project_id, "runs", run_id, "events.jsonl");
    await fs.appendFile(eventsPath, "{not-json}\n", { encoding: "utf8" });

    const report = await doctorWorkspace({ workspace_dir: dir, rebuild_index: true });
    const idx = report.checks.find((c) => c.id === "index.rebuild");
    expect(idx?.status).toBe("warn");
  });
});
