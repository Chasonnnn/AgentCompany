import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { initWorkspace } from "../src/workspace/init.js";
import { createTeam } from "../src/org/teams.js";
import { createAgent } from "../src/org/agents.js";
import { createProject } from "../src/work/projects.js";
import { createProjectArtifactFile } from "../src/work/project_artifacts.js";
import { setProviderBin } from "../src/machine/machine.js";
import { fillArtifactWithProvider } from "../src/pipeline/artifact_fill.js";
import { validateMarkdownArtifact } from "../src/artifacts/markdown.js";

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-"));
}

async function writeFakeCodexBin(dir: string): Promise<string> {
  const p = path.join(dir, "fake-codex.mjs");
  const src = `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

function argAfter(flag) {
  const i = process.argv.indexOf(flag);
  if (i === -1) return null;
  return process.argv[i + 1] ?? null;
}

const outPath = argAfter("--output-last-message");
if (!outPath) {
  process.stderr.write("missing --output-last-message\\n");
  process.exit(2);
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  const marker = "Template to fill (copy and complete):";
  const idx = input.indexOf(marker);
  const template = idx >= 0 ? input.slice(idx + marker.length).trimStart() : input;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, template, { encoding: "utf8" });
  process.exit(0);
});
process.stdin.resume();
`;
  await fs.writeFile(p, src, { encoding: "utf8", mode: 0o755 });
  return p;
}

async function readJsonl(filePath: string): Promise<any[]> {
  const s = await fs.readFile(filePath, { encoding: "utf8" });
  const lines = s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.map((l) => JSON.parse(l));
}

describe("fillArtifactWithProvider", () => {
  test("fills an existing artifact and records artifact.produced in the run events", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });

    const fakeBin = await writeFakeCodexBin(dir);
    await setProviderBin(dir, "codex", fakeBin);

    const { team_id } = await createTeam({ workspace_dir: dir, name: "Payments" });
    const { agent_id } = await createAgent({
      workspace_dir: dir,
      name: "Manager",
      role: "manager",
      provider: "codex",
      team_id
    });
    const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });
    const created = await createProjectArtifactFile({
      workspace_dir: dir,
      project_id,
      type: "proposal",
      title: "Proposal: Payments",
      visibility: "managers",
      produced_by: agent_id,
      run_id: "run_manual",
      context_pack_id: "ctx_manual"
    });

    const res = await fillArtifactWithProvider({
      workspace_dir: dir,
      project_id,
      artifact_id: created.artifact_id,
      agent_id,
      prompt: "Fill with concrete content."
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const artifactAbs = path.join(dir, res.artifact_relpath);
    const md = await fs.readFile(artifactAbs, { encoding: "utf8" });
    const validated = validateMarkdownArtifact(md);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.frontmatter.id).toBe(created.artifact_id);
    expect(validated.frontmatter.produced_by).toBe(agent_id);
    expect(validated.frontmatter.run_id).toBe(res.run_id);
    expect(validated.frontmatter.context_pack_id).toBe(res.context_pack_id);

    const eventsPath = path.join(dir, "work/projects", project_id, "runs", res.run_id, "events.jsonl");
    const evs = await readJsonl(eventsPath);
    expect(evs.some((e) => e.type === "artifact.produced" && e.payload?.artifact_id === created.artifact_id)).toBe(true);
  });
});
