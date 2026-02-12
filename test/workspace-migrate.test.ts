import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { initWorkspace } from "../src/workspace/init.js";
import { createTeam } from "../src/org/teams.js";
import { createAgent } from "../src/org/agents.js";
import { createProject } from "../src/work/projects.js";
import { createRun } from "../src/runtime/run.js";
import { migrateWorkspace } from "../src/workspace/migrate.js";

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-"));
}

describe("workspace migration", () => {
  test("dry-run reports legacy event envelope changes without writing", async () => {
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
    const { run_id } = await createRun({
      workspace_dir: dir,
      project_id,
      agent_id,
      provider: "cmd"
    });

    const eventsPath = path.join(dir, "work/projects", project_id, "runs", run_id, "events.jsonl");
    await fs.appendFile(
      eventsPath,
      `${JSON.stringify({
        schema_version: 1,
        ts_wallclock: new Date().toISOString(),
        run_id,
        session_ref: `local_${run_id}`,
        actor: "system",
        visibility: "org",
        type: "run.note",
        payload: { note: "legacy-line" }
      })}\n`,
      { encoding: "utf8" }
    );

    const before = await fs.readFile(eventsPath, { encoding: "utf8" });
    const res = await migrateWorkspace({ workspace_dir: dir, dry_run: true });
    const after = await fs.readFile(eventsPath, { encoding: "utf8" });

    expect(res.dry_run).toBe(true);
    expect(res.files_updated).toBeGreaterThan(0);
    expect(res.events_rewritten).toBeGreaterThan(0);
    expect(after).toBe(before);
  });

  test("apply rewrites legacy events and records migration state", async () => {
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
    const { run_id } = await createRun({
      workspace_dir: dir,
      project_id,
      agent_id,
      provider: "cmd"
    });

    const eventsPath = path.join(dir, "work/projects", project_id, "runs", run_id, "events.jsonl");
    await fs.appendFile(
      eventsPath,
      `${JSON.stringify({
        schema_version: 1,
        ts_wallclock: new Date().toISOString(),
        run_id,
        session_ref: `local_${run_id}`,
        actor: "system",
        visibility: "org",
        type: "run.note",
        payload: { note: "legacy-line" }
      })}\n`,
      { encoding: "utf8" }
    );

    const res = await migrateWorkspace({ workspace_dir: dir });
    expect(res.applied).toBe(true);
    expect(res.files_updated).toBeGreaterThan(0);

    const migratedLines = (await fs.readFile(eventsPath, { encoding: "utf8" }))
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const last = migratedLines[migratedLines.length - 1];
    expect(typeof last.event_id).toBe("string");
    expect(typeof last.event_hash).toBe("string");
    expect(last).toHaveProperty("correlation_id");
    expect(last).toHaveProperty("causation_id");

    const statePath = path.join(dir, "company", "migrations", "applied.yaml");
    const stateRaw = await fs.readFile(statePath, { encoding: "utf8" });
    expect(stateRaw.includes("workspace_migration_state")).toBe(true);
    expect(stateRaw.includes("2026-02-12-event-envelope-v1-backfill")).toBe(true);
  });
});
