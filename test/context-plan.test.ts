import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { initWorkspace } from "../src/workspace/init.js";
import { createProject } from "../src/work/projects.js";
import { createTeam } from "../src/org/teams.js";
import { createAgent } from "../src/org/agents.js";
import { createRun } from "../src/runtime/run.js";
import { proposeMemoryDelta } from "../src/memory/propose_memory_delta.js";
import { approveMemoryDelta } from "../src/memory/approve_memory_delta.js";
import { planContextForJob } from "../src/runtime/context_plan.js";
import { newArtifactMarkdown } from "../src/artifacts/markdown.js";

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-context-plan-"));
}

describe("context plan generation", () => {
  test("is deterministic and includes approved L1 memory", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });
    const { team_id } = await createTeam({ workspace_dir: dir, name: "Platform" });
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
    const director = await createAgent({
      workspace_dir: dir,
      name: "Director",
      role: "director",
      provider: "cmd",
      team_id
    });
    const run = await createRun({
      workspace_dir: dir,
      project_id,
      agent_id: manager.agent_id,
      provider: "cmd"
    });

    const approvedDelta = await proposeMemoryDelta({
      workspace_dir: dir,
      project_id,
      title: "Approved memory",
      scope_kind: "project_memory",
      sensitivity: "internal",
      rationale: "Use approved memory in context plan.",
      under_heading: "## Decisions",
      insert_lines: ["- approved memory line"],
      visibility: "managers",
      produced_by: manager.agent_id,
      run_id: run.run_id,
      context_pack_id: run.context_pack_id,
      evidence: ["art_evidence_context_plan_approved"]
    });
    await approveMemoryDelta({
      workspace_dir: dir,
      project_id,
      artifact_id: approvedDelta.artifact_id,
      actor_id: director.agent_id,
      actor_role: "director",
      actor_team_id: team_id,
      notes: "approve for planner test"
    });

    const pendingDelta = await proposeMemoryDelta({
      workspace_dir: dir,
      project_id,
      title: "Pending memory",
      scope_kind: "project_memory",
      sensitivity: "internal",
      rationale: "Pending memory should not be included.",
      under_heading: "## Decisions",
      insert_lines: ["- pending memory line"],
      visibility: "managers",
      produced_by: manager.agent_id,
      run_id: run.run_id,
      context_pack_id: run.context_pack_id,
      evidence: ["art_evidence_context_plan_pending"]
    });

    const trajectory = newArtifactMarkdown({
      type: "manager_digest",
      title: "Trajectory digest",
      visibility: "managers",
      produced_by: manager.agent_id,
      run_id: run.run_id,
      context_pack_id: run.context_pack_id
    });
    await fs.writeFile(
      path.join(dir, "work/projects", project_id, "artifacts", "art_context_plan_digest.md"),
      trajectory,
      { encoding: "utf8" }
    );

    const first = await planContextForJob({
      workspace_dir: dir,
      project_id,
      worker_agent_id: worker.agent_id,
      manager_actor_id: manager.agent_id,
      manager_role: "manager",
      manager_team_id: team_id,
      goal: "Plan context for deterministic test",
      constraints: ["no policy bypass"],
      deliverables: ["refs"],
      context_refs: [{ kind: "note", value: "seed-note" }],
      max_refs: 40
    });
    const second = await planContextForJob({
      workspace_dir: dir,
      project_id,
      worker_agent_id: worker.agent_id,
      manager_actor_id: manager.agent_id,
      manager_role: "manager",
      manager_team_id: team_id,
      goal: "Plan context for deterministic test",
      constraints: ["no policy bypass"],
      deliverables: ["refs"],
      context_refs: [{ kind: "note", value: "seed-note" }],
      max_refs: 40
    });

    expect(first.context_refs).toEqual(second.context_refs);
    expect(first.retrieval_trace).toEqual(second.retrieval_trace);
    expect(first.layers_used).toContain("L0");
    expect(first.layers_used).toContain("L1");
    const includedMemory = first.context_refs
      .filter((r) => r.kind === "artifact")
      .map((r) => r.value);
    expect(includedMemory).toContain(approvedDelta.artifact_id);
    expect(includedMemory).not.toContain(pendingDelta.artifact_id);
  });
});

