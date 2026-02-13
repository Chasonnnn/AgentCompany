import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { initWorkspace } from "../src/workspace/init.js";
import { setProviderBin } from "../src/machine/machine.js";
import { createTeam } from "../src/org/teams.js";
import { createAgent } from "../src/org/agents.js";
import { createProject } from "../src/work/projects.js";
import { cancelJob, collectJob, pollJob, submitJob } from "../src/runtime/job_runner.js";

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-"));
}

async function writeFakeCodex(dir: string, mode: "retryable" | "always_bad" | "slow"): Promise<string> {
  const p = path.join(dir, "codex");
  const loginStatus = `const args = process.argv.slice(2);
if (args[0] === "login" && args[1] === "status") {
  process.stdout.write("Auth mode: ChatGPT\\n");
  process.exit(0);
}
`;
  const source =
    mode === "slow"
      ? `#!/usr/bin/env node
${loginStatus}
let input = "";
process.stdin.on("data", (d) => (input += d.toString("utf8")));
process.stdin.on("end", () => {
  setTimeout(() => {
    process.stdout.write(JSON.stringify({
      status: "succeeded",
      summary: "slow ok",
      files_changed: [],
      commands_run: [],
      artifacts: [],
      next_actions: [],
      errors: []
    }) + "\\n");
  }, 1400);
});
`
      : mode === "always_bad"
        ? `#!/usr/bin/env node
${loginStatus}
process.stdout.write("not json\\n");
`
        : `#!/usr/bin/env node
${loginStatus}
let input = "";
process.stdin.on("data", (d) => (input += d.toString("utf8")));
process.stdin.on("end", () => {
  if (input.includes("Validation issues to fix")) {
    process.stdout.write(JSON.stringify({
      status: "succeeded",
      summary: "fixed via retry",
      files_changed: [{ path: "src/runtime/job_runner.ts", change_type: "modified" }],
      commands_run: [],
      artifacts: [],
      next_actions: [{ action: "submit to manager" }],
      errors: []
    }) + "\\n");
    return;
  }
  process.stdout.write("oops not valid json\\n");
});
`;
  await fs.writeFile(p, source, { encoding: "utf8", mode: 0o755 });
  return p;
}

