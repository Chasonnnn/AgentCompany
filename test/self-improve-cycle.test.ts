import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { initWorkspace } from "../src/workspace/init.js";
import { createTeam } from "../src/org/teams.js";
import { createAgent } from "../src/org/agents.js";
import { createProject } from "../src/work/projects.js";
import { buildReviewInboxSnapshot } from "../src/runtime/review_inbox.js";
import { parseMemoryDeltaMarkdown } from "../src/memory/memory_delta.js";
import { runSelfImproveCycle } from "../src/eval/self_improve_cycle.js";
import { readYamlFile } from "../src/store/yaml.js";
import { RunYaml } from "../src/schemas/run.js";

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-"));
}

describe("self improve cycle", () => {
  test("records first repeat and then creates a governed AGENTS.md memory delta proposal", async () => {
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

    const first = await runSelfImproveCycle({
      workspace_dir: dir,
      project_id,
      worker_agent_id: worker.agent_id,
      manager_actor_id: manager.agent_id,
      manager_role: "manager",
      mistake_key: "missing_tests_evidence",
      summary: "Missing tests evidence in milestone report",
      prevention_rule: "Always attach tests artifact links before requesting approval.",
      proposal_threshold: 2
    });
    expect(first.status).toBe("recorded_only");
    expect(first.mistake_count).toBe(1);
    expect(first.memory_delta_artifact_id).toBeUndefined();

    const second = await runSelfImproveCycle({
      workspace_dir: dir,
      project_id,
      worker_agent_id: worker.agent_id,
      manager_actor_id: manager.agent_id,
      manager_role: "manager",
      mistake_key: "missing_tests_evidence",
      summary: "Missing tests evidence in milestone report",
      prevention_rule: "Always attach tests artifact links before requesting approval.",
      proposal_threshold: 2
    });

    expect(second.status).toBe("proposal_created");
    expect(second.mistake_count).toBe(2);
    expect(second.run_id?.startsWith("run_")).toBe(true);
    expect(second.evaluation_artifact_id?.startsWith("art_")).toBe(true);
    expect(second.memory_delta_artifact_id?.startsWith("art_")).toBe(true);

    const runDoc = RunYaml.parse(
      await readYamlFile(path.join(dir, "work/projects", project_id, "runs", second.run_id!, "run.yaml"))
    );
    expect(runDoc.status).toBe("ended");

    const mdAbs = path.join(
      dir,
      "work/projects",
      project_id,
      "artifacts",
      `${second.memory_delta_artifact_id}.md`
    );
    const parsed = parseMemoryDeltaMarkdown(await fs.readFile(mdAbs, { encoding: "utf8" }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.frontmatter.target_file).toBe(path.join("org/agents", worker.agent_id, "AGENTS.md"));
    }

    const inbox = await buildReviewInboxSnapshot({ workspace_dir: dir, project_id, refresh_index: true });
    expect(inbox.pending.some((p) => p.artifact_id === second.memory_delta_artifact_id)).toBe(true);
  });

  test("blocks proposal creation when evaluation command fails", async () => {
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

    const res = await runSelfImproveCycle({
      workspace_dir: dir,
      project_id,
      worker_agent_id: worker.agent_id,
      manager_actor_id: manager.agent_id,
      manager_role: "manager",
      mistake_key: "missing_patch_evidence",
      summary: "No patch attached for coding milestone",
      prevention_rule: "Always attach a patch artifact id in the report.",
      proposal_threshold: 1,
      evaluation_argv: [process.execPath, "-e", "process.exit(7)"]
    });

    expect(res.status).toBe("evaluation_failed");
    expect(res.run_id?.startsWith("run_")).toBe(true);
    expect(res.evaluation_artifact_type).toBe("failure_report");
    expect(res.memory_delta_artifact_id).toBeUndefined();

    const inbox = await buildReviewInboxSnapshot({ workspace_dir: dir, project_id, refresh_index: true });
    expect(inbox.pending.length).toBe(0);
  });
});

