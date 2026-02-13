import { PassThrough } from "node:stream";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { initWorkspace } from "../src/workspace/init.js";
import { createProject } from "../src/work/projects.js";
import { createTeam } from "../src/org/teams.js";
import { createAgent } from "../src/org/agents.js";
import { createRun } from "../src/runtime/run.js";
import { executeCommandRun } from "../src/runtime/execute_command.js";
import { proposeMemoryDelta } from "../src/memory/propose_memory_delta.js";
import { runJsonRpcServer } from "../src/server/main.js";

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-"));
}

function setupOutputParser(out: PassThrough): {
  waitFor: (pred: (msg: any) => boolean, timeoutMs?: number) => Promise<any>;
} {
  let buf = "";
  const msgs: any[] = [];
  let resolver: ((v: any) => void) | null = null;
  let predicate: ((msg: any) => boolean) | null = null;

  function maybeResolve(msg: any): void {
    if (resolver && predicate && predicate(msg)) {
      const r = resolver;
      resolver = null;
      predicate = null;
      r(msg);
    }
  }

  out.on("data", (chunk: Buffer | string) => {
    buf += chunk.toString();
    while (true) {
      const idx = buf.indexOf("\n");
      if (idx === -1) break;
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      msgs.push(msg);
      maybeResolve(msg);
    }
  });

  return {
    waitFor: (pred, timeoutMs = 5000) => {
      for (const m of msgs) {
        if (pred(m)) return Promise.resolve(m);
      }
      return new Promise((resolve, reject) => {
        predicate = pred;
        resolver = resolve;
        setTimeout(() => {
          if (resolver) {
            resolver = null;
            predicate = null;
            reject(new Error("timeout waiting for server message"));
          }
        }, timeoutMs).unref();
      });
    }
  };
}

