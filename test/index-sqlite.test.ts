import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { initWorkspace } from "../src/workspace/init.js";
import { createTeam } from "../src/org/teams.js";
import { createAgent } from "../src/org/agents.js";
import { createProject } from "../src/work/projects.js";
import { createRun } from "../src/runtime/run.js";
import { executeCommandRun } from "../src/runtime/execute_command.js";
import { proposeMemoryDelta } from "../src/memory/propose_memory_delta.js";
import { approveMemoryDelta } from "../src/memory/approve_memory_delta.js";
import { createHelpRequestFile } from "../src/help/help_request_files.js";
import {
  rebuildSqliteIndex,
  listIndexedRuns,
  listIndexedEvents,
  listIndexedEventParseErrors,
  listIndexedReviews,
  listIndexedHelpRequests,
  readIndexStats,
  indexDbPath
} from "../src/index/sqlite.js";

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-"));
}

describe("sqlite index cache", () => {
  test("rebuild indexes runs/events/reviews/help requests from canonical store", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });

    const { team_id } = await createTeam({ workspace_dir: dir, name: "Payments" });
    const { agent_id: workerId } = await createAgent({
      workspace_dir: dir,
      name: "Payments Worker",
      role: "worker",
      provider: "codex",
      team_id
    });
    const { agent_id: managerId } = await createAgent({
      workspace_dir: dir,
      name: "Payments Manager",
      role: "manager",
      provider: "codex",
      team_id
    });
    const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });

    const { run_id, context_pack_id } = await createRun({
      workspace_dir: dir,
      project_id,
      agent_id: workerId,
      provider: "codex"
    });
    await executeCommandRun({
      workspace_dir: dir,
      project_id,
      run_id,
      argv: [process.execPath, "-e", "console.log('index-me')"]
    });

    const delta = await proposeMemoryDelta({
      workspace_dir: dir,
      project_id,
      title: "Record policy choice",
      under_heading: "## Decisions",
      insert_lines: ["- Require approval records for curated memory updates."],
      visibility: "managers",
      produced_by: managerId,
      run_id,
      context_pack_id
    });
    await approveMemoryDelta({
      workspace_dir: dir,
      project_id,
      artifact_id: delta.artifact_id,
      actor_id: managerId,
      actor_role: "manager",
      actor_team_id: team_id,
      notes: "approved in test"
    });

    await createHelpRequestFile(dir, {
      title: "Need review on workplan dependencies",
      visibility: "managers",
      requester: managerId,
      target_manager: managerId,
      project_id
    });

    const rebuilt = await rebuildSqliteIndex(dir);
    expect(rebuilt.runs_indexed).toBeGreaterThanOrEqual(1);
    expect(rebuilt.events_indexed).toBeGreaterThanOrEqual(1);
    expect(rebuilt.reviews_indexed).toBeGreaterThanOrEqual(1);
    expect(rebuilt.help_requests_indexed).toBeGreaterThanOrEqual(1);

    await fs.access(indexDbPath(dir));

    const runs = await listIndexedRuns({ workspace_dir: dir, project_id });
    expect(runs.some((r) => r.run_id === run_id)).toBe(true);

    const events = await listIndexedEvents({
      workspace_dir: dir,
      project_id,
      run_id,
      limit: 500
    });
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.some((e) => e.type === "run.started")).toBe(true);

    const reviews = await listIndexedReviews({ workspace_dir: dir, project_id });
    expect(reviews.some((r) => r.subject_kind === "memory_delta")).toBe(true);

    const helps = await listIndexedHelpRequests({ workspace_dir: dir, project_id });
    expect(helps.length).toBeGreaterThanOrEqual(1);

    const stats = await readIndexStats(dir);
    expect(stats.runs).toBeGreaterThanOrEqual(1);
    expect(stats.events).toBeGreaterThanOrEqual(1);
    expect(stats.reviews).toBeGreaterThanOrEqual(1);
    expect(stats.help_requests).toBeGreaterThanOrEqual(1);
  });

  test("rebuild tolerates malformed event lines and records parse errors", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const { team_id } = await createTeam({ workspace_dir: dir, name: "Payments" });
    const { agent_id } = await createAgent({
      workspace_dir: dir,
      name: "Worker",
      role: "worker",
      provider: "codex",
      team_id
    });
    const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });
    const { run_id } = await createRun({
      workspace_dir: dir,
      project_id,
      agent_id,
      provider: "codex"
    });
    const eventsPath = path.join(dir, "work/projects", project_id, "runs", run_id, "events.jsonl");
    await fs.appendFile(eventsPath, "{not-json}\n", { encoding: "utf8" });

    const rebuilt = await rebuildSqliteIndex(dir);
    expect(rebuilt.event_parse_errors).toBeGreaterThanOrEqual(1);

    const errors = await listIndexedEventParseErrors({
      workspace_dir: dir,
      project_id,
      run_id
    });
    expect(errors.length).toBeGreaterThanOrEqual(1);

    const stats = await readIndexStats(dir);
    expect(stats.event_parse_errors).toBeGreaterThanOrEqual(1);
  });
});
