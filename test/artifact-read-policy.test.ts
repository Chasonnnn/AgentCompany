import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { initWorkspace } from "../src/workspace/init.js";
import { createTeam } from "../src/org/teams.js";
import { createAgent } from "../src/org/agents.js";
import { createProject } from "../src/work/projects.js";
import { createRun } from "../src/runtime/run.js";
import { newArtifactMarkdown } from "../src/artifacts/markdown.js";
import { readArtifactWithPolicy } from "../src/artifacts/read_artifact.js";
import { readEventsJsonl } from "../src/runtime/run_queries.js";

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-"));
}

describe("artifact.read policy enforcement", () => {
  test("denies cross-team reads and emits policy.denied when run_id is provided", async () => {
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

    const artifactId = "art_team_visibility";
    const md = newArtifactMarkdown({
      type: "proposal",
      id: artifactId,
      title: "Payments Proposal",
      visibility: "team",
      produced_by: workerA,
      run_id: producerRun.run_id,
      context_pack_id: producerRun.context_pack_id
    });
    await fs.writeFile(
      path.join(dir, "work/projects", project_id, "artifacts", `${artifactId}.md`),
      md,
      { encoding: "utf8" }
    );

    const allowed = await readArtifactWithPolicy({
      workspace_dir: dir,
      project_id,
      artifact_id: artifactId,
      actor_id: workerA,
      actor_role: "worker",
      actor_team_id: teamA,
      run_id: producerRun.run_id
    });
    expect(allowed.artifact_id).toBe(artifactId);

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

    const eventsPath = path.join(
      dir,
      "work/projects",
      project_id,
      "runs",
      readerRun.run_id,
      "events.jsonl"
    );
    const parsed = await readEventsJsonl(eventsPath);
    const events = parsed.filter((p): p is { ok: true; event: any } => p.ok).map((p) => p.event);
    expect(events.some((e) => e.type === "policy.denied")).toBe(true);
    expect(
      events.some(
        (e) =>
          e.type === "policy.decision" &&
          e.payload?.allowed === false &&
          e.payload?.action === "read" &&
          e.payload?.resource_id === artifactId
      )
    ).toBe(true);
  });
});
