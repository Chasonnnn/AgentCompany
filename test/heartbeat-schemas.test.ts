import { describe, expect, test } from "vitest";
import {
  HeartbeatAction,
  HeartbeatWorkerReport,
  DEFAULT_HEARTBEAT_CONFIG,
  DEFAULT_HEARTBEAT_STATE,
  HeartbeatConfig,
  HeartbeatState
} from "../src/schemas/heartbeat.js";

describe("heartbeat schemas", () => {
  test("accepts HEARTBEAT_OK only for status=ok", () => {
    const ok = HeartbeatWorkerReport.safeParse({
      schema_version: 1,
      type: "heartbeat_worker_report",
      status: "ok",
      token: "HEARTBEAT_OK",
      summary: "No changes"
    });
    expect(ok.success).toBe(true);

    const invalid = HeartbeatWorkerReport.safeParse({
      schema_version: 1,
      type: "heartbeat_worker_report",
      status: "actions",
      token: "HEARTBEAT_OK",
      summary: "One action",
      actions: [
        {
          kind: "noop",
          idempotency_key: "noop:1",
          risk: "low",
          needs_approval: false,
          reason: "test"
        }
      ]
    });
    expect(invalid.success).toBe(false);
  });

  test("requires idempotency/risk/approval fields on every action", () => {
    const missing = HeartbeatAction.safeParse({
      kind: "noop",
      reason: "missing required fields"
    });
    expect(missing.success).toBe(false);

    const valid = HeartbeatAction.safeParse({
      kind: "noop",
      idempotency_key: "noop:2",
      risk: "low",
      needs_approval: false,
      reason: "all good"
    });
    expect(valid.success).toBe(true);
  });

  test("rejects malformed worker report payloads", () => {
    const malformed = HeartbeatWorkerReport.safeParse({
      status: "actions",
      summary: "bad actions",
      actions: [
        {
          kind: "add_comment",
          idempotency_key: "cmt:1",
          risk: "low",
          needs_approval: false,
          project_id: "proj_1",
          body: "missing target"
        }
      ]
    });
    expect(malformed.success).toBe(false);
  });

  test("defaults for config/state are valid", () => {
    expect(() => HeartbeatConfig.parse(DEFAULT_HEARTBEAT_CONFIG)).not.toThrow();
    expect(() => HeartbeatState.parse(DEFAULT_HEARTBEAT_STATE)).not.toThrow();
  });

  test("supports enterprise hierarchy config and launch job routing hints", () => {
    const cfg = HeartbeatConfig.parse({
      ...DEFAULT_HEARTBEAT_CONFIG,
      hierarchy_mode: "enterprise_v1",
      executive_manager_agent_id: "agent_exec_mgr",
      allow_director_to_spawn_workers: true
    });
    expect(cfg.hierarchy_mode).toBe("enterprise_v1");
    expect(cfg.executive_manager_agent_id).toBe("agent_exec_mgr");
    expect(cfg.allow_director_to_spawn_workers).toBe(true);

    const action = HeartbeatAction.parse({
      kind: "launch_job",
      idempotency_key: "hb:launch:1",
      risk: "low",
      needs_approval: false,
      project_id: "proj_1",
      goal: "Do a follow-up run",
      constraints: [],
      deliverables: [],
      permission_level: "read-only",
      job_kind: "heartbeat",
      target_role: "director"
    });
    expect(action.kind).toBe("launch_job");
    expect(action.job_kind).toBe("heartbeat");
    expect(action.target_role).toBe("director");
  });
});
