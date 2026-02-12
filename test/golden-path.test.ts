import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { initWorkspace } from "../src/workspace/init.js";
import { createTeam } from "../src/org/teams.js";
import { createAgent } from "../src/org/agents.js";
import { createProject } from "../src/work/projects.js";
import { createTaskFile, addTaskMilestone } from "../src/work/tasks.js";
import { createRun } from "../src/runtime/run.js";
import { createMilestoneReportFile } from "../src/milestones/report_files.js";
import { approveMilestone } from "../src/milestones/approve_milestone.js";
import { newId } from "../src/core/ids.js";
import { writeFileAtomic } from "../src/store/fs.js";
import { parseFrontMatter } from "../src/artifacts/frontmatter.js";
import { TaskFrontMatter } from "../src/work/task_markdown.js";
import { readYamlFile, writeYamlFile } from "../src/store/yaml.js";
import { executeCommandRun } from "../src/runtime/execute_command.js";
import { buildRunMonitorSnapshot } from "../src/runtime/run_monitor.js";
import { readArtifactWithPolicy } from "../src/artifacts/read_artifact.js";
import { newArtifactMarkdown } from "../src/artifacts/markdown.js";
import { createSharePack } from "../src/share/share_pack.js";
import { replaySharePack } from "../src/share/replay.js";
import { createHelpRequestFile } from "../src/help/help_request_files.js";

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-"));
}

