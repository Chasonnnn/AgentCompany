import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { initWorkspace } from "../src/workspace/init.js";
import { validateWorkspace } from "../src/workspace/validate.js";
import { createTeam } from "../src/org/teams.js";
import { createAgent } from "../src/org/agents.js";
import { setProviderBin } from "../src/machine/machine.js";
import { runPlanningPipeline } from "../src/pipeline/plan_run.js";
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

async function readProjectArtifact(dir: string, projectId: string, artifactId: string): Promise<string> {
  const p = path.join(dir, "work/projects", projectId, "artifacts", `${artifactId}.md`);
  return fs.readFile(p, { encoding: "utf8" });
}

describe("planning pipeline", () => {
  test(
    "runPlanningPipeline creates and fills intake/proposals/workplan with provenance",
    async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });

    const fakeBin = await writeFakeCodexBin(dir);
    await setProviderBin(dir, "codex", fakeBin);

    const { team_id: t1 } = await createTeam({ workspace_dir: dir, name: "Payments" });
    const { team_id: t2 } = await createTeam({ workspace_dir: dir, name: "Platform" });

    const { agent_id: ceo } = await createAgent({
      workspace_dir: dir,
      name: "CEO",
      role: "ceo",
      provider: "codex"
    });
    const { agent_id: director } = await createAgent({
      workspace_dir: dir,
      name: "Director",
      role: "director",
      provider: "codex"
    });
    const { agent_id: m1 } = await createAgent({
      workspace_dir: dir,
      name: "Mgr Payments",
      role: "manager",
      provider: "codex",
      team_id: t1
    });
    const { agent_id: m2 } = await createAgent({
      workspace_dir: dir,
      name: "Mgr Platform",
      role: "manager",
      provider: "codex",
      team_id: t2
    });

    const res = await runPlanningPipeline({
      workspace_dir: dir,
      project_name: "Project X",
      ceo_agent_id: ceo,
      director_agent_id: director,
      manager_agent_ids: [m1, m2],
      intake_brief: "Build a v0 demo. Must support multi-provider planning and governance."
    });

    expect(res.project_id.startsWith("proj_")).toBe(true);
    expect(res.intake_brief.run_id.startsWith("run_")).toBe(true);
    expect(res.clarifications_qa.run_id.startsWith("run_")).toBe(true);
    expect(res.workplan.run_id.startsWith("run_")).toBe(true);

    const intakeMd = await readProjectArtifact(dir, res.project_id, res.intake_brief.artifact_id);
    const intakeVal = validateMarkdownArtifact(intakeMd);
    expect(intakeVal.ok).toBe(true);
    if (intakeVal.ok) {
      expect(intakeVal.frontmatter.produced_by).toBe(ceo);
      expect(intakeVal.frontmatter.run_id).toBe(res.intake_brief.run_id);
      expect(intakeVal.frontmatter.context_pack_id).toBe(res.intake_brief.context_pack_id);
    }

    for (const [mgr, p] of Object.entries(res.manager_proposals)) {
      const md = await readProjectArtifact(dir, res.project_id, p.artifact_id);
      const v = validateMarkdownArtifact(md);
      expect(v.ok).toBe(true);
      if (v.ok) {
        expect(v.frontmatter.produced_by).toBe(mgr);
        expect(v.frontmatter.run_id).toBe(p.run_id);
        expect(v.frontmatter.context_pack_id).toBe(p.context_pack_id);
      }
    }

    const clarificationsMd = await readProjectArtifact(
      dir,
      res.project_id,
      res.clarifications_qa.artifact_id
    );
    const clarificationsVal = validateMarkdownArtifact(clarificationsMd);
    expect(clarificationsVal.ok).toBe(true);
    if (clarificationsVal.ok) {
      expect(clarificationsVal.frontmatter.type).toBe("clarifications_qa");
      expect(clarificationsVal.frontmatter.produced_by).toBe(director);
      expect(clarificationsVal.frontmatter.run_id).toBe(res.clarifications_qa.run_id);
      expect(clarificationsVal.frontmatter.context_pack_id).toBe(res.clarifications_qa.context_pack_id);
    }

    const workplanMd = await readProjectArtifact(dir, res.project_id, res.workplan.artifact_id);
    const workplanVal = validateMarkdownArtifact(workplanMd);
    expect(workplanVal.ok).toBe(true);
    if (workplanVal.ok) {
      expect(workplanVal.frontmatter.produced_by).toBe(director);
      expect(workplanVal.frontmatter.run_id).toBe(res.workplan.run_id);
      expect(workplanVal.frontmatter.context_pack_id).toBe(res.workplan.context_pack_id);
    }

    expect(res.usage_estimate.source).toBe("estimated_chars");
    expect(res.usage_estimate.confidence).toBe("low");
    expect(res.usage_estimate.by_run.length).toBe(5);
    expect(res.usage_estimate.estimated_total_tokens).toBeGreaterThan(0);
    const usageOut = path.join(
      dir,
      "work/projects",
      res.project_id,
      "runs",
      res.workplan.run_id,
      "outputs",
      "planning_usage_estimate.json"
    );
    await fs.access(usageOut);

      const v = await validateWorkspace(dir);
      expect(v.ok).toBe(true);
    },
    10000
  );
});
