import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { initWorkspace } from "../src/workspace/init.js";
import { createTeam } from "../src/org/teams.js";
import { createAgent } from "../src/org/agents.js";
import { recordAgentMistake } from "../src/eval/mistake_loop.js";
import { createProject } from "../src/work/projects.js";
import { createRun } from "../src/runtime/run.js";

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-"));
}

async function readJsonl(filePath: string): Promise<any[]> {
  const s = await fs.readFile(filePath, { encoding: "utf8" });
  const lines = s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.map((l) => JSON.parse(l));
}

describe("self improvement loop", () => {
  test("does not directly promote repeated mistakes into worker AGENTS.md", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const { team_id } = await createTeam({ workspace_dir: dir, name: "Payments" });
    const manager = await createAgent({
      workspace_dir: dir,
      name: "Manager",
      role: "manager",
      provider: "cmd",
      team_id
    });
    const worker = await createAgent({
      workspace_dir: dir,
      name: "Worker",
      role: "worker",
      provider: "cmd",
      team_id
    });

    for (let i = 0; i < 2; i++) {
      const res = await recordAgentMistake({
        workspace_dir: dir,
        worker_agent_id: worker.agent_id,
        manager_actor_id: manager.agent_id,
        manager_role: "manager",
        mistake_key: "missing_tests_evidence",
        summary: "Submitted coding milestone without tests artifact",
        prevention_rule: "Always attach tests artifacts before requesting milestone approval."
      });
      expect(res.promoted_to_agents_md).toBe(false);
    }

    const agentsPath = path.join(dir, "org/agents", worker.agent_id, "AGENTS.md");
    let before = "";
    try {
      before = await fs.readFile(agentsPath, { encoding: "utf8" });
    } catch {
      before = "";
    }
    expect(before.includes("mistake:missing_tests_evidence")).toBe(false);

    const third = await recordAgentMistake({
      workspace_dir: dir,
      worker_agent_id: worker.agent_id,
      manager_actor_id: manager.agent_id,
      manager_role: "manager",
      mistake_key: "missing_tests_evidence",
      summary: "Submitted coding milestone without tests artifact",
      prevention_rule: "Always attach tests artifacts before requesting milestone approval."
    });
    expect(third.count).toBe(3);
    expect(third.promoted_to_agents_md).toBe(false);

    let after = "";
    try {
      after = await fs.readFile(agentsPath, { encoding: "utf8" });
    } catch {
      after = "";
    }
    expect(after.includes("mistake:missing_tests_evidence")).toBe(false);

    const logPath = path.join(dir, "org/agents", worker.agent_id, "mistakes.yaml");
    const log = await fs.readFile(logPath, { encoding: "utf8" });
    expect(log).toContain("missing_tests_evidence");
    expect(log).toContain("count: 3");
  });

  test("requires manager+ role and appends evaluation events when run is provided", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const { team_id } = await createTeam({ workspace_dir: dir, name: "Payments" });
    const manager = await createAgent({
      workspace_dir: dir,
      name: "Manager",
      role: "manager",
      provider: "cmd",
      team_id
    });
    const worker = await createAgent({
      workspace_dir: dir,
      name: "Worker",
      role: "worker",
      provider: "cmd",
      team_id
    });
    const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });
    const { run_id } = await createRun({
      workspace_dir: dir,
      project_id,
      agent_id: worker.agent_id,
      provider: "cmd"
    });

    await expect(
      recordAgentMistake({
        workspace_dir: dir,
        worker_agent_id: worker.agent_id,
        manager_actor_id: worker.agent_id,
        manager_role: "worker",
        mistake_key: "missing_patch_evidence",
        summary: "Submitted without patch",
        prevention_rule: "Always attach a patch artifact.",
        project_id,
        run_id
      })
    ).rejects.toThrow(/Only manager\+ roles/);

    await recordAgentMistake({
      workspace_dir: dir,
      worker_agent_id: worker.agent_id,
      manager_actor_id: manager.agent_id,
      manager_role: "manager",
      mistake_key: "missing_patch_evidence",
      summary: "Submitted without patch",
      prevention_rule: "Always attach a patch artifact.",
      project_id,
      run_id,
      promote_threshold: 1
    });

    const eventsPath = path.join(dir, "work/projects", project_id, "runs", run_id, "events.jsonl");
    const evs = await readJsonl(eventsPath);
    expect(evs.some((e) => e.type === "evaluation.mistake_recorded")).toBe(true);
    expect(evs.some((e) => e.type === "evaluation.rule_promoted")).toBe(false);
  });
});
