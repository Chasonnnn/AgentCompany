import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { initWorkspace } from "../src/workspace/init.js";
import { createProject } from "../src/work/projects.js";
import { createTeam } from "../src/org/teams.js";
import { createAgent } from "../src/org/agents.js";
import { createRun } from "../src/runtime/run.js";
import { validateWorkspace } from "../src/workspace/validate.js";
import { newArtifactMarkdown, validateMarkdownArtifact } from "../src/artifacts/markdown.js";
import { writeFileAtomic } from "../src/store/fs.js";
import { createSharePack } from "../src/share/share_pack.js";
import { replaySharePack } from "../src/share/replay.js";
import { createHelpRequestFile } from "../src/help/help_request_files.js";

async function mkTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-"));
  return dir;
}

describe("share packs and help requests", () => {
  test("createSharePack bundles managers/org artifacts and validates", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });
    const { team_id } = await createTeam({ workspace_dir: dir, name: "Payments" });
    const { agent_id } = await createAgent({
      workspace_dir: dir,
      name: "Worker",
      role: "worker",
      provider: "codex",
      team_id
    });
    const run = await createRun({
      workspace_dir: dir,
      project_id,
      agent_id,
      provider: "codex"
    });

    const md = newArtifactMarkdown({
      type: "proposal",
      title: "Payments Proposal",
      visibility: "managers",
      produced_by: "human",
      run_id: run.run_id,
      context_pack_id: run.context_pack_id
    });
    const validated = validateMarkdownArtifact(md);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const artifactId = validated.frontmatter.id;
    const artifactPath = path.join(dir, "work/projects", project_id, "artifacts", `${artifactId}.md`);
    await writeFileAtomic(
      artifactPath,
      `${md}\n\nSecret token: sk-123456789012345678901234567890\n`
    );

    await fs.appendFile(
      path.join(dir, "work/projects", project_id, "runs", run.run_id, "events.jsonl"),
      `${JSON.stringify({
        schema_version: 1,
        ts_wallclock: new Date().toISOString(),
        ts_monotonic_ms: 1,
        run_id: run.run_id,
        session_ref: `local_${run.run_id}`,
        actor: "worker",
        visibility: "managers",
        type: "provider.raw",
        payload: {
          chunk: "Bearer sk-123456789012345678901234567890"
        }
      })}\n`,
      { encoding: "utf8" }
    );

    const share = await createSharePack({
      workspace_dir: dir,
      project_id,
      created_by: "human"
    });
    expect(share.share_pack_id).toMatch(/^share_/);
    expect(share.included_run_ids).toContain(run.run_id);

    const bundledArtifact = await fs.readFile(
      path.join(dir, "work/projects", project_id, "share_packs", share.share_pack_id, "bundle", `${artifactId}.md`),
      { encoding: "utf8" }
    );
    expect(bundledArtifact.includes("sk-123456789012345678901234567890")).toBe(false);
    expect(bundledArtifact.includes("[REDACTED")).toBe(true);

    const replay = await replaySharePack({
      workspace_dir: dir,
      project_id,
      share_pack_id: share.share_pack_id,
      run_id: run.run_id
    });
    expect(replay.runs).toHaveLength(1);
    expect(replay.runs[0].events.length).toBeGreaterThan(0);
    expect(JSON.stringify(replay.runs[0].events).includes("sk-123456789012345678901234567890")).toBe(
      false
    );

    const res = await validateWorkspace(dir);
    expect(res.ok).toBe(true);
  });

  test("help request validates and workspace validation reports invalid help request", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });

    const help = await createHelpRequestFile(dir, {
      title: "Need review of workplan",
      visibility: "managers",
      requester: "human",
      target_manager: "agent_mgr_other",
      project_id
    });
    await fs.access(help.file_path);

    let res = await validateWorkspace(dir);
    expect(res.ok).toBe(true);

    const raw = await fs.readFile(help.file_path, { encoding: "utf8" });
    await fs.writeFile(help.file_path, raw.replace("## Response", "## NotResponse"), {
      encoding: "utf8"
    });

    res = await validateWorkspace(dir);
    expect(res.ok).toBe(false);
  });
});
