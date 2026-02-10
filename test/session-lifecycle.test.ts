import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { initWorkspace } from "../src/workspace/init.js";
import { createTeam } from "../src/org/teams.js";
import { createAgent } from "../src/org/agents.js";
import { createProject } from "../src/work/projects.js";
import { createRun } from "../src/runtime/run.js";
import { launchSession, pollSession, collectSession, stopSession } from "../src/runtime/session.js";
import { readYamlFile } from "../src/store/yaml.js";
import { RunYaml } from "../src/schemas/run.js";

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-"));
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTerminal(
  sessionRef: string,
  timeoutMs: number = 5000
): Promise<ReturnType<typeof pollSession>> {
  const end = Date.now() + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const p = pollSession(sessionRef);
    if (p.status !== "running") return p;
    if (Date.now() > end) throw new Error(`Timed out waiting for session: ${sessionRef}`);
    await sleep(30);
  }
}

describe("runtime session lifecycle", () => {
  test("launch + poll + collect for successful run", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const { team_id } = await createTeam({ workspace_dir: dir, name: "Payments" });
    const { agent_id } = await createAgent({
      workspace_dir: dir,
      name: "Worker",
      role: "worker",
      provider: "cmd",
      team_id
    });
    const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });
    const { run_id } = await createRun({ workspace_dir: dir, project_id, agent_id, provider: "cmd" });

    const launched = await launchSession({
      workspace_dir: dir,
      project_id,
      run_id,
      argv: [process.execPath, "-e", "process.stdout.write('hello\\n');"]
    });
    expect(launched.session_ref).toBe(`local_${run_id}`);
    expect(["running", "ended"]).toContain(pollSession(launched.session_ref).status);

    const terminal = await waitForTerminal(launched.session_ref);
    expect(terminal.status).toBe("ended");
    expect(terminal.exit_code).toBe(0);

    const collected = await collectSession(launched.session_ref);
    expect(collected.status).toBe("ended");
    expect(collected.output_relpaths.some((p) => p.endsWith("stdout.txt"))).toBe(true);

    const runDoc = RunYaml.parse(
      await readYamlFile(path.join(dir, "work/projects", project_id, "runs", run_id, "run.yaml"))
    );
    expect(runDoc.status).toBe("ended");
  });

  test("stop transitions a running session to stopped", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const { team_id } = await createTeam({ workspace_dir: dir, name: "Payments" });
    const { agent_id } = await createAgent({
      workspace_dir: dir,
      name: "Worker",
      role: "worker",
      provider: "cmd",
      team_id
    });
    const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });
    const { run_id } = await createRun({ workspace_dir: dir, project_id, agent_id, provider: "cmd" });

    const launched = await launchSession({
      workspace_dir: dir,
      project_id,
      run_id,
      argv: [process.execPath, "-e", "setTimeout(() => process.exit(0), 5000);"]
    });

    await sleep(100);
    stopSession(launched.session_ref);
    const terminal = await waitForTerminal(launched.session_ref);
    expect(terminal.status).toBe("stopped");

    const collected = await collectSession(launched.session_ref);
    expect(collected.status).toBe("stopped");

    const runDoc = RunYaml.parse(
      await readYamlFile(path.join(dir, "work/projects", project_id, "runs", run_id, "run.yaml"))
    );
    expect(runDoc.status).toBe("stopped");
  });
});
