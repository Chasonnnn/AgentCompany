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
import { createSharePack } from "../src/share/share_pack.js";
import { routeRpcMethod } from "../src/server/router.js";
import { readMachineConfig, setProviderBin } from "../src/machine/machine.js";

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

  test("workspace.repo_root.set stores repo mapping for git folder", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const repoDir = path.join(dir, "repo-main");
    await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });

    const out = (await routeRpcMethod("workspace.repo_root.set", {
      workspace_dir: dir,
      repo_id: "repo_main",
      repo_path: repoDir
    })) as any;

    expect(out.repo_id).toBe("repo_main");
    expect(out.repo_path).toBe(repoDir);
    const machine = await readMachineConfig(dir);
    expect(machine.repo_roots.repo_main).toBe(repoDir);
  });

  test("workspace.repo_root.set rejects non-git folders by default", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const repoDir = path.join(dir, "not-a-repo");
    await fs.mkdir(repoDir, { recursive: true });

    await expect(
      routeRpcMethod("workspace.repo_root.set", {
        workspace_dir: dir,
        repo_id: "repo_main",
        repo_path: repoDir
      })
    ).rejects.toThrow("does not look like a git repository");
  });

  test("session.list returns an array", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const sessions = await routeRpcMethod("session.list", { workspace_dir: dir });
    expect(Array.isArray(sessions)).toBe(true);
  });

  test("job.submit/poll/collect/list/cancel route to job runner", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const codexBin = path.join(dir, "codex");
    await fs.writeFile(
      codexBin,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "login" && args[1] === "status") {
  process.stdout.write("Auth mode: ChatGPT\\n");
  process.exit(0);
}
let input = "";
process.stdin.on("data", (d) => (input += d.toString("utf8")));
process.stdin.on("end", () => {
  setTimeout(() => {
    process.stdout.write(JSON.stringify({
      status: "succeeded",
      summary: "ok",
      files_changed: [],
      commands_run: [],
      artifacts: [],
      next_actions: [],
      errors: []
    }) + "\\n");
  }, 500);
});
`,
      { encoding: "utf8", mode: 0o755 }
    );
    await setProviderBin(dir, "codex", codexBin);

    const { project_id } = await createProject({ workspace_dir: dir, name: "Proj Jobs" });
    const { team_id } = await createTeam({ workspace_dir: dir, name: "Core" });
    const { agent_id } = await createAgent({
      workspace_dir: dir,
      name: "Worker",
      role: "worker",
      provider: "codex",
      team_id
    });

    const submitted = (await routeRpcMethod("job.submit", {
      job: {
        schema_version: 1,
        type: "job",
        job_id: "job_router_case",
        worker_kind: "codex",
        workspace_dir: dir,
        project_id,
        goal: "ship fix",
        constraints: ["json only"],
        deliverables: ["result"],
        permission_level: "patch",
        context_refs: [{ kind: "note", value: "router test" }],
        worker_agent_id: agent_id
      }
    })) as any;
    expect(submitted.job_id).toBe("job_router_case");

    const listed = (await routeRpcMethod("job.list", {
      workspace_dir: dir,
      project_id
    })) as any[];
    expect(listed.some((j) => j.job_id === "job_router_case")).toBe(true);

    // Poll until terminal status.
    let poll: any;
    const end = Date.now() + 15000;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      poll = (await routeRpcMethod("job.poll", {
        workspace_dir: dir,
        project_id,
        job_id: "job_router_case"
      })) as any;
      if (poll.status !== "queued" && poll.status !== "running") break;
      if (Date.now() > end) throw new Error("Timed out waiting for routed job");
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    expect(poll.status).toBe("completed");

    const collected = (await routeRpcMethod("job.collect", {
      workspace_dir: dir,
      project_id,
      job_id: "job_router_case"
    })) as any;
    expect(collected.result.status).toBe("succeeded");
    expect(collected.manager_digest).toBeDefined();

    const cancelOut = (await routeRpcMethod("job.cancel", {
      workspace_dir: dir,
      project_id,
      job_id: "job_router_case"
    })) as any;
    expect(cancelOut.cancellation_requested).toBe(true);
  });

  test("worktree.cleanup returns retention summary", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const out = (await routeRpcMethod("worktree.cleanup", {
      workspace_dir: dir,
      dry_run: true
    })) as any;
    expect(typeof out.scanned).toBe("number");
    expect(Array.isArray(out.items)).toBe(true);
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

  test("workspace.diagnostics exports a diagnostics bundle", async () => {
    const dir = await mkTmpDir();
    const out = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const diag = (await routeRpcMethod("workspace.diagnostics", {
      workspace_dir: dir,
      out_dir: out,
      sync_index: true
    })) as any;
    expect(typeof diag.bundle_dir).toBe("string");
    const manifestPath = path.join(diag.bundle_dir, diag.files.manifest);
    const manifest = JSON.parse(await fs.readFile(manifestPath, { encoding: "utf8" })) as any;
    expect(manifest.type).toBe("workspace_diagnostics");
  });

  test("workspace.migrate runs migration dry-run", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const res = (await routeRpcMethod("workspace.migrate", {
      workspace_dir: dir,
      dry_run: true
    })) as any;
    expect(res.migration_id).toBe("2026-02-12-event-envelope-v1-backfill");
    expect(res.dry_run).toBe(true);
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

  test("heartbeat config/status/tick methods route through heartbeat service", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });

    const cfgBefore = (await routeRpcMethod("heartbeat.config.get", {
      workspace_dir: dir
    })) as any;
    expect(cfgBefore.enabled).toBe(true);
    expect(cfgBefore.tick_interval_minutes).toBe(20);

    const cfgAfter = (await routeRpcMethod("heartbeat.config.set", {
      workspace_dir: dir,
      tick_interval_minutes: 15,
      top_k_workers: 1
    })) as any;
    expect(cfgAfter.tick_interval_minutes).toBe(15);
    expect(cfgAfter.top_k_workers).toBe(1);

    const status = (await routeRpcMethod("heartbeat.status", {
      workspace_dir: dir
    })) as any;
    expect(status.workspace_dir).toBe(dir);
    expect(status.observed).toBe(true);
    expect(typeof status.runtime.loop_running).toBe("boolean");
    expect(status.config.top_k_workers).toBe(1);

    const tick = (await routeRpcMethod("heartbeat.tick", {
      workspace_dir: dir,
      dry_run: true,
      reason: "router-test"
    })) as any;
    expect(typeof tick.tick_id).toBe("string");
    expect(Array.isArray(tick.candidates)).toBe(true);
    expect(Array.isArray(tick.woken_workers)).toBe(true);
    expect(typeof tick.reports_processed).toBe("number");
  });

  test("sharepack.replay returns bundled run events", async () => {
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
    const artifact = newArtifactMarkdown({
      type: "proposal",
      title: "Share replay",
      visibility: "managers",
      produced_by: agent_id,
      run_id: run.run_id,
      context_pack_id: run.context_pack_id
    });
    await fs.writeFile(
      path.join(dir, "work/projects", project_id, "artifacts", "art_share_replay.md"),
      artifact,
      { encoding: "utf8" }
    );
    await fs.appendFile(
      path.join(dir, "work/projects", project_id, "runs", run.run_id, "events.jsonl"),
      `${JSON.stringify({
        schema_version: 1,
        ts_wallclock: new Date().toISOString(),
        ts_monotonic_ms: 1,
        run_id: run.run_id,
        session_ref: `local_${run.run_id}`,
        actor: agent_id,
        visibility: "managers",
        type: "run.note",
        payload: { text: "shared" }
      })}\n`,
      { encoding: "utf8" }
    );
    const share = await createSharePack({
      workspace_dir: dir,
      project_id,
      created_by: "human"
    });

    const replay = (await routeRpcMethod("sharepack.replay", {
      workspace_dir: dir,
      project_id,
      share_pack_id: share.share_pack_id,
      run_id: run.run_id
    })) as any;
    expect(replay.share_pack_id).toBe(share.share_pack_id);
    expect(Array.isArray(replay.runs)).toBe(true);
    expect(replay.runs).toHaveLength(1);
    expect(Array.isArray(replay.runs[0].events)).toBe(true);
    expect(replay.runs[0].events.length).toBeGreaterThan(0);
  });

  test("run.replay supports verified mode", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const { team_id } = await createTeam({ workspace_dir: dir, name: "Ops" });
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
    const replay = (await routeRpcMethod("run.replay", {
      workspace_dir: dir,
      project_id,
      run_id: run.run_id,
      mode: "verified"
    })) as any;
    expect(replay.mode).toBe("verified");
    expect(Array.isArray(replay.events)).toBe(true);
    expect(Array.isArray(replay.parse_issues)).toBe(true);
    expect(Array.isArray(replay.verification_issues)).toBe(true);
  });

  test("ui.resolve returns decision result and refreshed snapshot", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const { team_id } = await createTeam({ workspace_dir: dir, name: "Payments" });
    const manager = await createAgent({
      workspace_dir: dir,
      name: "Manager",
      role: "manager",
      provider: "codex",
      team_id
    });
    const director = await createAgent({
      workspace_dir: dir,
      name: "Director",
      role: "director",
      provider: "codex",
      team_id
    });
    const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });
    const run = await createRun({
      workspace_dir: dir,
      project_id,
      agent_id: manager.agent_id,
      provider: "codex"
    });
    const proposed = await proposeMemoryDelta({
      workspace_dir: dir,
      project_id,
      title: "Router Resolve",
      scope_kind: "project_memory",
      sensitivity: "internal",
      rationale: "Exercise ui.resolve over governed memory deltas.",
      under_heading: "## Decisions",
      insert_lines: ["- denied via ui.resolve test"],
      visibility: "managers",
      produced_by: manager.agent_id,
      run_id: run.run_id,
      context_pack_id: run.context_pack_id,
      evidence: ["art_evidence_router_ui_resolve"]
    });

    const res = (await routeRpcMethod("ui.resolve", {
      workspace_dir: dir,
      project_id,
      artifact_id: proposed.artifact_id,
      decision: "denied",
      actor_id: director.agent_id,
      actor_role: "director",
      actor_team_id: team_id
    })) as any;
    expect(res.resolved.artifact_id).toBe(proposed.artifact_id);
    expect(res.resolved.decision).toBe("denied");
    expect(Array.isArray(res.snapshot.review_inbox.pending)).toBe(true);
    expect(
      res.snapshot.review_inbox.pending.some((p: any) => p.artifact_id === proposed.artifact_id)
    ).toBe(false);
  });

  test("memory.propose_delta + memory.list_deltas support pending and decided views", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const { team_id } = await createTeam({ workspace_dir: dir, name: "Payments" });
    const manager = await createAgent({
      workspace_dir: dir,
      name: "Manager",
      role: "manager",
      provider: "codex",
      team_id
    });
    const director = await createAgent({
      workspace_dir: dir,
      name: "Director",
      role: "director",
      provider: "codex",
      team_id
    });
    const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });
    const run = await createRun({
      workspace_dir: dir,
      project_id,
      agent_id: manager.agent_id,
      provider: "codex"
    });

    const proposed = (await routeRpcMethod("memory.propose_delta", {
      workspace_dir: dir,
      project_id,
      title: "Router memory proposal",
      scope_kind: "project_memory",
      sensitivity: "internal",
      rationale: "Verify router path for governed memory proposal/list flow.",
      under_heading: "## Decisions",
      insert_lines: ["- added through routeRpcMethod memory.propose_delta"],
      visibility: "managers",
      produced_by: manager.agent_id,
      run_id: run.run_id,
      context_pack_id: run.context_pack_id,
      evidence: ["art_evidence_router_memory"]
    })) as any;
    expect(typeof proposed.artifact_id).toBe("string");

    const pending = (await routeRpcMethod("memory.list_deltas", {
      workspace_dir: dir,
      project_id,
      actor_id: manager.agent_id,
      actor_role: "manager",
      actor_team_id: team_id,
      status: "pending",
      limit: 50
    })) as any;
    expect(Array.isArray(pending.items)).toBe(true);
    expect(typeof pending.filtered_by_policy_count).toBe("number");
    const pendingItem = pending.items.find((i: any) => i.artifact_id === proposed.artifact_id);
    expect(pendingItem?.status).toBe("pending");
    expect(pendingItem?.scope_kind).toBe("project_memory");
    expect(pendingItem?.sensitivity).toBe("internal");

    await routeRpcMethod("memory.approve_delta", {
      workspace_dir: dir,
      project_id,
      artifact_id: proposed.artifact_id,
      actor_id: director.agent_id,
      actor_role: "director",
      actor_team_id: team_id,
      notes: "approved by director in router test"
    });

    const approved = (await routeRpcMethod("memory.list_deltas", {
      workspace_dir: dir,
      project_id,
      actor_id: director.agent_id,
      actor_role: "director",
      actor_team_id: team_id,
      status: "approved",
      limit: 50
    })) as any;
    expect(Array.isArray(approved.items)).toBe(true);
    const approvedItem = approved.items.find((i: any) => i.artifact_id === proposed.artifact_id);
    expect(approvedItem?.status).toBe("approved");
    expect(approvedItem?.decision?.decision).toBe("approved");
    expect(approvedItem?.decision?.actor_role).toBe("director");

    await expect(
      routeRpcMethod("memory.list_deltas", {
        workspace_dir: dir,
        project_id,
        status: "all",
        limit: 50
      })
    ).rejects.toThrow(/actor_id|actor_role|required/i);
  });

  test("system.capabilities returns memory schema + method availability", async () => {
    const capabilities = (await routeRpcMethod("system.capabilities", {})) as any;
    expect(typeof capabilities).toBe("object");
    expect(Array.isArray(capabilities.available_methods)).toBe(true);
    expect(capabilities.available_methods).toContain("system.capabilities");
    expect(capabilities.available_methods).toContain("memory.list_deltas");
    expect(capabilities.memory.write_schema_version).toBe(2);
    expect(capabilities.memory.parse_supported).toEqual([1, 2]);
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
    expect(typeof res.context_index_relpath).toBe("string");
    expect(typeof res.reference_count).toBe("number");
  });

  test("agent.self_improve_cycle records/evaluates and proposes governed AGENTS.md delta", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const { team_id } = await createTeam({ workspace_dir: dir, name: "Payments" });
    const manager = await createAgent({
      workspace_dir: dir,
      name: "Manager",
      role: "manager",
      provider: "codex",
      team_id
    });
    const worker = await createAgent({
      workspace_dir: dir,
      name: "Worker",
      role: "worker",
      provider: "codex",
      team_id
    });
    const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });

    const res = (await routeRpcMethod("agent.self_improve_cycle", {
      workspace_dir: dir,
      project_id,
      worker_agent_id: worker.agent_id,
      manager_actor_id: manager.agent_id,
      manager_role: "manager",
      mistake_key: "missing_patch",
      summary: "Patch artifact missing in prior milestone submission",
      prevention_rule: "Always attach patch artifact id before requesting approval.",
      proposal_threshold: 1,
      evaluation_argv: [process.execPath, "-e", "process.exit(0)"]
    })) as any;

    expect(res.status).toBe("proposal_created");
    expect(typeof res.run_id).toBe("string");
    expect(typeof res.evaluation_artifact_id).toBe("string");
    expect(typeof res.memory_delta_artifact_id).toBe("string");

    const inbox = (await routeRpcMethod("inbox.snapshot", {
      workspace_dir: dir,
      project_id
    })) as any;
    expect(inbox.pending.some((p: any) => p.artifact_id === res.memory_delta_artifact_id)).toBe(true);
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

  test("desktop.bootstrap.snapshot returns scoped payloads for home and conversation views", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const created = (await routeRpcMethod("workspace.project.create_with_defaults", {
      workspace_dir: dir,
      name: "Proj",
      ceo_actor_id: "human_ceo"
    })) as any;

    const workspaceHome = (await routeRpcMethod("desktop.bootstrap.snapshot", {
      workspace_dir: dir,
      actor_id: "human_ceo",
      scope: "workspace",
      view: "home"
    })) as any;
    expect(Array.isArray(workspaceHome.projects)).toBe(true);
    expect(Array.isArray(workspaceHome.agents)).toBe(true);
    expect(Array.isArray(workspaceHome.teams)).toBe(true);
    expect(Array.isArray(workspaceHome.conversations)).toBe(true);
    expect(workspaceHome.view_data.pm.scope).toBe("workspace");

    const projectHome = (await routeRpcMethod("desktop.bootstrap.snapshot", {
      workspace_dir: dir,
      actor_id: "human_ceo",
      scope: "project",
      project_id: created.project_id,
      view: "home"
    })) as any;
    expect(projectHome.scope).toBe("project");
    expect(projectHome.view_data.pm.scope).toBe("project");
    expect(Array.isArray(projectHome.view_data.recommendations)).toBe(true);

    const projectConversations = (await routeRpcMethod("conversation.list", {
      workspace_dir: dir,
      scope: "project",
      project_id: created.project_id
    })) as any[];
    const conversationId = projectConversations[0]?.id;
    expect(typeof conversationId).toBe("string");

    await routeRpcMethod("conversation.message.send", {
      workspace_dir: dir,
      scope: "project",
      project_id: created.project_id,
      conversation_id: conversationId,
      author_id: "human_ceo",
      author_role: "ceo",
      body: "hello from bootstrap test"
    });

    const conversationView = (await routeRpcMethod("desktop.bootstrap.snapshot", {
      workspace_dir: dir,
      actor_id: "human_ceo",
      scope: "project",
      project_id: created.project_id,
      view: "conversation",
      conversation_id: conversationId
    })) as any;
    expect(Array.isArray(conversationView.view_data.messages)).toBe(true);
    expect(conversationView.view_data.messages.some((m: any) => m.body.includes("bootstrap test"))).toBe(true);
  });
});
