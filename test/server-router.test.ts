import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { initWorkspace } from "../src/workspace/init.js";
import { createTeam } from "../src/org/teams.js";
import { createAgent } from "../src/org/agents.js";
import { createProject } from "../src/work/projects.js";
import { newArtifactMarkdown } from "../src/artifacts/markdown.js";
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

    const ui = (await routeRpcMethod("ui.snapshot", {
      workspace_dir: dir
    })) as any;
    expect(Array.isArray(ui.monitor.rows)).toBe(true);
    expect(Array.isArray(ui.review_inbox.pending)).toBe(true);
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
