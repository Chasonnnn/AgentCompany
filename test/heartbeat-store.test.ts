import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { initWorkspace } from "../src/workspace/init.js";
import {
  heartbeatConfigPath,
  heartbeatStatePath,
  readHeartbeatConfig,
  readHeartbeatState,
  writeHeartbeatConfig,
  writeHeartbeatState,
  updateHeartbeatState
} from "../src/runtime/heartbeat_store.js";

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-heartbeat-"));
}

describe("heartbeat store", () => {
  test("returns defaults when files are missing", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });

    const cfg = await readHeartbeatConfig(dir);
    const st = await readHeartbeatState(dir);

    expect(cfg.enabled).toBe(true);
    expect(cfg.tick_interval_minutes).toBe(20);
    expect(st.running).toBe(false);
    expect(st.stats.ticks_total).toBe(0);
  });

  test("writes and reads config/state", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });

    const cfg = await writeHeartbeatConfig({
      workspace_dir: dir,
      config: {
        enabled: true,
        top_k_workers: 3,
        tick_interval_minutes: 15
      }
    });
    expect(cfg.top_k_workers).toBe(3);

    await writeHeartbeatState({
      workspace_dir: dir,
      state: {
        schema_version: 1,
        type: "heartbeat_state",
        running: false,
        stats: {
          ticks_total: 4,
          workers_woken_total: 2,
          reports_ok_total: 1,
          reports_actions_total: 1,
          actions_executed_total: 2,
          approvals_queued_total: 1,
          deduped_actions_total: 0
        },
        run_event_cursors: { "proj_1::run_1": 9 },
        worker_state: {},
        idempotency: {},
        hourly_action_counters: {}
      }
    });

    const cfgRead = await readHeartbeatConfig(dir);
    const stRead = await readHeartbeatState(dir);
    expect(cfgRead.tick_interval_minutes).toBe(15);
    expect(stRead.stats.ticks_total).toBe(4);
    expect(stRead.run_event_cursors["proj_1::run_1"]).toBe(9);

    const cfgPath = heartbeatConfigPath(dir);
    const stPath = heartbeatStatePath(dir);
    await fs.access(cfgPath);
    await fs.access(stPath);
  });

  test("updateHeartbeatState persists mutations", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });

    const after = await updateHeartbeatState({
      workspace_dir: dir,
      mutate: (state) => ({
        ...state,
        stats: {
          ...state.stats,
          ticks_total: state.stats.ticks_total + 1
        }
      })
    });

    expect(after.stats.ticks_total).toBe(1);
    const read = await readHeartbeatState(dir);
    expect(read.stats.ticks_total).toBe(1);
  });
});
