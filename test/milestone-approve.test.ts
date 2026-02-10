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

async function mkTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-"));
  return dir;
}

async function readJsonl(filePath: string): Promise<any[]> {
  const s = await fs.readFile(filePath, { encoding: "utf8" });
  const lines = s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.map((l) => JSON.parse(l));
}

describe("milestone approval", () => {
  test("approves coding milestone when patch+tests evidence exist; updates task + writes review + event", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const { team_id } = await createTeam({ workspace_dir: dir, name: "Payments" });
    const mgr = await createAgent({
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
      title: "Implement feature",
      visibility: "team",
      team_id,
      assignee_agent_id: worker.agent_id
    });
    const ms = await addTaskMilestone({
      workspace_dir: dir,
      project_id,
      task_id,
      milestone: {
        title: "Do the thing",
        kind: "coding",
        status: "ready",
        acceptance_criteria: ["Changes landed and tests pass"]
      }
    });

    const { run_id, context_pack_id } = await createRun({
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
      run_id,
      context_pack_id,
      project_id,
      task_id,
      milestone_id: ms.milestone_id,
      evidence_artifacts: [patchId],
      tests_artifacts: [testsId]
    });

    const approved = await approveMilestone({
      workspace_dir: dir,
      project_id,
      task_id,
      milestone_id: ms.milestone_id,
      report_artifact_id: report.artifact_id,
      actor_id: mgr.agent_id,
      actor_role: "manager",
      notes: "LGTM"
    });
    expect(approved.decision).toBe("approved");
    expect(approved.milestone_status).toBe("done");

    const taskPath = path.join(dir, "work/projects", project_id, "tasks", `${task_id}.md`);
    const taskMd = await fs.readFile(taskPath, { encoding: "utf8" });
    const parsed = parseFrontMatter(taskMd);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const fm = TaskFrontMatter.parse(parsed.frontmatter);
    expect(fm.status).toBe("done");
    expect(fm.milestones.find((m) => m.id === ms.milestone_id)?.status).toBe("done");

    const reviewsDir = path.join(dir, "inbox/reviews");
    const reviewFiles = await fs.readdir(reviewsDir);
    expect(reviewFiles.some((f) => f.endsWith(".yaml"))).toBe(true);

    const eventsPath = path.join(dir, "work/projects", project_id, "runs", run_id, "events.jsonl");
    const evs = await readJsonl(eventsPath);
    expect(evs.some((e) => e.type === "approval.decided")).toBe(true);
  });
});

