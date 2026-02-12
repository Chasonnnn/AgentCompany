import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { initWorkspace } from "../src/workspace/init.js";
import { createTeam } from "../src/org/teams.js";
import { createAgent } from "../src/org/agents.js";
import { createProject } from "../src/work/projects.js";
import { createRun } from "../src/runtime/run.js";
import { appendEventJsonl, newEnvelope, resetEventStateForTests } from "../src/runtime/events.js";
import { replayRun } from "../src/runtime/replay.js";
import { listIndexedEventParseErrors, syncSqliteIndex } from "../src/index/sqlite.js";
import { writeFileAtomic } from "../src/store/fs.js";

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-"));
}

describe("crash consistency", () => {
  test("recovers from stale workspace lock metadata left by a crashed writer", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });

    const lockDir = path.join(dir, ".local", "locks");
    const lockPath = path.join(lockDir, "workspace.write.lock");
    await fs.mkdir(lockDir, { recursive: true });
    await fs.writeFile(
      lockPath,
      `${JSON.stringify({ pid: 2147483647, acquired_at: new Date(0).toISOString() })}\n`,
      { encoding: "utf8" }
    );
    const stale = new Date(Date.now() - 5 * 60 * 1000);
    await fs.utimes(lockPath, stale, stale);

    const policyPath = path.join(dir, "company", "policy.yaml");
    await writeFileAtomic(policyPath, "schema_version: 1\n");
    const saved = await fs.readFile(policyPath, { encoding: "utf8" });
    expect(saved.includes("schema_version: 1")).toBe(true);

    const lockExists = await fs
      .access(lockPath)
      .then(() => true)
      .catch(() => false);
    expect(lockExists).toBe(false);
  });

  test("restarts cleanly after malformed tail event lines and keeps replay/index usable", async () => {
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

    const eventsPath = path.join(dir, "work/projects", project_id, "runs", run_id, "events.jsonl");
    await appendEventJsonl(
      eventsPath,
      newEnvelope({
        schema_version: 1,
        ts_wallclock: new Date().toISOString(),
        run_id,
        session_ref: `local_${run_id}`,
        actor: "system",
        visibility: "org",
        type: "provider.raw",
        payload: { chunk: "first" }
      })
    );

    // Simulate a crash while writing the trailing event line (partial JSON fragment).
    await fs.appendFile(eventsPath, '{"schema_version":1,"type":"broken"\n', { encoding: "utf8" });

    // Simulate process restart: clear in-memory hash-chain caches before next append.
    resetEventStateForTests();

    await appendEventJsonl(
      eventsPath,
      newEnvelope({
        schema_version: 1,
        ts_wallclock: new Date().toISOString(),
        run_id,
        session_ref: `local_${run_id}`,
        actor: "system",
        visibility: "org",
        type: "provider.raw",
        payload: { chunk: "second" }
      })
    );

    const replay = await replayRun({
      workspace_dir: dir,
      project_id,
      run_id,
      mode: "verified"
    });
    expect(replay.parse_issues.length).toBeGreaterThan(0);
    expect(replay.verification_issues).toEqual([]);
    expect(replay.events.some((e) => e.type === "provider.raw" && e.payload?.chunk === "second")).toBe(
      true
    );

    await syncSqliteIndex(dir);
    const parseErrors = await listIndexedEventParseErrors({
      workspace_dir: dir,
      project_id,
      run_id
    });
    expect(parseErrors.length).toBeGreaterThan(0);
  });
});
