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

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-heartbeat-job-"));
}

async function writeFakeCodex(args: { dir: string; mode: "heartbeat_ok" | "bad" }): Promise<string> {
  const p = path.join(args.dir, "codex");
  const source =
    args.mode === "bad"
      ? `#!/usr/bin/env node
const argv = process.argv.slice(2);
if (argv[0] === "login" && argv[1] === "status") {
  process.stdout.write("Auth mode: ChatGPT\\n");
  process.exit(0);
}
process.stdout.write("not json\\n");
`
      : `#!/usr/bin/env node
const argv = process.argv.slice(2);
if (argv[0] === "login" && argv[1] === "status") {
  process.stdout.write("Auth mode: ChatGPT\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  schema_version: 1,
  type: "heartbeat_worker_report",
  status: "actions",
  summary: "One follow-up action proposed",
  actions: [
    {
      kind: "noop",
      idempotency_key: "hb:noop:1",
      risk: "low",
      needs_approval: false,
      reason: "no-op"
    }
  ]
}) + "\\n");
`;
  await fs.writeFile(p, source, { encoding: "utf8", mode: 0o755 });
  return p;
}

async function waitForTerminal(args: {
  workspace_dir: string;
  project_id: string;
  job_id: string;
  timeout_ms?: number;
}): Promise<void> {
  const until = Date.now() + (args.timeout_ms ?? 15_000);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const poll = await pollJob({
      workspace_dir: args.workspace_dir,
      project_id: args.project_id,
      job_id: args.job_id
    });
    if (poll.status !== "queued" && poll.status !== "running") return;
    if (Date.now() >= until) throw new Error(`Timed out waiting for ${args.job_id}`);
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
}

describe("job runner heartbeat mode", () => {
  test("collect includes heartbeat_report when job_kind=heartbeat succeeds", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const codexBin = await writeFakeCodex({ dir, mode: "heartbeat_ok" });
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
        job_id: "job_heartbeat_ok",
        job_kind: "heartbeat",
        worker_kind: "codex",
        workspace_dir: dir,
        project_id,
        goal: "Heartbeat check",
        constraints: ["Use heartbeat contract"],
        deliverables: ["report"],
        permission_level: "read-only",
        context_refs: [{ kind: "note", value: "none" }],
        worker_agent_id: agent_id
      }
    });

    await waitForTerminal({ workspace_dir: dir, project_id, job_id: submitted.job_id });
    const collected = await collectJob({ workspace_dir: dir, project_id, job_id: submitted.job_id });

    expect(collected.result?.status).toBe("succeeded");
    expect(collected.heartbeat_report?.status).toBe("actions");
    expect(collected.heartbeat_report?.actions.length).toBe(1);
  });

  test("falls back to needs_input when heartbeat report cannot be parsed", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const codexBin = await writeFakeCodex({ dir, mode: "bad" });
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
        job_id: "job_heartbeat_bad",
        job_kind: "heartbeat",
        worker_kind: "codex",
        workspace_dir: dir,
        project_id,
        goal: "Heartbeat check",
        constraints: ["Use heartbeat contract"],
        deliverables: ["report"],
        permission_level: "read-only",
        context_refs: [{ kind: "note", value: "none" }],
        worker_agent_id: agent_id
      }
    });

    await waitForTerminal({ workspace_dir: dir, project_id, job_id: submitted.job_id });
    const collected = await collectJob({ workspace_dir: dir, project_id, job_id: submitted.job_id });

    expect(collected.result?.status).toBe("needs_input");
    expect(collected.heartbeat_report).toBeUndefined();
  });
});