function sendReq(input: PassThrough, id: number, method: string, params: unknown): void {
  input.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params
    })}\n`
  );
}

describe("JSON-RPC server", () => {
  test("handles requests and streams events.notification", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });
    const { team_id } = await createTeam({ workspace_dir: dir, name: "Payments" });
    const { agent_id } = await createAgent({
      workspace_dir: dir,
      name: "Worker",
      role: "worker",
      provider: "cmd",
      team_id
    });

    const input = new PassThrough();
    const output = new PassThrough();
    const stderr = new PassThrough();
    const parser = setupOutputParser(output);

    const serverPromise = runJsonRpcServer({
      stdin: input,
      stdout: output,
      stderr
    });

    sendReq(input, 1, "run.create", {
      workspace_dir: dir,
      project_id,
      agent_id,
      provider: "cmd"
    });
    const created = await parser.waitFor((m) => m.id === 1);
    expect(created.result.run_id).toMatch(/^run_/);
    const runId = created.result.run_id as string;

    sendReq(input, 2, "events.subscribe", {
      subscription_id: "sub_test",
      run_id: runId
    });
    const sub = await parser.waitFor((m) => m.id === 2);
    expect(sub.result.subscription_id).toBe("sub_test");

    sendReq(input, 3, "session.launch", {
      workspace_dir: dir,
      project_id,
      run_id: runId,
      argv: [process.execPath, "-e", "setTimeout(() => { console.log('hello') }, 20)"]
    });
    const launched = await parser.waitFor((m) => m.id === 3);
    expect(launched.result.session_ref).toBe(`local_${runId}`);

    const notif = await parser.waitFor(
      (m) => m.method === "events.notification" && m.params?.event?.run_id === runId
    );
    expect(notif.params.subscription_id).toBe("sub_test");
    expect(typeof notif.params.event.type).toBe("string");

    sendReq(input, 4, "session.collect", { session_ref: `local_${runId}` });
    const collected = await parser.waitFor((m) => m.id === 4);
    expect(["ended", "failed", "stopped"]).toContain(collected.result.status);
    expect(collected.result.events_relpath).toBe(`runs/${runId}/events.jsonl`);

    sendReq(input, 5, "index.sync_worker_flush", {});
    const flushed = await parser.waitFor((m) => m.id === 5);
    expect(flushed.result.enabled).toBe(true);
    expect(flushed.result.pending_workspaces).toBe(0);

    sendReq(input, 6, "index.sync_worker_status", {});
    const status = await parser.waitFor((m) => m.id === 6);
    expect(status.result.enabled).toBe(true);
    expect(status.result.total_notify_calls).toBeGreaterThanOrEqual(1);

    input.end();
    await serverPromise;
  });

  test("events.subscribe supports indexed backfill replay", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });
    const { team_id } = await createTeam({ workspace_dir: dir, name: "Payments" });
    const { agent_id } = await createAgent({
      workspace_dir: dir,
      name: "Worker",
      role: "worker",
      provider: "cmd",
      team_id
    });

    const created = await createRun({
      workspace_dir: dir,
      project_id,
      agent_id,
      provider: "cmd"
    });
    const runId = created.run_id;
    await executeCommandRun({
      workspace_dir: dir,
      project_id,
      run_id: runId,
      argv: [process.execPath, "-e", "console.log('backfill')"]
    });

    const input = new PassThrough();
    const output = new PassThrough();
    const stderr = new PassThrough();
    const parser = setupOutputParser(output);

    const serverPromise = runJsonRpcServer({
      stdin: input,
      stdout: output,
      stderr
    });

    sendReq(input, 10, "events.subscribe", {
      subscription_id: "sub_backfill",
      workspace_dir: dir,
      project_id,
      run_id: runId,
      backfill_limit: 20
    });
    const sub = await parser.waitFor((m) => m.id === 10);
    expect(sub.result.subscription_id).toBe("sub_backfill");

    const notif = await parser.waitFor(
      (m) =>
        m.method === "events.notification" &&
        m.params?.subscription_id === "sub_backfill" &&
        m.params?.event?.run_id === runId
    );
    expect(typeof notif.params.event.type).toBe("string");

    input.end();
    await serverPromise;
  });

  test("returns structured SECRET_DETECTED error data for memory approval notes", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });
    const { team_id } = await createTeam({ workspace_dir: dir, name: "Payments" });
    const manager = await createAgent({
      workspace_dir: dir,
      name: "Manager",
      role: "manager",
      provider: "cmd",
      team_id
    });
    const director = await createAgent({
      workspace_dir: dir,
      name: "Director",
      role: "director",
      provider: "cmd",
      team_id
    });
    const run = await createRun({
      workspace_dir: dir,
      project_id,
      agent_id: manager.agent_id,
      provider: "cmd"
    });
    const proposed = await proposeMemoryDelta({
      workspace_dir: dir,
      project_id,
      title: "Structured error data check",
      scope_kind: "project_memory",
      sensitivity: "internal",
      rationale: "Server should return structured secret-detection metadata.",
      under_heading: "## Decisions",
      insert_lines: ["- safe line"],
      visibility: "managers",
      produced_by: manager.agent_id,
      run_id: run.run_id,
      context_pack_id: run.context_pack_id,
      evidence: ["art_evidence_server_main"]
    });

    const input = new PassThrough();
    const output = new PassThrough();
    const stderr = new PassThrough();
    const parser = setupOutputParser(output);
    const serverPromise = runJsonRpcServer({
      stdin: input,
      stdout: output,
      stderr
    });

    sendReq(input, 30, "memory.approve_delta", {
      workspace_dir: dir,
      project_id,
      artifact_id: proposed.artifact_id,
      actor_id: director.agent_id,
      actor_role: "director",
      notes: "contains sk-1234567890abcdefghijklmnopqrs"
    });
    const resp = await parser.waitFor((m) => m.id === 30);
    expect(resp.error).toBeDefined();
    expect(resp.error.message).toMatch(/sensitive|secret|redact/i);
    expect(resp.error.data?.reason_code).toBe("SECRET_DETECTED");
    expect(typeof resp.error.data?.total_matches).toBe("number");
    expect(resp.error.data?.total_matches).toBeGreaterThan(0);
    expect(typeof resp.error.data?.matches_by_kind).toBe("object");

    input.end();
    await serverPromise;
  });
});
