import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { initWorkspace } from "../src/workspace/init.js";
import { createTeam } from "../src/org/teams.js";
import { createAgent } from "../src/org/agents.js";
import { createProject } from "../src/work/projects.js";
import { createRun } from "../src/runtime/run.js";
import { createTaskFile, addTaskMilestone } from "../src/work/tasks.js";
import { proposeMemoryDelta } from "../src/memory/propose_memory_delta.js";
import { createMilestoneReportFile } from "../src/milestones/report_files.js";
import { buildReviewInboxSnapshot } from "../src/runtime/review_inbox.js";
import { resolveInboxItem } from "../src/inbox/resolve.js";
import { newId } from "../src/core/ids.js";
import { writeFileAtomic } from "../src/store/fs.js";
import { parseFrontMatter } from "../src/artifacts/frontmatter.js";
import { TaskFrontMatter } from "../src/work/task_markdown.js";

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-"));
}

async function readJsonl(filePath: string): Promise<any[]> {
  const s = await fs.readFile(filePath, { encoding: "utf8" });
  const lines = s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.map((l) => JSON.parse(l));
}

describe("inbox resolve", () => {
  test("denied memory delta keeps memory unchanged and resolves pending item", async () => {
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
    const director = await createAgent({
      workspace_dir: dir,
      name: "Director",
      role: "director",
      provider: "cmd",
      team_id
    });
    const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });
    const { run_id, context_pack_id } = await createRun({
      workspace_dir: dir,
      project_id,
      agent_id: mgr.agent_id,
      provider: "cmd"
    });

    const proposed = await proposeMemoryDelta({
      workspace_dir: dir,
      project_id,
      title: "Reject this for now",
      scope_kind: "project_memory",
      sensitivity: "internal",
      rationale: "Exercise denied path with governed approval metadata.",
      under_heading: "## Decisions",
      insert_lines: ["- This should not be merged when denied."],
      visibility: "managers",
      produced_by: mgr.agent_id,
      run_id,
      context_pack_id,
      evidence: ["art_evidence_inbox_denied"]
    });

    const memoryPath = path.join(dir, "work/projects", project_id, "memory.md");
    const before = await fs.readFile(memoryPath, { encoding: "utf8" });

    const pendingBefore = await buildReviewInboxSnapshot({
      workspace_dir: dir,
      project_id,
      refresh_index: true
    });
    expect(pendingBefore.pending.some((p) => p.artifact_id === proposed.artifact_id)).toBe(true);

    const resolved = await resolveInboxItem({
      workspace_dir: dir,
      project_id,
      artifact_id: proposed.artifact_id,
      decision: "denied",
      actor_id: director.agent_id,
      actor_role: "director",
      actor_team_id: team_id,
      notes: "Needs revision"
    });
    expect(resolved.decision).toBe("denied");
    expect(resolved.subject_kind).toBe("memory_delta");

    const after = await fs.readFile(memoryPath, { encoding: "utf8" });
    expect(after).toBe(before);

    const pendingAfter = await buildReviewInboxSnapshot({
      workspace_dir: dir,
      project_id,
      sync_index: true
    });
    expect(pendingAfter.pending.some((p) => p.artifact_id === proposed.artifact_id)).toBe(false);
    expect(
      pendingAfter.recent_decisions.some(
        (d) => d.subject_artifact_id === proposed.artifact_id && d.decision === "denied"
      )
    ).toBe(true);

    const eventsPath = path.join(dir, "work/projects", project_id, "runs", run_id, "events.jsonl");
    const evs = await readJsonl(eventsPath);
    expect(
      evs.some(
        (e) =>
          e.type === "approval.decided" &&
          e.payload?.decision === "denied" &&
          e.payload?.subject_kind === "memory_delta" &&
          e.payload?.artifact_id === proposed.artifact_id
      )
    ).toBe(true);
  });

  test("approved milestone updates task and resolves pending item", async () => {
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

    const pendingBefore = await buildReviewInboxSnapshot({
      workspace_dir: dir,
      project_id,
      refresh_index: true
    });
    expect(pendingBefore.pending.some((p) => p.artifact_id === report.artifact_id)).toBe(true);

    const resolved = await resolveInboxItem({
      workspace_dir: dir,
      project_id,
      artifact_id: report.artifact_id,
      decision: "approved",
      actor_id: mgr.agent_id,
      actor_role: "manager",
      actor_team_id: team_id,
      notes: "Looks good"
    });
    expect(resolved.decision).toBe("approved");
    expect(resolved.subject_kind).toBe("milestone");
    expect(resolved.milestone_status).toBe("done");

    const taskPath = path.join(dir, "work/projects", project_id, "tasks", `${task_id}.md`);
    const taskMd = await fs.readFile(taskPath, { encoding: "utf8" });
    const parsed = parseFrontMatter(taskMd);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const fm = TaskFrontMatter.parse(parsed.frontmatter);
    expect(fm.milestones.find((m) => m.id === ms.milestone_id)?.status).toBe("done");

    const pendingAfter = await buildReviewInboxSnapshot({
      workspace_dir: dir,
      project_id,
      sync_index: true
    });
    expect(pendingAfter.pending.some((p) => p.artifact_id === report.artifact_id)).toBe(false);
    expect(
      pendingAfter.recent_decisions.some(
        (d) => d.subject_artifact_id === report.artifact_id && d.decision === "approved"
      )
    ).toBe(true);
  });

  test("worker cannot resolve manager-level pending item", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const { team_id } = await createTeam({ workspace_dir: dir, name: "Payments" });
    const worker = await createAgent({
      workspace_dir: dir,
      name: "Worker",
      role: "worker",
      provider: "cmd",
      team_id
    });
    const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });
    const { run_id, context_pack_id } = await createRun({
      workspace_dir: dir,
      project_id,
      agent_id: worker.agent_id,
      provider: "cmd"
    });

    const proposed = await proposeMemoryDelta({
      workspace_dir: dir,
      project_id,
      title: "Blocked by policy",
      scope_kind: "project_memory",
      sensitivity: "internal",
      rationale: "Workers should not be allowed to resolve governed memory proposals.",
      under_heading: "## Decisions",
      insert_lines: ["- Should be denied by policy."],
      visibility: "managers",
      produced_by: worker.agent_id,
      run_id,
      context_pack_id,
      evidence: ["art_evidence_worker_denied"]
    });

    await expect(
      resolveInboxItem({
        workspace_dir: dir,
        project_id,
        artifact_id: proposed.artifact_id,
        decision: "denied",
        actor_id: worker.agent_id,
        actor_role: "worker",
        actor_team_id: team_id
      })
    ).rejects.toThrow(/Policy denied approval/);

    const eventsPath = path.join(dir, "work/projects", project_id, "runs", run_id, "events.jsonl");
    const evs = await readJsonl(eventsPath);
    expect(
      evs.some(
        (e) =>
          e.type === "policy.denied" &&
          e.payload?.action === "approve" &&
          e.payload?.resource_id === proposed.artifact_id
      )
    ).toBe(true);
  });

  test("deny path rejects secret-like notes before writing review/event", async () => {
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
    const director = await createAgent({
      workspace_dir: dir,
      name: "Director",
      role: "director",
      provider: "cmd",
      team_id
    });
    const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });
    const { run_id, context_pack_id } = await createRun({
      workspace_dir: dir,
      project_id,
      agent_id: manager.agent_id,
      provider: "cmd"
    });

    const proposed = await proposeMemoryDelta({
      workspace_dir: dir,
      project_id,
      title: "Reject with bad note",
      scope_kind: "project_memory",
      sensitivity: "internal",
      rationale: "Secret-like reviewer notes should block deny persistence.",
      under_heading: "## Decisions",
      insert_lines: ["- pending memory item for deny-note gate"],
      visibility: "managers",
      produced_by: manager.agent_id,
      run_id,
      context_pack_id,
      evidence: ["art_evidence_deny_note_gate"]
    });

    await expect(
      resolveInboxItem({
        workspace_dir: dir,
        project_id,
        artifact_id: proposed.artifact_id,
        decision: "denied",
        actor_id: director.agent_id,
        actor_role: "director",
        actor_team_id: team_id,
        notes: "Bad note with token sk-1234567890abcdefghijklmnopqrs"
      })
    ).rejects.toThrow(/sensitive|redact|secret/i);

    const reviewsDir = path.join(dir, "inbox/reviews");
    const reviewFiles = await fs.readdir(reviewsDir);
    expect(reviewFiles.some((f) => f.endsWith(".yaml"))).toBe(false);

    const pending = await buildReviewInboxSnapshot({
      workspace_dir: dir,
      project_id,
      sync_index: true
    });
    expect(pending.pending.some((p) => p.artifact_id === proposed.artifact_id)).toBe(true);

    const eventsPath = path.join(dir, "work/projects", project_id, "runs", run_id, "events.jsonl");
    const eventsRaw = await fs.readFile(eventsPath, { encoding: "utf8" });
    expect(eventsRaw).not.toContain('"type":"approval.decided"');
  });
});
