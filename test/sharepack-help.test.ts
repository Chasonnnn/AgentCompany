import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { initWorkspace } from "../src/workspace/init.js";
import { createProject } from "../src/work/projects.js";
import { validateWorkspace } from "../src/workspace/validate.js";
import { newArtifactMarkdown, validateMarkdownArtifact } from "../src/artifacts/markdown.js";
import { writeFileAtomic } from "../src/store/fs.js";
import { createSharePack } from "../src/share/share_pack.js";
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

    const md = newArtifactMarkdown({
      type: "proposal",
      title: "Payments Proposal",
      visibility: "managers",
      produced_by: "human",
      run_id: "run_manual",
      context_pack_id: "ctx_manual"
    });
    const validated = validateMarkdownArtifact(md);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const artifactId = validated.frontmatter.id;
    const artifactPath = path.join(dir, "work/projects", project_id, "artifacts", `${artifactId}.md`);
    await writeFileAtomic(artifactPath, md);

    const share = await createSharePack({
      workspace_dir: dir,
      project_id,
      created_by: "human"
    });
    expect(share.share_pack_id).toMatch(/^share_/);

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

