import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { initWorkspace } from "../src/workspace/init.js";
import { createTeam } from "../src/org/teams.js";
import { createAgent } from "../src/org/agents.js";
import { createProject } from "../src/work/projects.js";
import { createRun } from "../src/runtime/run.js";
import { replayRun } from "../src/runtime/replay.js";

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-"));
}

describe("run replay modes", () => {
  test("verified mode returns hash-chain verification for canonical events", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const { team_id } = await createTeam({ workspace_dir: dir, name: "Platform" });
    const { agent_id } = await createAgent({
      workspace_dir: dir,
      name: "Worker",
      role: "worker",
      provider: "cmd",
      team_id
    });
    const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });
    const run = await createRun({
      workspace_dir: dir,
      project_id,
      agent_id,
      provider: "cmd"
    });

    const replay = await replayRun({
      workspace_dir: dir,
      project_id,
      run_id: run.run_id,
      mode: "verified"
    });
    expect(replay.mode).toBe("verified");
    expect(replay.events.length).toBeGreaterThan(0);
    expect(replay.parse_issues).toEqual([]);
    expect(replay.verification_issues).toEqual([]);
  });

  test("deterministic mode reports deterministic_ok for canonical events", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const { team_id } = await createTeam({ workspace_dir: dir, name: "Platform" });
    const { agent_id } = await createAgent({
      workspace_dir: dir,
      name: "Worker",
      role: "worker",
      provider: "cmd",
      team_id
    });
    const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });
    const run = await createRun({
      workspace_dir: dir,
      project_id,
      agent_id,
      provider: "cmd"
    });

    const replay = await replayRun({
      workspace_dir: dir,
      project_id,
      run_id: run.run_id,
      mode: "deterministic"
    });
    expect(replay.mode).toBe("deterministic");
    expect(replay.deterministic_ok).toBe(true);
    expect(replay.live.available).toBe(false);
  });

  test("verified mode reports verification issues for malformed-but-parseable events", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const { team_id } = await createTeam({ workspace_dir: dir, name: "Platform" });
    const { agent_id } = await createAgent({
      workspace_dir: dir,
      name: "Worker",
      role: "worker",
      provider: "cmd",
      team_id
    });
    const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });
    const run = await createRun({
      workspace_dir: dir,
      project_id,
      agent_id,
      provider: "cmd"
    });

    const eventsPath = path.join(
      dir,
      "work/projects",
      project_id,
      "runs",
      run.run_id,
      "events.jsonl"
    );
    await fs.appendFile(
      eventsPath,
      `${JSON.stringify({
        schema_version: 1,
        ts_wallclock: new Date().toISOString(),
        ts_monotonic_ms: 2,
        run_id: run.run_id,
        session_ref: `local_${run.run_id}`,
        actor: "system",
        visibility: "org",
        type: "run.note",
        payload: { text: "legacy event without hash fields" }
      })}\n`,
      { encoding: "utf8" }
    );

    const replay = await replayRun({
      workspace_dir: dir,
      project_id,
      run_id: run.run_id,
      mode: "verified"
    });
    expect(replay.parse_issues).toEqual([]);
    expect(replay.verification_issues.some((i) => i.code === "missing_key")).toBe(true);
  });

  test("reports parse issues for malformed JSON lines", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const { team_id } = await createTeam({ workspace_dir: dir, name: "Platform" });
    const { agent_id } = await createAgent({
      workspace_dir: dir,
      name: "Worker",
      role: "worker",
      provider: "cmd",
      team_id
    });
    const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });
    const run = await createRun({
      workspace_dir: dir,
      project_id,
      agent_id,
      provider: "cmd"
    });

    const eventsPath = path.join(
      dir,
      "work/projects",
      project_id,
      "runs",
      run.run_id,
      "events.jsonl"
    );
    await fs.appendFile(eventsPath, "{\"schema_version\":1,", { encoding: "utf8" });

    const replay = await replayRun({
      workspace_dir: dir,
      project_id,
      run_id: run.run_id,
      mode: "raw"
    });
    expect(replay.parse_issues.length).toBeGreaterThan(0);
  });

  test("live mode includes live session metadata when available", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const { team_id } = await createTeam({ workspace_dir: dir, name: "Platform" });
    const { agent_id } = await createAgent({
      workspace_dir: dir,
      name: "Worker",
      role: "worker",
      provider: "cmd",
      team_id
    });
    const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });
    const run = await createRun({
      workspace_dir: dir,
      project_id,
      agent_id,
      provider: "cmd"
    });

    const replay = await replayRun({
      workspace_dir: dir,
      project_id,
      run_id: run.run_id,
      mode: "live"
    });
    expect(replay.mode).toBe("live");
    expect(typeof replay.live.available).toBe("boolean");
  });
});