async function waitForJobTerminal(args: {
  workspace_dir: string;
  project_id: string;
  job_id: string;
  timeout_ms?: number;
}): Promise<Awaited<ReturnType<typeof pollJob>>> {
  const end = Date.now() + (args.timeout_ms ?? 20000);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const p = await pollJob({
      workspace_dir: args.workspace_dir,
      project_id: args.project_id,
      job_id: args.job_id
    });
    if (p.status !== "queued" && p.status !== "running") return p;
    if (Date.now() > end) {
      throw new Error(`Timed out waiting for job ${args.job_id}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
}

async function createWorkspaceWithCodexWorker(dir: string, mode: "retryable" | "always_bad" | "slow"): Promise<{
  project_id: string;
  worker_agent_id: string;
}> {
  await initWorkspace({ root_dir: dir, company_name: "Acme" });
  const codexBin = await writeFakeCodex(dir, mode);
  await setProviderBin(dir, "codex", codexBin);
  const { team_id } = await createTeam({ workspace_dir: dir, name: "Engineering" });
  const { agent_id } = await createAgent({
    workspace_dir: dir,
    name: "Worker Codex",
    role: "worker",
    provider: "codex",
    team_id
  });
  const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });
  return {
    project_id,
    worker_agent_id: agent_id
  };
}

async function createWorkspaceWithGeminiWorker(dir: string, launcher: Record<string, unknown>): Promise<{
  project_id: string;
  worker_agent_id: string;
}> {
  await initWorkspace({ root_dir: dir, company_name: "Acme" });
  const geminiBin = path.join(dir, "gemini");
  await fs.writeFile(
    geminiBin,
    "#!/usr/bin/env node\nprocess.stdout.write('{}\\n');\n",
    { encoding: "utf8", mode: 0o755 }
  );
  await setProviderBin(dir, "gemini", geminiBin);
  const { team_id } = await createTeam({ workspace_dir: dir, name: "AI" });
  const { agent_id } = await createAgent({
    workspace_dir: dir,
    name: "Worker Gemini",
    role: "worker",
    provider: "gemini",
    team_id,
    launcher
  });
  const { project_id } = await createProject({ workspace_dir: dir, name: "Proj Gemini" });
  return { project_id, worker_agent_id: agent_id };
}

async function createWorkspaceWithClaudeWorker(dir: string): Promise<{
  project_id: string;
  worker_agent_id: string;
}> {
  await initWorkspace({ root_dir: dir, company_name: "Acme" });
  const claudeBin = path.join(dir, "claude");
  await fs.writeFile(
    claudeBin,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--help")) {
  process.stdout.write("--json-schema\\n--output-format\\n");
  process.exit(0);
}
if (args.includes("--version")) {
  process.stdout.write("claude-cli 1.0.0\\n");
  process.exit(0);
}
const fmtIndex = args.indexOf("--output-format");
const outFmt = fmtIndex >= 0 ? args[fmtIndex + 1] : "";
const schemaIndex = args.indexOf("--json-schema");
const schemaRaw = schemaIndex >= 0 ? args[schemaIndex + 1] : "";
if (outFmt === "json" && schemaRaw) {
  let schema = {};
  try {
    schema = JSON.parse(schemaRaw);
  } catch {
    schema = {};
  }
  const jobId = schema?.properties?.job_id?.const ?? "job_unknown";
  const runId = schema?.properties?.attempt_run_id?.const ?? "run_unknown";
  process.stdout.write(JSON.stringify({
    type: "result",
    structured_output: {
      schema_version: 1,
      type: "result",
      job_id: jobId,
      attempt_run_id: runId,
      status: "succeeded",
      summary: "native schema ok",
      files_changed: [],
      commands_run: [],
      artifacts: [],
      next_actions: [],
      errors: []
    }
  }) + "\\n");
  process.exit(0);
}
process.stdout.write("not-json\\n");
`,
    { encoding: "utf8", mode: 0o755 }
  );
  await setProviderBin(dir, "claude", claudeBin);
  const { team_id } = await createTeam({ workspace_dir: dir, name: "AI" });
  const { agent_id } = await createAgent({
    workspace_dir: dir,
    name: "Worker Claude",
    role: "worker",
    provider: "claude",
    team_id
  });
  const { project_id } = await createProject({ workspace_dir: dir, name: "Proj Claude" });
  return { project_id, worker_agent_id: agent_id };
}

describe("job runner dual-path orchestration", () => {
  test("retries malformed worker output and succeeds on strict-json retry", async () => {
    const dir = await mkTmpDir();
    const prevOpenAi = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const ws = await createWorkspaceWithCodexWorker(dir, "retryable");
      const submitted = await submitJob({
        job: {
          schema_version: 1,
          type: "job",
          job_id: "job_retry_success",
          worker_kind: "codex",
          workspace_dir: dir,
          project_id: ws.project_id,
          goal: "Implement a tiny fix",
          constraints: ["Output strict ResultSpec JSON"],
          deliverables: ["Code patch"],
          permission_level: "patch",
          context_refs: [{ kind: "note", value: "test context" }],
          worker_agent_id: ws.worker_agent_id
        }
      });
      expect(submitted.job_id).toBe("job_retry_success");
      const terminal = await waitForJobTerminal({
        workspace_dir: dir,
        project_id: ws.project_id,
        job_id: submitted.job_id
      });
      expect(terminal.status).toBe("completed");
      expect(terminal.current_attempt).toBeGreaterThanOrEqual(2);

      const collected = await collectJob({
        workspace_dir: dir,
        project_id: ws.project_id,
        job_id: submitted.job_id
      });
      expect(collected.result?.status).toBe("succeeded");
      expect(collected.result?.summary).toContain("fixed via retry");
      expect(collected.manager_digest).toBeDefined();
    } finally {
      if (prevOpenAi === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevOpenAi;
    }
  });

  test("produces needs_input when all normalization attempts fail", async () => {
    const dir = await mkTmpDir();
    const prevOpenAi = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const ws = await createWorkspaceWithCodexWorker(dir, "always_bad");
      const submitted = await submitJob({
        job: {
          schema_version: 1,
          type: "job",
          job_id: "job_all_bad",
          worker_kind: "codex",
          workspace_dir: dir,
          project_id: ws.project_id,
          goal: "Do something",
          constraints: ["JSON only"],
          deliverables: ["Result"],
          permission_level: "patch",
          context_refs: [{ kind: "note", value: "x" }],
          worker_agent_id: ws.worker_agent_id
        }
      });

      await waitForJobTerminal({
        workspace_dir: dir,
        project_id: ws.project_id,
        job_id: submitted.job_id
      });
      const collected = await collectJob({
        workspace_dir: dir,
        project_id: ws.project_id,
        job_id: submitted.job_id
      });
      expect(collected.result?.status).toBe("needs_input");
      expect(collected.attempts.length).toBe(3);
      expect(collected.result?.errors.length).toBeGreaterThan(0);
    } finally {
      if (prevOpenAi === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevOpenAi;
    }
  });

  test("cancel marks running job as canceled", async () => {
    const dir = await mkTmpDir();
    const prevOpenAi = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const ws = await createWorkspaceWithCodexWorker(dir, "slow");
      const submitted = await submitJob({
        job: {
          schema_version: 1,
          type: "job",
          job_id: "job_cancel_me",
          worker_kind: "codex",
          workspace_dir: dir,
          project_id: ws.project_id,
          goal: "Long operation",
          constraints: ["JSON only"],
          deliverables: ["Result"],
          permission_level: "patch",
          context_refs: [{ kind: "note", value: "cancel test" }],
          worker_agent_id: ws.worker_agent_id
        }
      });
      await new Promise((resolve) => setTimeout(resolve, 120));
      await cancelJob({
        workspace_dir: dir,
        project_id: ws.project_id,
        job_id: submitted.job_id
      });
      const terminal = await waitForJobTerminal({
        workspace_dir: dir,
        project_id: ws.project_id,
        job_id: submitted.job_id
      });
      expect(terminal.status).toBe("canceled");
      const collected = await collectJob({
        workspace_dir: dir,
        project_id: ws.project_id,
        job_id: submitted.job_id
      });
      expect(collected.result?.status).toBe("canceled");
    } finally {
      if (prevOpenAi === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevOpenAi;
    }
  }, 10000);

  test("rejects shell-wrapper launcher templates for security", async () => {
    const dir = await mkTmpDir();
    const prevGeminiApiKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "test-key";
    try {
      const ws = await createWorkspaceWithGeminiWorker(dir, {
        command_argv_template: ["sh", "-c", "echo hacked"]
      });
      const submitted = await submitJob({
        job: {
          schema_version: 1,
          type: "job",
          job_id: "job_gemini_shell_block",
          worker_kind: "gemini",
          workspace_dir: dir,
          project_id: ws.project_id,
          goal: "Security test",
          constraints: ["JSON only"],
          deliverables: ["Result"],
          permission_level: "read-only",
          context_refs: [{ kind: "note", value: "security" }],
          worker_agent_id: ws.worker_agent_id
        }
      });
      await waitForJobTerminal({
        workspace_dir: dir,
        project_id: ws.project_id,
        job_id: submitted.job_id
      });
      const collected = await collectJob({
        workspace_dir: dir,
        project_id: ws.project_id,
        job_id: submitted.job_id
      });
      expect(collected.result?.status).toBe("failed");
      expect(collected.result?.errors?.[0]?.message ?? "").toContain("shell wrapper");
    } finally {
      if (prevGeminiApiKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = prevGeminiApiKey;
    }
  });

  test("uses provider-native schema mode first for claude and succeeds on first attempt", async () => {
    const dir = await mkTmpDir();
    const prevAnthropic = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const ws = await createWorkspaceWithClaudeWorker(dir);
      const submitted = await submitJob({
        job: {
          schema_version: 1,
          type: "job",
          job_id: "job_claude_native_schema",
          worker_kind: "claude",
          workspace_dir: dir,
          project_id: ws.project_id,
          goal: "Use schema-constrained output",
          constraints: ["Return strict ResultSpec JSON"],
          deliverables: ["ResultSpec"],
          permission_level: "read-only",
          context_refs: [{ kind: "note", value: "native schema mode test" }],
          worker_agent_id: ws.worker_agent_id
        }
      });
      const terminal = await waitForJobTerminal({
        workspace_dir: dir,
        project_id: ws.project_id,
        job_id: submitted.job_id
      });
      expect(terminal.status).toBe("completed");
      expect(terminal.current_attempt).toBe(1);
      const collected = await collectJob({
        workspace_dir: dir,
        project_id: ws.project_id,
        job_id: submitted.job_id
      });
      expect(collected.result?.status).toBe("succeeded");
      expect(collected.result?.summary).toContain("native schema ok");
    } finally {
      if (prevAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevAnthropic;
    }
  });

  test("defaults gemini to json output even when stream-json is advertised", async () => {
    const dir = await mkTmpDir();
    const prevGeminiApiKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "test-key";
    try {
      await initWorkspace({ root_dir: dir, company_name: "Acme" });
      const geminiBin = path.join(dir, "gemini");
      await fs.writeFile(
        geminiBin,
        `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--help")) {
  process.stdout.write("--output-format [json|stream-json]\\n");
  process.exit(0);
}
if (args.includes("--version")) {
  process.stdout.write("gemini-cli 1.0.0\\n");
  process.exit(0);
}
const fmtIndex = args.indexOf("--output-format");
const fmt = fmtIndex >= 0 ? args[fmtIndex + 1] : "";
if (fmt === "json") {
  process.stdout.write(JSON.stringify({
    schema_version: 1,
    type: "result",
    status: "succeeded",
    summary: "gemini json baseline",
    files_changed: [],
    commands_run: [],
    artifacts: [],
    next_actions: [],
    errors: []
  }) + "\\n");
  process.exit(0);
}
process.stdout.write("stream-json unsupported in this test\\n");
process.exit(0);
`,
        { encoding: "utf8", mode: 0o755 }
      );
      await setProviderBin(dir, "gemini", geminiBin);
      const { team_id } = await createTeam({ workspace_dir: dir, name: "AI" });
      const { agent_id } = await createAgent({
        workspace_dir: dir,
        name: "Worker Gemini",
        role: "worker",
        provider: "gemini",
        team_id
      });
      const { project_id } = await createProject({ workspace_dir: dir, name: "Proj Gemini JSON" });

      const submitted = await submitJob({
        job: {
          schema_version: 1,
          type: "job",
          job_id: "job_gemini_json_default",
          worker_kind: "gemini",
          workspace_dir: dir,
          project_id,
          goal: "Gemini JSON output baseline",
          constraints: ["JSON only"],
          deliverables: ["Result"],
          permission_level: "read-only",
          context_refs: [{ kind: "note", value: "gemini output format test" }],
          worker_agent_id: agent_id
        }
      });
      await waitForJobTerminal({
        workspace_dir: dir,
        project_id,
        job_id: submitted.job_id
      });
      const collected = await collectJob({
        workspace_dir: dir,
        project_id,
        job_id: submitted.job_id
      });
      expect(collected.result?.status).toBe("succeeded");
      expect(collected.result?.summary).toContain("gemini json baseline");
      expect(collected.attempts[0]?.output_format).toBe("json");
    } finally {
      if (prevGeminiApiKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = prevGeminiApiKey;
    }
  });

  test("blocks gemini job when API credentials are missing", async () => {
    const dir = await mkTmpDir();
    const prevGeminiApiKey = process.env.GEMINI_API_KEY;
    const prevGoogleApiKey = process.env.GOOGLE_API_KEY;
    const prevUseVertex = process.env.GOOGLE_GENAI_USE_VERTEXAI;
    const prevProject = process.env.GOOGLE_CLOUD_PROJECT;
    const prevLocation = process.env.GOOGLE_CLOUD_LOCATION;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GOOGLE_GENAI_USE_VERTEXAI;
    delete process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.GOOGLE_CLOUD_LOCATION;
    try {
      await initWorkspace({ root_dir: dir, company_name: "Acme" });
      const geminiBin = path.join(dir, "gemini");
      await fs.writeFile(
        geminiBin,
        "#!/usr/bin/env node\nprocess.stdout.write('{}\\n');\n",
        { encoding: "utf8", mode: 0o755 }
      );
      await setProviderBin(dir, "gemini", geminiBin);
      const { team_id } = await createTeam({ workspace_dir: dir, name: "AI" });
      const { agent_id } = await createAgent({
        workspace_dir: dir,
        name: "Worker Gemini",
        role: "worker",
        provider: "gemini",
        team_id
      });
      const { project_id } = await createProject({ workspace_dir: dir, name: "Proj Gemini Missing API" });

      const submitted = await submitJob({
        job: {
          schema_version: 1,
          type: "job",
          job_id: "job_gemini_missing_api",
          worker_kind: "gemini",
          workspace_dir: dir,
          project_id,
          goal: "Gemini preflight should fail",
          constraints: ["JSON only"],
          deliverables: ["Result"],
          permission_level: "read-only",
          context_refs: [{ kind: "note", value: "missing gemini API key test" }],
          worker_agent_id: agent_id
        }
      });
      await waitForJobTerminal({
        workspace_dir: dir,
        project_id,
        job_id: submitted.job_id
      });
      const collected = await collectJob({
        workspace_dir: dir,
        project_id,
        job_id: submitted.job_id
      });
      expect(collected.result?.status).toBe("blocked");
      expect(collected.result?.summary ?? "").toContain("preflight");
      expect(collected.result?.errors?.[0]?.message ?? "").toContain("Gemini API");
    } finally {
      if (prevGeminiApiKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = prevGeminiApiKey;
      if (prevGoogleApiKey === undefined) delete process.env.GOOGLE_API_KEY;
      else process.env.GOOGLE_API_KEY = prevGoogleApiKey;
      if (prevUseVertex === undefined) delete process.env.GOOGLE_GENAI_USE_VERTEXAI;
      else process.env.GOOGLE_GENAI_USE_VERTEXAI = prevUseVertex;
      if (prevProject === undefined) delete process.env.GOOGLE_CLOUD_PROJECT;
      else process.env.GOOGLE_CLOUD_PROJECT = prevProject;
      if (prevLocation === undefined) delete process.env.GOOGLE_CLOUD_LOCATION;
      else process.env.GOOGLE_CLOUD_LOCATION = prevLocation;
    }
  });
});
