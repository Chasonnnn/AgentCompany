import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { initWorkspace } from "../src/workspace/init.js";
import { createTeam } from "../src/org/teams.js";
import { createAgent } from "../src/org/agents.js";
import { createProject } from "../src/work/projects.js";
import { newArtifactMarkdown } from "../src/artifacts/markdown.js";
import { createRun } from "../src/runtime/run.js";
import { proposeMemoryDelta } from "../src/memory/propose_memory_delta.js";
import { routeRpcMethod } from "../src/server/router.js";

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-"));
}

describe("server router", () => {
  test("workspace.open and run.create/run.list route to core modules", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });

    const opened = await routeRpcMethod("workspace.open", { workspace_dir: dir });
    expect((opened as any).workspace_dir).toBe(dir);
    expect((opened as any).valid).toBe(true);

    const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });
    const { team_id } = await createTeam({ workspace_dir: dir, name: "Payments" });
    const { agent_id } = await createAgent({
      workspace_dir: dir,
      name: "Worker",
      role: "worker",
      provider: "cmd",
      team_id
    });

    const run = (await routeRpcMethod("run.create", {
      workspace_dir: dir,
      project_id,
      agent_id,
      provider: "cmd"
    })) as any;
    expect(typeof run.run_id).toBe("string");
    expect(run.run_id.startsWith("run_")).toBe(true);

    const runs = (await routeRpcMethod("run.list", {
      workspace_dir: dir,
      project_id
    })) as any[];
    expect(runs.some((r) => r.run_id === run.run_id)).toBe(true);

    const rebuilt = (await routeRpcMethod("index.rebuild", {
      workspace_dir: dir
    })) as any;
    expect(rebuilt.runs_indexed).toBeGreaterThanOrEqual(1);

    const synced = (await routeRpcMethod("index.sync", {
      workspace_dir: dir
    })) as any;
    expect(typeof synced.db_path).toBe("string");

    const indexedRuns = (await routeRpcMethod("index.list_runs", {
      workspace_dir: dir,
      project_id
    })) as any[];
    expect(indexedRuns.some((r) => r.run_id === run.run_id)).toBe(true);

    const indexedEvents = (await routeRpcMethod("index.list_events", {
      workspace_dir: dir,
      project_id,
      run_id: run.run_id,
      limit: 100
    })) as any[];
    expect(indexedEvents.some((e) => e.type === "run.started")).toBe(true);

    const workerStatus = (await routeRpcMethod("index.sync_worker_status", {})) as any;
    expect(typeof workerStatus.enabled).toBe("boolean");
    expect(typeof workerStatus.pending_workspaces).toBe("number");

    const workerFlush = (await routeRpcMethod("index.sync_worker_flush", {})) as any;
    expect(typeof workerFlush.enabled).toBe("boolean");
  });

  test("adapter.status returns codex/claude adapter states", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const adapters = (await routeRpcMethod("adapter.status", {
      workspace_dir: dir
    })) as any[];
    const names = adapters.map((a) => a.name);
    expect(names).toContain("codex_app_server");
    expect(names).toContain("codex_cli");
    expect(names).toContain("claude_cli");
  });

  test("session.list returns an array", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const sessions = await routeRpcMethod("session.list", { workspace_dir: dir });
    expect(Array.isArray(sessions)).toBe(true);
  });

  test("workspace.doctor returns summary checks", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const doctor = (await routeRpcMethod("workspace.doctor", {
      workspace_dir: dir,
      sync_index: true
    })) as any;
    expect(typeof doctor.ok).toBe("boolean");
    expect(Array.isArray(doctor.checks)).toBe(true);
    expect(doctor.summary).toBeDefined();
  });

  test("monitor.snapshot returns rows list", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const monitor = (await routeRpcMethod("monitor.snapshot", {
      workspace_dir: dir
    })) as any;
    expect(Array.isArray(monitor.rows)).toBe(true);
    expect(typeof monitor.index_rebuilt).toBe("boolean");
    expect(typeof monitor.index_synced).toBe("boolean");
  });

  test("inbox.snapshot and ui.snapshot return thin UI payloads", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });

    const inbox = (await routeRpcMethod("inbox.snapshot", {
      workspace_dir: dir
    })) as any;
    expect(Array.isArray(inbox.pending)).toBe(true);
    expect(Array.isArray(inbox.recent_decisions)).toBe(true);
    expect(typeof inbox.parse_errors?.has_parse_errors).toBe("boolean");

    const ui = (await routeRpcMethod("ui.snapshot", {
      workspace_dir: dir
    })) as any;
    expect(typeof ui.index_sync_worker.enabled).toBe("boolean");
    expect(Array.isArray(ui.monitor.rows)).toBe(true);
    expect(Array.isArray(ui.review_inbox.pending)).toBe(true);
  });

  test("ui.resolve returns decision result and refreshed snapshot", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const { team_id } = await createTeam({ workspace_dir: dir, name: "Payments" });
    const { agent_id } = await createAgent({
      workspace_dir: dir,
      name: "Manager",
      role: "manager",
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
    const proposed = await proposeMemoryDelta({
      workspace_dir: dir,
      project_id,
      title: "Router Resolve",
      under_heading: "## Decisions",
      insert_lines: ["- denied via ui.resolve test"],
      visibility: "managers",
      produced_by: agent_id,
      run_id: run.run_id,
      context_pack_id: run.context_pack_id
    });

    const res = (await routeRpcMethod("ui.resolve", {
      workspace_dir: dir,
      project_id,
      artifact_id: proposed.artifact_id,
      decision: "denied",
      actor_id: agent_id,
      actor_role: "manager",
      actor_team_id: team_id
    })) as any;
    expect(res.resolved.artifact_id).toBe(proposed.artifact_id);
    expect(res.resolved.decision).toBe("denied");
    expect(Array.isArray(res.snapshot.review_inbox.pending)).toBe(true);
    expect(
      res.snapshot.review_inbox.pending.some((p: any) => p.artifact_id === proposed.artifact_id)
    ).toBe(false);
  });

  test("comment.add and comment.list route to persisted comment store", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const { team_id } = await createTeam({ workspace_dir: dir, name: "Platform" });
    const { agent_id } = await createAgent({
      workspace_dir: dir,
      name: "Manager",
      role: "manager",
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

    const added = (await routeRpcMethod("comment.add", {
      workspace_dir: dir,
      project_id,
      author_id: agent_id,
      author_role: "manager",
      body: "Please attach test evidence next pass.",
      target_agent_id: agent_id,
      target_run_id: run.run_id,
      visibility: "managers"
    })) as any;
    expect(typeof added.comment_id).toBe("string");
    expect(added.comment?.target?.agent_id).toBe(agent_id);

    const listed = (await routeRpcMethod("comment.list", {
      workspace_dir: dir,
      project_id,
      target_agent_id: agent_id
    })) as any[];
    expect(Array.isArray(listed)).toBe(true);
    expect(
      listed.some((c) => c.id === added.comment_id && c.body === "Please attach test evidence next pass.")
    ).toBe(true);

    const listedByRun = (await routeRpcMethod("comment.list", {
      workspace_dir: dir,
      project_id,
      target_run_id: run.run_id,
      limit: 50
    })) as any[];
    expect(Array.isArray(listedByRun)).toBe(true);
    expect(listedByRun.some((c) => c.id === added.comment_id)).toBe(true);
  });

  test("agent.refresh_context updates agent guidance context index", async () => {
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

    const res = (await routeRpcMethod("agent.refresh_context", {
      workspace_dir: dir,
      agent_id
    })) as any;
    expect(res.agent_id).toBe(agent_id);
    expect(typeof res.agents_md_relpath).toBe("string");
    expect(typeof res.reference_count).toBe("number");
  });

  test("artifact.read returns artifact content when policy allows", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });
    const artifactId = "art_router_read";
    const md = newArtifactMarkdown({
      type: "proposal",
      id: artifactId,
      title: "Router Artifact",
      visibility: "org",
      produced_by: "human",
      run_id: "run_manual",
      context_pack_id: "ctx_manual"
    });
    await fs.writeFile(
      path.join(dir, "work/projects", project_id, "artifacts", `${artifactId}.md`),
      md,
      { encoding: "utf8" }
    );
    const res = (await routeRpcMethod("artifact.read", {
      workspace_dir: dir,
      project_id,
      artifact_id: artifactId,
      actor_id: "human",
      actor_role: "human"
    })) as any;
    expect(res.artifact_id).toBe(artifactId);
    expect(typeof res.markdown).toBe("string");
  });
});
