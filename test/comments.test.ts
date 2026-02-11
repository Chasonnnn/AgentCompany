import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { initWorkspace } from "../src/workspace/init.js";
import { createTeam } from "../src/org/teams.js";
import { createAgent } from "../src/org/agents.js";
import { createProject } from "../src/work/projects.js";
import { createRun } from "../src/runtime/run.js";
import { createComment, listComments } from "../src/comments/comment.js";
import { readEventsJsonl } from "../src/runtime/run_queries.js";

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-"));
}

describe("comments", () => {
  test("persists comments and emits run event when run target is provided", async () => {
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
    const run = await createRun({
      workspace_dir: dir,
      project_id,
      agent_id,
      provider: "codex"
    });

    const created = await createComment({
      workspace_dir: dir,
      project_id,
      author_id: "human",
      author_role: "manager",
      body: "Please add test evidence before merge.",
      target_agent_id: agent_id,
      target_artifact_id: "art_123",
      target_run_id: run.run_id
    });

    const listed = await listComments({
      workspace_dir: dir,
      project_id,
      target_agent_id: agent_id
    });
    expect(listed.some((c) => c.id === created.comment_id)).toBe(true);

    const eventsPath = path.join(
      dir,
      "work/projects",
      project_id,
      "runs",
      run.run_id,
      "events.jsonl"
    );
    const lines = await readEventsJsonl(eventsPath);
    const commentEvent = lines
      .filter((l): l is { ok: true; event: any } => l.ok)
      .map((l) => l.event)
      .find((ev) => ev.type === "comment.added" && ev.payload?.comment_id === created.comment_id);
    expect(commentEvent).toBeDefined();
  });
});
