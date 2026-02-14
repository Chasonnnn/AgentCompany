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

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-context-policy-"));
}

describe("context plan policy + sensitivity filtering", () => {
  test("filters cross-team + restricted context for non-director actors", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });
    const { team_id: teamA } = await createTeam({ workspace_dir: dir, name: "Team A" });
    const { team_id: teamB } = await createTeam({ workspace_dir: dir, name: "Team B" });

    const managerA = await createAgent({
      workspace_dir: dir,
      name: "Manager A",
      role: "manager",
      provider: "cmd",
      team_id: teamA
    });
    const workerA = await createAgent({
      workspace_dir: dir,
      name: "Worker A",
      role: "worker",
      provider: "cmd",
      team_id: teamA
    });
    const workerB = await createAgent({
      workspace_dir: dir,
      name: "Worker B",
      role: "worker",
      provider: "cmd",
      team_id: teamB
    });
    const director = await createAgent({
      workspace_dir: dir,
      name: "Director",
      role: "director",
      provider: "cmd",
      team_id: teamA
    });

    const run = await createRun({
      workspace_dir: dir,
      project_id,
      agent_id: managerA.agent_id,
      provider: "cmd"
    });

    const teamDelta = await proposeMemoryDelta({
      workspace_dir: dir,
      project_id,
      title: "Team-only memory",
      scope_kind: "project_memory",
      sensitivity: "internal",
      rationale: "Same-team workers should see this context candidate.",
      under_heading: "## Decisions",
      insert_lines: ["- team internal memory"],
      visibility: "team",
      produced_by: managerA.agent_id,
      run_id: run.run_id,
      context_pack_id: run.context_pack_id,
      evidence: ["art_evidence_team_context"]
    });
    await approveMemoryDelta({
      workspace_dir: dir,
      project_id,
      artifact_id: teamDelta.artifact_id,
      actor_id: director.agent_id,
      actor_role: "director",
      actor_team_id: teamA
    });

    const restrictedDelta = await proposeMemoryDelta({
      workspace_dir: dir,
      project_id,
      title: "Restricted memory",
      scope_kind: "project_memory",
      sensitivity: "restricted",
      rationale: "Restricted context requires director+ role to compose.",
      under_heading: "## Decisions",
      insert_lines: ["- restricted planning note"],
      visibility: "managers",
      produced_by: managerA.agent_id,
      run_id: run.run_id,
      context_pack_id: run.context_pack_id,
      evidence: ["art_evidence_restricted_context"]
    });
    await approveMemoryDelta({
      workspace_dir: dir,
      project_id,
      artifact_id: restrictedDelta.artifact_id,
      actor_id: director.agent_id,
      actor_role: "director",
      actor_team_id: teamA
    });

    const workerAPlan = await planContextForJob({
      workspace_dir: dir,
      project_id,
      worker_agent_id: workerA.agent_id,
      manager_actor_id: workerA.agent_id,
      manager_role: "worker",
      manager_team_id: teamA,
      goal: "worker A plan"
    });
    expect(workerAPlan.context_refs.some((r) => r.value === teamDelta.artifact_id)).toBe(true);
    expect(workerAPlan.context_refs.some((r) => r.value === restrictedDelta.artifact_id)).toBe(false);
    expect(workerAPlan.filtered_by_sensitivity_count).toBeGreaterThanOrEqual(1);

    const workerBPlan = await planContextForJob({
      workspace_dir: dir,
      project_id,
      worker_agent_id: workerB.agent_id,
      manager_actor_id: workerB.agent_id,
      manager_role: "worker",
      manager_team_id: teamB,
      goal: "worker B plan"
    });
    expect(workerBPlan.context_refs.some((r) => r.value === teamDelta.artifact_id)).toBe(false);
    expect(workerBPlan.filtered_by_policy_count).toBeGreaterThanOrEqual(1);

    const directorPlan = await planContextForJob({
      workspace_dir: dir,
      project_id,
      worker_agent_id: workerA.agent_id,
      manager_actor_id: director.agent_id,
      manager_role: "director",
      manager_team_id: teamA,
      goal: "director plan"
    });
    expect(directorPlan.context_refs.some((r) => r.value === restrictedDelta.artifact_id)).toBe(true);
  }, 20_000);
});

