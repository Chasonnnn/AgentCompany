import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { initWorkspace } from "../src/workspace/init.js";
import { createTeam } from "../src/org/teams.js";
import { createAgent } from "../src/org/agents.js";
import { createProject } from "../src/work/projects.js";
import { createRun } from "../src/runtime/run.js";
import {
  launchSession,
  pollSession,
  collectSession,
  stopSession,
  listSessions,
  resetSessionStateForTests
} from "../src/runtime/session.js";
import { readYamlFile, writeYamlFile } from "../src/store/yaml.js";
import { RunYaml } from "../src/schemas/run.js";

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-"));
}

async function readJsonl(filePath: string): Promise<any[]> {
  const s = await fs.readFile(filePath, { encoding: "utf8" });
  return s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTerminal(
  sessionRef: string,
  workspaceDir?: string,
  timeoutMs: number = 5000
): Promise<Awaited<ReturnType<typeof pollSession>>> {
  const end = Date.now() + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const p = await pollSession(sessionRef, { workspace_dir: workspaceDir });
    if (p.status !== "running") return p;
    if (Date.now() > end) throw new Error(`Timed out waiting for session: ${sessionRef}`);
    await sleep(30);
  }
}

function sessionRecordPath(workspaceDir: string, sessionRef: string): string {
  return path.join(workspaceDir, ".local", "sessions", `${encodeURIComponent(sessionRef)}.yaml`);
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
    expect(["running", "ended"]).toContain((await pollSession(launched.session_ref)).status);

    const terminal = await waitForTerminal(launched.session_ref, dir);
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

  test("policy gate blocks cross-team worker launch attempts and marks run failed", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const { team_id: teamA } = await createTeam({ workspace_dir: dir, name: "Payments" });
    const { team_id: teamB } = await createTeam({ workspace_dir: dir, name: "Infra" });
    const { agent_id } = await createAgent({
      workspace_dir: dir,
      name: "Worker A",
      role: "worker",
      provider: "cmd",
      team_id: teamA
    });
    const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });
    const { run_id } = await createRun({ workspace_dir: dir, project_id, agent_id, provider: "cmd" });

    await expect(
      launchSession({
        workspace_dir: dir,
        project_id,
        run_id,
        argv: [process.execPath, "-e", "process.stdout.write('should-not-run\\n');"],
        actor_id: "worker_b",
        actor_role: "worker",
        actor_team_id: teamB
      })
    ).rejects.toThrow(/policy denied/i);

    const runDoc = RunYaml.parse(
      await readYamlFile(path.join(dir, "work/projects", project_id, "runs", run_id, "run.yaml"))
    );
    expect(runDoc.status).toBe("failed");

    const events = await readJsonl(
      path.join(dir, "work/projects", project_id, "runs", run_id, "events.jsonl")
    );
    expect(events.some((e) => e.type === "policy.denied")).toBe(true);
    expect(
      events.some(
        (e) =>
          e.type === "run.failed" &&
          e.payload?.preflight === true &&
          e.payload?.reason === "policy_denied"
      )
    ).toBe(true);
  });

  test("budget preflight gate blocks launch when project hard limit is already exceeded", async () => {
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

    const projectPath = path.join(dir, "work/projects", project_id, "project.yaml");
    const projectDoc = await readYamlFile(projectPath);
    await writeYamlFile(projectPath, {
      ...projectDoc,
      budget: {
        hard_cost_usd: 0.01
      }
    });

    const prior = await createRun({ workspace_dir: dir, project_id, agent_id, provider: "cmd" });
    const priorPath = path.join(dir, "work/projects", project_id, "runs", prior.run_id, "run.yaml");
    const priorDoc = RunYaml.parse(await readYamlFile(priorPath));
    await writeYamlFile(priorPath, {
      ...priorDoc,
      status: "ended",
      ended_at: new Date().toISOString(),
      usage: {
        source: "estimated_chars",
        confidence: "low",
        estimate_method: "fixture",
        total_tokens: 5000,
        cost_usd: 0.05,
        cost_currency: "USD",
        cost_source: "no_rate_card"
      }
    });

    const { run_id } = await createRun({ workspace_dir: dir, project_id, agent_id, provider: "cmd" });

    await expect(
      launchSession({
        workspace_dir: dir,
        project_id,
        run_id,
        argv: [process.execPath, "-e", "process.stdout.write('should-not-run\\n');"]
      })
    ).rejects.toThrow(/budget preflight blocked launch/i);

    const runDoc = RunYaml.parse(
      await readYamlFile(path.join(dir, "work/projects", project_id, "runs", run_id, "run.yaml"))
    );
    expect(runDoc.status).toBe("failed");

    const events = await readJsonl(
      path.join(dir, "work/projects", project_id, "runs", run_id, "events.jsonl")
    );
    expect(
      events.some(
        (e) =>
          e.type === "budget.exceeded" &&
          e.payload?.scope === "project" &&
          e.payload?.phase === "preflight"
      )
    ).toBe(true);
    expect(
      events.some(
        (e) =>
          e.type === "run.failed" &&
          e.payload?.preflight === true &&
          e.payload?.reason === "budget_preflight_exceeded"
      )
    ).toBe(true);
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
    await stopSession(launched.session_ref);
    const terminal = await waitForTerminal(launched.session_ref, dir);
    expect(terminal.status).toBe("stopped");

    const collected = await collectSession(launched.session_ref);
    expect(collected.status).toBe("stopped");

    const runDoc = RunYaml.parse(
      await readYamlFile(path.join(dir, "work/projects", project_id, "runs", run_id, "run.yaml"))
    );
    expect(runDoc.status).toBe("stopped");
  });

  test("listSessions supports workspace and status filters", async () => {
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
      argv: [process.execPath, "-e", "setTimeout(() => process.exit(0), 2000);"]
    });

    await sleep(60);
    const running = await listSessions({ workspace_dir: dir, status: "running" });
    expect(running.some((s) => s.session_ref === launched.session_ref)).toBe(true);

    await stopSession(launched.session_ref);
    await waitForTerminal(launched.session_ref, dir);

    const stopped = await listSessions({ workspace_dir: dir, status: "stopped" });
    expect(stopped.some((s) => s.session_ref === launched.session_ref)).toBe(true);
  });

  test("persisted sessions remain queryable after in-memory reset", async () => {
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
      argv: [process.execPath, "-e", "process.stdout.write('persist\\n');"]
    });
    await waitForTerminal(launched.session_ref, dir);

    resetSessionStateForTests();

    const polled = await pollSession(launched.session_ref, { workspace_dir: dir });
    expect(polled.status).toBe("ended");

    const listed = await listSessions({ workspace_dir: dir, run_id });
    expect(listed.some((s) => s.session_ref === launched.session_ref)).toBe(true);

    const collected = await collectSession(launched.session_ref, { workspace_dir: dir });
    expect(collected.output_relpaths.some((p) => p.endsWith("stdout.txt"))).toBe(true);
  });

  test(
    "detached running sessions can be stopped via persisted control metadata",
    async () => {
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
        argv: [process.execPath, "-e", "setInterval(() => process.stdout.write('tick\\n'), 200);"]
      });

      await sleep(120);
      resetSessionStateForTests();

      const stopResult = await stopSession(launched.session_ref, { workspace_dir: dir });
      expect(["running", "stopped", "failed"]).toContain(stopResult.status);

      const terminal = await waitForTerminal(launched.session_ref, dir, 15000);
      expect(terminal.status).toBe("stopped");

      const runDoc = RunYaml.parse(
        await readYamlFile(path.join(dir, "work/projects", project_id, "runs", run_id, "run.yaml"))
      );
      expect(runDoc.status).toBe("stopped");
    },
    20000
  );

  test("persisted detached session records include pid fingerprint metadata", async () => {
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
      argv: [process.execPath, "-e", "setInterval(() => process.stdout.write('tick\\n'), 200);"]
    });
    await sleep(120);

    const persisted = (await readYamlFile(sessionRecordPath(dir, launched.session_ref))) as Record<
      string,
      unknown
    >;
    expect(typeof persisted.pid).toBe("number");
    expect(typeof persisted.pid_claimed_at_ms).toBe("number");

    await stopSession(launched.session_ref, { workspace_dir: dir });
    await waitForTerminal(launched.session_ref, dir, 15000);
  });

  test(
    "detached stop refuses stale pid claims to reduce pid reuse risk",
    async () => {
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
        argv: [process.execPath, "-e", "setInterval(() => process.stdout.write('tick\\n'), 200);"]
      });
      await sleep(120);
      resetSessionStateForTests();

      const p = sessionRecordPath(dir, launched.session_ref);
      const rec = (await readYamlFile(p)) as Record<string, unknown>;
      await writeYamlFile(p, {
        ...rec,
        pid_claimed_at_ms: Date.now() - 31 * 60 * 1000
      });

      const stopRes = await stopSession(launched.session_ref, { workspace_dir: dir });
      expect(stopRes.status).toBe("running");
      expect(stopRes.error ?? "").toMatch(/pid may have been reused/i);

      const refreshed = (await readYamlFile(p)) as Record<string, unknown>;
      const pid = refreshed.pid as number;
      process.kill(pid, "SIGKILL");
      await sleep(80);
      const terminal = await waitForTerminal(launched.session_ref, dir, 15000);
      expect(["failed", "stopped"]).toContain(terminal.status);
    },
    10000
  );

  test("reconciles orphaned detached sessions when pid no longer exists", async () => {
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
      argv: [process.execPath, "-e", "setInterval(() => process.stdout.write('tick\\n'), 200);"]
    });

    await sleep(120);
    const persisted = (await readYamlFile(sessionRecordPath(dir, launched.session_ref))) as Record<
      string,
      unknown
    >;
    const pid = persisted.pid as number;
    expect(typeof pid).toBe("number");

    process.kill(pid, "SIGKILL");
    await sleep(80);
    resetSessionStateForTests();

    const polled = await pollSession(launched.session_ref, { workspace_dir: dir });
    expect(polled.status).toBe("failed");
    if (polled.error) {
      expect(polled.error).toMatch(/orphaned detached session/i);
    }

    const runDoc = RunYaml.parse(
      await readYamlFile(path.join(dir, "work/projects", project_id, "runs", run_id, "run.yaml"))
    );
    expect(runDoc.status).toBe("failed");
  });
});
