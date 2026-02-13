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
import { listMemoryDeltas } from "../src/memory/list_memory_deltas.js";

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-"));
}

describe("memory.list_deltas policy filtering", () => {
  test("filters rows by actor read policy and reports filtered count", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });
    const { team_id: teamA } = await createTeam({ workspace_dir: dir, name: "Payments A" });
    const { team_id: teamB } = await createTeam({ workspace_dir: dir, name: "Payments B" });

    const managerA = await createAgent({
      workspace_dir: dir,
      name: "Manager A",
      role: "manager",
      provider: "cmd",
      team_id: teamA
    });
    const managerB = await createAgent({
      workspace_dir: dir,
      name: "Manager B",
      role: "manager",
      provider: "cmd",
      team_id: teamB
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

    const runA = await createRun({
      workspace_dir: dir,
      project_id,
      agent_id: managerA.agent_id,
      provider: "cmd"
    });
    const runWorkerA = await createRun({
      workspace_dir: dir,
      project_id,
      agent_id: workerA.agent_id,
      provider: "cmd"
    });

    const teamDelta = await proposeMemoryDelta({
      workspace_dir: dir,
      project_id,
      title: "Team memory",
      scope_kind: "project_memory",
      sensitivity: "internal",
      rationale: "Team-visible memory should be readable by same-team workers.",
      under_heading: "## Decisions",
      insert_lines: ["- team-visible memory item"],
      visibility: "team",
      produced_by: managerA.agent_id,
      run_id: runA.run_id,
      context_pack_id: runA.context_pack_id,
      evidence: ["art_evidence_team"]
    });
    const managersDelta = await proposeMemoryDelta({
      workspace_dir: dir,
      project_id,
      title: "Managers memory",
      scope_kind: "project_memory",
      sensitivity: "internal",
      rationale: "Manager-visible memory for governance review.",
      under_heading: "## Decisions",
      insert_lines: ["- managers-visible memory item"],
      visibility: "managers",
      produced_by: managerA.agent_id,
      run_id: runA.run_id,
      context_pack_id: runA.context_pack_id,
      evidence: ["art_evidence_managers"]
    });
    const privateDelta = await proposeMemoryDelta({
      workspace_dir: dir,
      project_id,
      title: "Private worker memory",
      scope_kind: "project_memory",
      sensitivity: "internal",
      rationale: "Private memory should only be readable by owner/human.",
      under_heading: "## Decisions",
      insert_lines: ["- private memory item"],
      visibility: "private_agent",
      produced_by: workerA.agent_id,
      run_id: runWorkerA.run_id,
      context_pack_id: runWorkerA.context_pack_id,
      evidence: ["art_evidence_private"]
    });

    const workerASnapshot = await listMemoryDeltas({
      workspace_dir: dir,
      project_id,
      actor_id: workerA.agent_id,
      actor_role: "worker",
      actor_team_id: teamA,
      status: "all",
      limit: 50
    });
    const workerAIds = new Set(workerASnapshot.items.map((i) => i.artifact_id));
    expect(workerAIds.has(teamDelta.artifact_id)).toBe(true);
    expect(workerAIds.has(privateDelta.artifact_id)).toBe(true);
    expect(workerAIds.has(managersDelta.artifact_id)).toBe(false);
    expect(workerASnapshot.filtered_by_policy_count).toBeGreaterThanOrEqual(1);

    const workerBSnapshot = await listMemoryDeltas({
      workspace_dir: dir,
      project_id,
      actor_id: workerB.agent_id,
      actor_role: "worker",
      actor_team_id: teamB,
      status: "all",
      limit: 50
    });
    expect(workerBSnapshot.items).toHaveLength(0);
    expect(workerBSnapshot.filtered_by_policy_count).toBeGreaterThanOrEqual(3);

    const managerBSnapshot = await listMemoryDeltas({
      workspace_dir: dir,
      project_id,
      actor_id: managerB.agent_id,
      actor_role: "manager",
      actor_team_id: teamB,
      status: "all",
      limit: 50
    });
    const managerBIds = new Set(managerBSnapshot.items.map((i) => i.artifact_id));
    expect(managerBIds.has(teamDelta.artifact_id)).toBe(true);
    expect(managerBIds.has(managersDelta.artifact_id)).toBe(true);
    expect(managerBIds.has(privateDelta.artifact_id)).toBe(false);
    expect(managerBSnapshot.filtered_by_policy_count).toBeGreaterThanOrEqual(1);

    const directorSnapshot = await listMemoryDeltas({
      workspace_dir: dir,
      project_id,
      actor_id: director.agent_id,
      actor_role: "director",
      actor_team_id: teamA,
      status: "all",
      limit: 50
    });
    const directorIds = new Set(directorSnapshot.items.map((i) => i.artifact_id));
    expect(directorIds.has(teamDelta.artifact_id)).toBe(true);
    expect(directorIds.has(managersDelta.artifact_id)).toBe(true);
    expect(directorIds.has(privateDelta.artifact_id)).toBe(false);

    const humanSnapshot = await listMemoryDeltas({
      workspace_dir: dir,
      project_id,
      actor_id: "human",
      actor_role: "human",
      status: "all",
      limit: 50
    });
    const humanIds = new Set(humanSnapshot.items.map((i) => i.artifact_id));
    expect(humanIds.has(teamDelta.artifact_id)).toBe(true);
    expect(humanIds.has(managersDelta.artifact_id)).toBe(true);
    expect(humanIds.has(privateDelta.artifact_id)).toBe(true);
    expect(humanSnapshot.filtered_by_policy_count).toBe(0);
  }, 20_000);
});
