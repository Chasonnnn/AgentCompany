import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { initWorkspace } from "../src/workspace/init.js";
import { setProviderBin } from "../src/machine/machine.js";
import { createTeam } from "../src/org/teams.js";
import { createAgent } from "../src/org/agents.js";
import { createProject } from "../src/work/projects.js";
import { collectJob, pollJob, submitJob } from "../src/runtime/job_runner.js";
import { extractSessionCommitCandidates } from "../src/memory/extract_session_commit_candidates.js";

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-memory-candidates-"));
}

async function waitForTerminal(args: {
  workspace_dir: string;
  project_id: string;
  job_id: string;
  timeout_ms?: number;
}): Promise<void> {
  const end = Date.now() + (args.timeout_ms ?? 15_000);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const poll = await pollJob({
      workspace_dir: args.workspace_dir,
      project_id: args.project_id,
      job_id: args.job_id
    });
    if (poll.status !== "queued" && poll.status !== "running") return;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${args.job_id}`);
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
}

describe("memory candidate extraction", () => {
  test("writes review-only candidate report and blocks secret-like candidate text", async () => {
    const dir = await mkTmpDir();
    const prevOpenAi = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      await initWorkspace({ root_dir: dir, company_name: "Acme" });
      const codexBin = path.join(dir, "codex");
      await fs.writeFile(
        codexBin,
        `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "login" && args[1] === "status") {
  process.stdout.write("Auth mode: ChatGPT\\n");
  process.exit(0);
}
let input = "";
process.stdin.on("data", (d) => (input += d.toString("utf8")));
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({
    status: "succeeded",
    summary: "contains sk-ABCDEF1234567890ABCDEF1234 token-like text",
    files_changed: [{ path: "src/runtime/job_runner.ts", change_type: "modified" }],
    commands_run: [],
    artifacts: [],
    next_actions: [{ action: "ship patch" }],
    errors: []
  }) + "\\n");
});
`,
        { encoding: "utf8", mode: 0o755 }
      );
      await setProviderBin(dir, "codex", codexBin);

      const { team_id } = await createTeam({ workspace_dir: dir, name: "Core" });
      const { agent_id } = await createAgent({
        workspace_dir: dir,
        name: "Worker",
        role: "worker",
        provider: "codex",
        team_id
      });
      const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });

      const submitted = await submitJob({
        job: {
          schema_version: 1,
          type: "job",
          job_id: "job_extract_candidates",
          worker_kind: "codex",
          workspace_dir: dir,
          project_id,
          goal: "Extract candidate memory",
          constraints: ["JSON only"],
          deliverables: ["Result"],
          permission_level: "patch",
          context_refs: [{ kind: "note", value: "candidate test context" }],
          worker_agent_id: agent_id,
          manager_actor_id: "manager_test",
          manager_role: "manager"
        }
      });

      await waitForTerminal({
        workspace_dir: dir,
        project_id,
        job_id: submitted.job_id
      });
      const collected = await collectJob({
        workspace_dir: dir,
        project_id,
        job_id: submitted.job_id
      });
      const runId = collected.attempts[0]?.run_id;
      expect(typeof runId).toBe("string");

      const extracted = await extractSessionCommitCandidates({
        workspace_dir: dir,
        project_id,
        job_id: submitted.job_id,
        run_id: runId,
        actor_id: "manager_test",
        actor_role: "manager",
        limit: 20
      });
      expect(typeof extracted.report_relpath).toBe("string");
      expect(extracted.blocked_secret_count).toBeGreaterThanOrEqual(1);

      const reportAbs = path.join(dir, extracted.report_relpath);
      const reportText = await fs.readFile(reportAbs, { encoding: "utf8" });
      expect(reportText).not.toMatch(/sk-[A-Za-z0-9]{20,}/);

      const artifactDir = path.join(dir, "work/projects", project_id, "artifacts");
      const artifactFiles = await fs.readdir(artifactDir);
      expect(artifactFiles.some((f) => f.endsWith(".md"))).toBe(false);
    } finally {
      if (prevOpenAi === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevOpenAi;
    }
  });
});

