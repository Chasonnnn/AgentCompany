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
});
