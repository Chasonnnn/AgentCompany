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
import { writeFileAtomic } from "../src/store/fs.js";

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-"));
}

describe("memory redaction", () => {
  test("proposal fails when secret-like content is present", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });
    const { team_id } = await createTeam({ workspace_dir: dir, name: "Payments" });
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

    await expect(
      proposeMemoryDelta({
        workspace_dir: dir,
        project_id,
        title: "Store leaked token",
        scope_kind: "project_memory",
        sensitivity: "internal",
        rationale: "Testing fail-closed redaction gate.",
        under_heading: "## Decisions",
        insert_lines: ["- token=sk-1234567890abcdefghijklmnopqrs"],
        visibility: "managers",
        produced_by: director.agent_id,
        run_id,
        context_pack_id,
        evidence: ["art_evidence_redaction"]
      })
    ).rejects.toThrow(/sensitive|redact|secret/i);
  });

  test("approval fails when patch/final content contains secret-like content", async () => {
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
      title: "Safe proposal",
      scope_kind: "project_memory",
      sensitivity: "internal",
      rationale: "Patch tamper check should be fail-closed during approval.",
      under_heading: "## Decisions",
      insert_lines: ["- Initial clean content."],
      visibility: "managers",
      produced_by: manager.agent_id,
      run_id,
      context_pack_id,
      evidence: ["art_evidence_patch_tamper"]
    });

    const patchAbs = path.join(dir, proposed.patch_relpath);
    const patchText = await fs.readFile(patchAbs, { encoding: "utf8" });
    const tampered = `${patchText}\n+sk-1234567890abcdefghijklmnopqrs\n`;
    await writeFileAtomic(patchAbs, tampered);

    await expect(
      approveMemoryDelta({
        workspace_dir: dir,
        project_id,
        artifact_id: proposed.artifact_id,
        actor_id: director.agent_id,
        actor_role: "director"
      })
    ).rejects.toThrow(/sensitive|redact|secret/i);
  });

  test("approval fails closed on secret-like reviewer notes before persistence", async () => {
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
      agent_id: manager.agent_id,
      provider: "cmd"
    });

    const proposed = await proposeMemoryDelta({
      workspace_dir: dir,
      project_id,
      title: "Safe proposal",
      scope_kind: "project_memory",
      sensitivity: "internal",
      rationale: "Review notes should be checked with fail-closed secret detection.",
      under_heading: "## Decisions",
      insert_lines: ["- clean content for notes gate"],
      visibility: "managers",
      produced_by: manager.agent_id,
      run_id,
      context_pack_id,
      evidence: ["art_evidence_notes_gate"]
    });

    const memoryPath = path.join(dir, "work/projects", project_id, "memory.md");
    const beforeMemory = await fs.readFile(memoryPath, { encoding: "utf8" });

    await expect(
      approveMemoryDelta({
        workspace_dir: dir,
        project_id,
        artifact_id: proposed.artifact_id,
        actor_id: director.agent_id,
        actor_role: "director",
        notes: "Contains secret sk-1234567890abcdefghijklmnopqrs"
      })
    ).rejects.toThrow(/sensitive|redact|secret/i);

    const afterMemory = await fs.readFile(memoryPath, { encoding: "utf8" });
    expect(afterMemory).toBe(beforeMemory);

    const reviewsDir = path.join(dir, "inbox/reviews");
    const reviewFiles = await fs.readdir(reviewsDir);
    expect(reviewFiles.some((f) => f.endsWith(".yaml"))).toBe(false);

    const eventsPath = path.join(dir, "work/projects", project_id, "runs", run_id, "events.jsonl");
    const eventsRaw = await fs.readFile(eventsPath, { encoding: "utf8" });
    expect(eventsRaw).not.toContain('"type":"approval.decided"');
  });
});