describe("golden paths", () => {
  test("task -> run -> milestone approval closes coding task", async () => {
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

    const { task_id } = await createTaskFile({
      workspace_dir: dir,
      project_id,
      title: "Implement golden path feature",
      visibility: "team",
      team_id,
      assignee_agent_id: worker.agent_id
    });
    const milestone = await addTaskMilestone({
      workspace_dir: dir,
      project_id,
      task_id,
      milestone: {
        title: "Coding milestone",
        kind: "coding",
        status: "ready",
        acceptance_criteria: ["Patch and tests artifacts are attached"]
      }
    });

    const run = await createRun({
      workspace_dir: dir,
      project_id,
      agent_id: worker.agent_id,
      provider: "cmd"
    });

    const artifactsDir = path.join(dir, "work/projects", project_id, "artifacts");
    const patchId = newId("art");
    await writeFileAtomic(
      path.join(artifactsDir, `${patchId}.patch`),
      "diff --git a/a.txt b/a.txt\nindex 0000000..1111111 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -0,0 +1 @@\n+hello\n"
    );
    const testsId = newId("art");
    await writeFileAtomic(path.join(artifactsDir, `${testsId}.txt`), "PASS\n");

    const report = await createMilestoneReportFile(dir, {
      title: "Milestone report",
      visibility: "team",
      produced_by: worker.agent_id,
      run_id: run.run_id,
      context_pack_id: run.context_pack_id,
      project_id,
      task_id,
      milestone_id: milestone.milestone_id,
      evidence_artifacts: [patchId],
      tests_artifacts: [testsId]
    });

    const decision = await approveMilestone({
      workspace_dir: dir,
      project_id,
      task_id,
      milestone_id: milestone.milestone_id,
      report_artifact_id: report.artifact_id,
      actor_id: manager.agent_id,
      actor_role: "manager"
    });
    expect(decision.decision).toBe("approved");

    const taskPath = path.join(dir, "work/projects", project_id, "tasks", `${task_id}.md`);
    const taskMd = await fs.readFile(taskPath, { encoding: "utf8" });
    const parsed = parseFrontMatter(taskMd);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const fm = TaskFrontMatter.parse(parsed.frontmatter);
    expect(fm.status).toBe("done");
    expect(fm.milestones.find((m) => m.id === milestone.milestone_id)?.status).toBe("done");
  });

  test("budget exceeded path is surfaced in run monitor explainability counters", async () => {
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
      budget: { soft_cost_usd: 0.005, hard_cost_usd: 0.01 }
    });

    const { task_id } = await createTaskFile({
      workspace_dir: dir,
      project_id,
      title: "Budgeted task",
      visibility: "team",
      assignee_agent_id: agent_id
    });

    const run = await createRun({
      workspace_dir: dir,
      project_id,
      agent_id,
      provider: "cmd"
    });
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
      run_id: run.run_id,
      task_id,
      argv: [process.execPath, "-e", `process.stdout.write(${JSON.stringify(`${usageLine}\n`)});`]
    });

    const monitor = await buildRunMonitorSnapshot({
      workspace_dir: dir,
      project_id,
      refresh_index: true
    });
    const row = monitor.rows.find((r) => r.run_id === run.run_id);
    expect(row).toBeDefined();
    expect(row?.run_status).toBe("failed");
    expect((row?.budget_decision_count ?? 0) > 0).toBe(true);
    expect((row?.budget_exceeded_count ?? 0) > 0).toBe(true);
  });

  test("policy denied path can escalate via share pack + help request without leaking private events", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const { team_id: teamA } = await createTeam({ workspace_dir: dir, name: "Payments" });
    const { team_id: teamB } = await createTeam({ workspace_dir: dir, name: "Growth" });

    const { agent_id: workerA } = await createAgent({
      workspace_dir: dir,
      name: "Payments Worker",
      role: "worker",
      provider: "codex",
      team_id: teamA
    });
    const { agent_id: workerB } = await createAgent({
      workspace_dir: dir,
      name: "Growth Worker",
      role: "worker",
      provider: "codex",
      team_id: teamB
    });

    const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });
    const producerRun = await createRun({
      workspace_dir: dir,
      project_id,
      agent_id: workerA,
      provider: "codex"
    });
    const readerRun = await createRun({
      workspace_dir: dir,
      project_id,
      agent_id: workerB,
      provider: "codex"
    });

    const artifactId = "art_policy_escalation";
    const md = newArtifactMarkdown({
      type: "proposal",
      id: artifactId,
      title: "Managers-only proposal",
      visibility: "managers",
      produced_by: workerA,
      run_id: producerRun.run_id,
      context_pack_id: producerRun.context_pack_id
    });
    await writeFileAtomic(path.join(dir, "work/projects", project_id, "artifacts", `${artifactId}.md`), md);
    await fs.appendFile(
      path.join(dir, "work/projects", project_id, "runs", producerRun.run_id, "events.jsonl"),
      `${JSON.stringify({
        schema_version: 1,
        ts_wallclock: new Date().toISOString(),
        ts_monotonic_ms: 1,
        run_id: producerRun.run_id,
        session_ref: `local_${producerRun.run_id}`,
        actor: workerA,
        visibility: "private_agent",
        type: "provider.raw",
        payload: { chunk: "private secret token: sk-123456789012345678901234567890" }
      })}\n`,
      { encoding: "utf8" }
    );
    await fs.appendFile(
      path.join(dir, "work/projects", project_id, "runs", producerRun.run_id, "events.jsonl"),
      `${JSON.stringify({
        schema_version: 1,
        ts_wallclock: new Date().toISOString(),
        ts_monotonic_ms: 2,
        run_id: producerRun.run_id,
        session_ref: `local_${producerRun.run_id}`,
        actor: workerA,
        visibility: "managers",
        type: "run.note",
        payload: { text: "safe summary" }
      })}\n`,
      { encoding: "utf8" }
    );

    await expect(
      readArtifactWithPolicy({
        workspace_dir: dir,
        project_id,
        artifact_id: artifactId,
        actor_id: workerB,
        actor_role: "worker",
        actor_team_id: teamB,
        run_id: readerRun.run_id
      })
    ).rejects.toThrow(/Policy denied read/);

    const share = await createSharePack({
      workspace_dir: dir,
      project_id,
      created_by: "human"
    });
    const replay = await replaySharePack({
      workspace_dir: dir,
      project_id,
      share_pack_id: share.share_pack_id,
      run_id: producerRun.run_id
    });
    expect(replay.runs).toHaveLength(1);
    const replayJson = JSON.stringify(replay.runs[0].events);
    expect(replayJson.includes("private secret token")).toBe(false);
    expect(replayJson.includes("safe summary")).toBe(true);

    const help = await createHelpRequestFile(dir, {
      title: "Need manager clarification on denied artifact access",
      visibility: "managers",
      requester: workerB,
      target_manager: "agent_mgr_payments",
      project_id,
      share_pack_id: share.share_pack_id
    });
    const helpMd = await fs.readFile(help.file_path, { encoding: "utf8" });
    expect(helpMd.includes(share.share_pack_id)).toBe(true);
  });
});
