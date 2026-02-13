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
import { proposeMemoryDelta } from "../src/memory/propose_memory_delta.js";
import { approveMemoryDelta } from "../src/memory/approve_memory_delta.js";
import {
  rebuildSqliteIndex,
  syncSqliteIndex,
  listIndexedArtifacts,
  listIndexedPendingApprovals,
  listIndexedReviewDecisions,
  readIndexStats
} from "../src/index/sqlite.js";

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-"));
}

describe("sqlite index artifact projections", () => {
  test("indexes artifacts and supports pending approvals + decision lookups", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });

    const { team_id } = await createTeam({ workspace_dir: dir, name: "Payments" });
    const { agent_id: workerId } = await createAgent({
      workspace_dir: dir,
      name: "Worker",
      role: "worker",
      provider: "codex",
      team_id
    });
    const { agent_id: managerId } = await createAgent({
      workspace_dir: dir,
      name: "Manager",
      role: "manager",
      provider: "codex",
      team_id
    });
    const { agent_id: directorId } = await createAgent({
      workspace_dir: dir,
      name: "Director",
      role: "director",
      provider: "codex",
      team_id
    });

    const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });
    const run = await createRun({
      workspace_dir: dir,
      project_id,
      agent_id: workerId,
      provider: "codex"
    });
    await executeCommandRun({
      workspace_dir: dir,
      project_id,
      run_id: run.run_id,
      argv: [process.execPath, "-e", "console.log('artifact-index')"]
    });

    const delta = await proposeMemoryDelta({
      workspace_dir: dir,
      project_id,
      title: "Capture decision",
      scope_kind: "project_memory",
      sensitivity: "internal",
      rationale: "Index should surface governed memory decisions.",
      under_heading: "## Decisions",
      insert_lines: ["- Keep review decisions indexed."],
      visibility: "managers",
      produced_by: managerId,
      run_id: run.run_id,
      context_pack_id: run.context_pack_id,
      evidence: ["art_evidence_index_memory"]
    });

    await rebuildSqliteIndex(dir);

    const artifacts = await listIndexedArtifacts({
      workspace_dir: dir,
      project_id,
      artifact_id: delta.artifact_id,
      limit: 10
    });
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.type).toBe("memory_delta");
    expect(artifacts[0]?.run_id).toBe(run.run_id);

    const pendingBefore = await listIndexedPendingApprovals({
      workspace_dir: dir,
      project_id,
      limit: 50
    });
    expect(pendingBefore.some((p) => p.artifact_id === delta.artifact_id)).toBe(true);

    await approveMemoryDelta({
      workspace_dir: dir,
      project_id,
      artifact_id: delta.artifact_id,
      actor_id: directorId,
      actor_role: "director",
      actor_team_id: team_id,
      notes: "approved"
    });

    await syncSqliteIndex(dir);

    const pendingAfter = await listIndexedPendingApprovals({
      workspace_dir: dir,
      project_id,
      limit: 50
    });
    expect(pendingAfter.some((p) => p.artifact_id === delta.artifact_id)).toBe(false);

    const decisions = await listIndexedReviewDecisions({
      workspace_dir: dir,
      project_id,
      limit: 50
    });
    const decision = decisions.find((d) => d.subject_artifact_id === delta.artifact_id);
    expect(decision).toBeDefined();
    expect(decision?.decision).toBe("approved");
    expect(decision?.artifact_type).toBe("memory_delta");
    expect(decision?.artifact_run_id).toBe(run.run_id);

    const stats = await readIndexStats(dir);
    expect(stats.artifacts).toBeGreaterThanOrEqual(1);
  });

  test("sync removes deleted artifacts from the index", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });

    const { team_id } = await createTeam({ workspace_dir: dir, name: "Payments" });
    const { agent_id: workerId } = await createAgent({
      workspace_dir: dir,
      name: "Worker",
      role: "worker",
      provider: "codex",
      team_id
    });
    const { agent_id: managerId } = await createAgent({
      workspace_dir: dir,
      name: "Manager",
      role: "manager",
      provider: "codex",
      team_id
    });

    const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });
    const run = await createRun({
      workspace_dir: dir,
      project_id,
      agent_id: workerId,
      provider: "codex"
    });

    const delta = await proposeMemoryDelta({
      workspace_dir: dir,
      project_id,
      title: "Delete me",
      scope_kind: "project_memory",
      sensitivity: "internal",
      rationale: "Temporary memory artifact for index deletion behavior.",
      under_heading: "## Decisions",
      insert_lines: ["- Temporary memory delta artifact."],
      visibility: "managers",
      produced_by: managerId,
      run_id: run.run_id,
      context_pack_id: run.context_pack_id,
      evidence: ["art_evidence_delete_behavior"]
    });

    await rebuildSqliteIndex(dir);

    await fs.rm(path.join(dir, delta.artifact_relpath), { force: true });

    const sync = await syncSqliteIndex(dir);
    expect(sync.artifacts_deleted).toBeGreaterThanOrEqual(1);

    const artifacts = await listIndexedArtifacts({
      workspace_dir: dir,
      project_id,
      artifact_id: delta.artifact_id,
      limit: 10
    });
    expect(artifacts).toHaveLength(0);
  });
});
