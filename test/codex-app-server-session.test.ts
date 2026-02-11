import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { initWorkspace } from "../src/workspace/init.js";
import { createTeam } from "../src/org/teams.js";
import { createAgent } from "../src/org/agents.js";
import { createProject } from "../src/work/projects.js";
import { createRun } from "../src/runtime/run.js";
import { launchSession, pollSession, collectSession } from "../src/runtime/session.js";
import { readYamlFile, writeYamlFile } from "../src/store/yaml.js";
import { RunYaml } from "../src/schemas/run.js";

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-"));
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTerminal(
  sessionRef: string,
  workspaceDir: string,
  timeoutMs: number = 8000
): Promise<Awaited<ReturnType<typeof pollSession>>> {
  const end = Date.now() + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const p = await pollSession(sessionRef, { workspace_dir: workspaceDir });
    if (p.status !== "running") return p;
    if (Date.now() > end) throw new Error(`Timed out waiting for session: ${sessionRef}`);
    await sleep(40);
  }
}

function mockCodexAppServerScript(): string {
  return `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const state = { threadId: "thr_mock_01", turnId: "turn_mock_01" };
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
rl.on("line", (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  if (req.method === "initialize") {
    send({ id: req.id, result: { userAgent: "agentcompany-mock/1.0.0" } });
    return;
  }
  if (req.method === "thread/start") {
    send({
      id: req.id,
      result: {
        thread: {
          id: state.threadId,
          preview: "mock",
          modelProvider: "openai",
          createdAt: 0,
          updatedAt: 0,
          path: null,
          cwd: req.params?.cwd || process.cwd(),
          cliVersion: "0.0.0",
          source: "exec",
          gitInfo: null,
          turns: []
        },
        model: "gpt-5",
        modelProvider: "openai",
        cwd: req.params?.cwd || process.cwd(),
        approvalPolicy: "never",
        sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
        reasoningEffort: null
      }
    });
    send({ method: "thread/started", params: { threadId: state.threadId } });
    return;
  }
  if (req.method === "turn/start") {
    send({ id: req.id, result: { turn: { id: state.turnId, items: [], status: "inProgress", error: null } } });
    send({ method: "item/agentMessage/delta", params: { threadId: state.threadId, turnId: state.turnId, itemId: "itm1", delta: "Hello " } });
    send({ method: "item/agentMessage/delta", params: { threadId: state.threadId, turnId: state.turnId, itemId: "itm1", delta: "from protocol." } });
    send({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: state.threadId,
        turnId: state.turnId,
        tokenUsage: {
          total: { totalTokens: 42, inputTokens: 28, cachedInputTokens: 2, outputTokens: 12, reasoningOutputTokens: 0 },
          last: { totalTokens: 42, inputTokens: 28, cachedInputTokens: 2, outputTokens: 12, reasoningOutputTokens: 0 },
          modelContextWindow: null
        }
      }
    });
    send({ method: "turn/completed", params: { threadId: state.threadId, turn: { id: state.turnId, items: [], status: "completed", error: null } } });
    return;
  }
  if (req.method === "turn/interrupt") {
    send({ id: req.id, result: {} });
    send({ method: "turn/completed", params: { threadId: state.threadId, turn: { id: state.turnId, items: [], status: "interrupted", error: null } } });
    return;
  }
  send({ id: req.id, result: {} });
});
`;
}

describe("codex app-server protocol sessions", () => {
  test("launches via protocol and records streamed output + token usage", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });

    const mockBinPath = path.join(dir, "mock-codex-app-server.js");
    await fs.writeFile(mockBinPath, mockCodexAppServerScript(), { encoding: "utf8", mode: 0o755 });
    const machinePath = path.join(dir, ".local/machine.yaml");
    const machineDoc = await readYamlFile(machinePath);
    await writeYamlFile(machinePath, {
      ...machineDoc,
      provider_bins: {
        ...machineDoc.provider_bins,
        codex_app_server: mockBinPath
      },
      provider_pricing_usd_per_1k_tokens: {
        codex_app_server: {
          input: 0.02,
          cached_input: 0.01,
          output: 0.03,
          reasoning_output: 0.03
        }
      }
    });

    const { team_id } = await createTeam({ workspace_dir: dir, name: "Platform" });
    const { agent_id } = await createAgent({
      workspace_dir: dir,
      name: "Director",
      role: "director",
      provider: "codex_app_server",
      team_id
    });
    const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });
    const { run_id } = await createRun({
      workspace_dir: dir,
      project_id,
      agent_id,
      provider: "codex_app_server"
    });

    const launched = await launchSession({
      workspace_dir: dir,
      project_id,
      run_id,
      argv: [mockBinPath],
      prompt_text: "Draft the workplan summary."
    });

    const terminal = await waitForTerminal(launched.session_ref, dir);
    expect(terminal.status).toBe("ended");

    const collected = await collectSession(launched.session_ref, { workspace_dir: dir });
    expect(collected.output_relpaths.some((p) => p.endsWith("last_message.md"))).toBe(true);

    const runDoc = RunYaml.parse(
      await readYamlFile(path.join(dir, "work/projects", project_id, "runs", run_id, "run.yaml"))
    );
    expect(runDoc.status).toBe("ended");
    expect(runDoc.usage?.source).toBe("provider_reported");
    expect(runDoc.usage?.total_tokens).toBe(42);
    expect(runDoc.usage?.cost_usd).toBeGreaterThan(0);

    const lastMessage = await fs.readFile(
      path.join(dir, "work/projects", project_id, "runs", run_id, "outputs", "last_message.md"),
      { encoding: "utf8" }
    );
    expect(lastMessage).toContain("Hello from protocol.");
  });
});
