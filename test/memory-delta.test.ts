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

describe("memory deltas", () => {
  test("director can approve and apply memory delta", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const { team_id } = await createTeam({ workspace_dir: dir, name: "Payments" });
    const { agent_id } = await createAgent({
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
      agent_id,
      provider: "cmd"
    });

    const memoryPath = path.join(dir, "work/projects", project_id, "memory.md");
    const before = await fs.readFile(memoryPath, { encoding: "utf8" });
    expect(before).toContain("## Decisions");

    const proposed = await proposeMemoryDelta({
      workspace_dir: dir,
      project_id,
      title: "Add decision about event envelope",
      scope_kind: "project_memory",
      sensitivity: "internal",
      rationale: "Record a durable event-envelope decision with run evidence.",
      under_heading: "## Decisions",
      insert_lines: ["- Events are strict-envelope JSONL and append-only."],
      visibility: "managers",
      produced_by: agent_id,
      run_id,
      context_pack_id,
      evidence: ["art_evidence_event_envelope"]
    });

    await fs.access(path.join(dir, proposed.patch_relpath));
    await fs.access(path.join(dir, proposed.artifact_relpath));

    const approved = await approveMemoryDelta({
      workspace_dir: dir,
      project_id,
      artifact_id: proposed.artifact_id,
      actor_id: agent_id,
      actor_role: "director",
      notes: "LGTM"
    });
    expect(approved.decision).toBe("approved");

    const after = await fs.readFile(memoryPath, { encoding: "utf8" });
    expect(after).toContain("Events are strict-envelope JSONL and append-only.");

    const reviewsDir = path.join(dir, "inbox/reviews");
    const reviewFiles = await fs.readdir(reviewsDir);
    expect(reviewFiles.some((f) => f.endsWith(".yaml"))).toBe(true);

    const eventsPath = path.join(dir, "work/projects", project_id, "runs", run_id, "events.jsonl");
    const evs = await readJsonl(eventsPath);
    expect(evs.some((e) => e.type === "approval.decided")).toBe(true);
  });

  test("manager cannot approve memory delta", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });
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

    const { run_id, context_pack_id } = await createRun({
      workspace_dir: dir,
      project_id,
      agent_id: director.agent_id,
      provider: "cmd"
    });

    const proposed = await proposeMemoryDelta({
      workspace_dir: dir,
      project_id,
      title: "Add decision",
      scope_kind: "project_memory",
      sensitivity: "internal",
      rationale: "Manager-proposed change should still require director approval.",
      under_heading: "## Decisions",
      insert_lines: ["- Managers should not approve deltas."],
      visibility: "managers",
      produced_by: manager.agent_id,
      run_id,
      context_pack_id,
      evidence: ["art_evidence_memory_delta"]
    });

    const memoryPath = path.join(dir, "work/projects", project_id, "memory.md");
    const beforeMemory = await fs.readFile(memoryPath, { encoding: "utf8" });

    await expect(
      approveMemoryDelta({
        workspace_dir: dir,
        project_id,
        artifact_id: proposed.artifact_id,
        actor_id: manager.agent_id,
        actor_role: "manager"
      })
    ).rejects.toThrow(/Policy denied approval/);

    const afterMemory = await fs.readFile(memoryPath, { encoding: "utf8" });
    expect(afterMemory).toBe(beforeMemory);

    const reviewsDir = path.join(dir, "inbox/reviews");
    const reviewFiles = await fs.readdir(reviewsDir);
    expect(reviewFiles.some((f) => f.endsWith(".yaml"))).toBe(false);

    const eventsPath = path.join(
      dir,
      "work/projects",
      project_id,
      "runs",
      run_id,
      "events.jsonl"
    );
    const evs = await readJsonl(eventsPath);
    expect(
      evs.some(
        (e) =>
          e.type === "policy.denied" &&
          e.payload?.action === "approve" &&
          e.payload?.resource_id === proposed.artifact_id
      )
    ).toBe(true);
    expect(
      evs.some(
        (e) =>
          e.type === "policy.decision" &&
          e.payload?.allowed === false &&
          e.payload?.action === "approve" &&
          e.payload?.resource_id === proposed.artifact_id
      )
    ).toBe(true);
  });

  test("proposal requires scope, sensitivity, rationale, and evidence", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });
    const { team_id } = await createTeam({ workspace_dir: dir, name: "Payments" });
    const { agent_id } = await createAgent({
      workspace_dir: dir,
      name: "Director",
      role: "director",
      provider: "cmd",
      team_id
    });
    const { run_id, context_pack_id } = await createRun({
      workspace_dir: dir,
      project_id,
      agent_id,
      provider: "cmd"
    });

    await expect(
      proposeMemoryDelta({
        workspace_dir: dir,
        project_id,
        title: "Missing required governance metadata",
        scope_kind: "project_memory",
        sensitivity: "internal",
        rationale: "",
        under_heading: "## Decisions",
        insert_lines: ["- Should fail due to missing rationale/evidence."],
        visibility: "managers",
        produced_by: agent_id,
        run_id,
        context_pack_id,
        evidence: []
      } as any)
    ).rejects.toThrow(/rationale|evidence/i);
  });
});
