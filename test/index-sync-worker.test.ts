import { describe, expect, test } from "vitest";
import { createIndexSyncWorker } from "../src/index/sync_worker.js";

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("index sync worker", () => {
  test("debounces bursts into a single sync per workspace", async () => {
    const calls: string[] = [];
    const worker = createIndexSyncWorker({
      sync: async (workspaceDir) => {
        calls.push(workspaceDir);
      },
      debounce_ms: 20,
      min_interval_ms: 0
    });

    worker.notify("/tmp/ws-a");
    worker.notify("/tmp/ws-a");
    worker.notify("/tmp/ws-a");
    await sleep(80);
    await worker.close();

    expect(calls).toEqual(["/tmp/ws-a"]);
  });

  test("flush runs pending work immediately", async () => {
    const calls: string[] = [];
    const worker = createIndexSyncWorker({
      sync: async (workspaceDir) => {
        calls.push(workspaceDir);
      },
      debounce_ms: 1000,
      min_interval_ms: 0
    });
    worker.notify("/tmp/ws-b");
    await worker.flush();
    await worker.close();
    expect(calls).toEqual(["/tmp/ws-b"]);
  });

  test("close prevents future notifications from triggering sync", async () => {
    const calls: string[] = [];
    const worker = createIndexSyncWorker({
      sync: async (workspaceDir) => {
        calls.push(workspaceDir);
      },
      debounce_ms: 5,
      min_interval_ms: 0
    });
    await worker.close();
    worker.notify("/tmp/ws-c");
    await sleep(30);
    expect(calls).toEqual([]);
  });

  test("close flushes pending sync work before shutdown", async () => {
    const calls: string[] = [];
    const worker = createIndexSyncWorker({
      sync: async (workspaceDir) => {
        calls.push(workspaceDir);
      },
      debounce_ms: 1000,
      min_interval_ms: 0
    });
    worker.notify("/tmp/ws-e");
    await worker.close();
    expect(calls).toEqual(["/tmp/ws-e"]);
  });

  test("min_interval throttles successive sync runs", async () => {
    const callTimes: number[] = [];
    const worker = createIndexSyncWorker({
      sync: async () => {
        callTimes.push(Date.now());
      },
      debounce_ms: 1,
      min_interval_ms: 40
    });
    worker.notify("/tmp/ws-d");
    await sleep(20);
    worker.notify("/tmp/ws-d");
    await sleep(120);
    await worker.close();

    expect(callTimes.length).toBeGreaterThanOrEqual(2);
    const delta = callTimes[1]! - callTimes[0]!;
    expect(delta).toBeGreaterThanOrEqual(35);
  });

  test("status reports queue and sync metrics", async () => {
    const worker = createIndexSyncWorker({
      sync: async (workspaceDir) => {
        if (workspaceDir.endsWith("/fail")) throw new Error("boom");
      },
      debounce_ms: 1,
      min_interval_ms: 0
    });

    worker.notify("/tmp/ws-ok");
    worker.notify("/tmp/ws-fail/fail");
    await worker.flush();
    const status = worker.status();
    await worker.close();

    expect(status.closed).toBe(false);
    expect(status.pending_workspaces).toBe(0);
    expect(status.total_notify_calls).toBe(2);
    expect(status.total_batches).toBeGreaterThanOrEqual(1);
    expect(status.total_workspace_sync_attempts).toBe(2);
    expect(status.total_workspace_sync_errors).toBe(1);
    expect(status.last_error_message).toContain("boom");
    expect(status.last_error_workspace).toBe("/tmp/ws-fail/fail");
    expect(status.last_run_at_ms).not.toBeNull();
  });
});
