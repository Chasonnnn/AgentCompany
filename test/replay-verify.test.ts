import crypto from "node:crypto";
import { describe, expect, test } from "vitest";
import { verifyReplayEvents } from "../src/runtime/replay_verify.js";

function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function withHash(ev: Record<string, unknown>): Record<string, unknown> {
  const noHash = { ...ev, event_hash: undefined };
  return {
    ...noHash,
    event_hash: sha256Hex(JSON.stringify(noHash))
  };
}

describe("replay verification", () => {
  test("accepts a valid event hash chain", () => {
    const ev1 = withHash({
      schema_version: 1,
      event_id: "evt_1",
      correlation_id: "sess_1",
      causation_id: null,
      ts_wallclock: new Date().toISOString(),
      ts_monotonic_ms: 1,
      run_id: "run_1",
      session_ref: "sess_1",
      actor: "system",
      visibility: "org",
      type: "run.started",
      payload: {},
      prev_event_hash: null
    });
    const ev2 = withHash({
      schema_version: 1,
      event_id: "evt_2",
      correlation_id: "sess_1",
      causation_id: null,
      ts_wallclock: new Date().toISOString(),
      ts_monotonic_ms: 2,
      run_id: "run_1",
      session_ref: "sess_1",
      actor: "system",
      visibility: "org",
      type: "run.ended",
      payload: {},
      prev_event_hash: ev1.event_hash
    });

    const issues = verifyReplayEvents([ev1, ev2]);
    expect(issues).toEqual([]);
  });

  test("detects hash chain mismatch", () => {
    const ev1 = withHash({
      schema_version: 1,
      event_id: "evt_1",
      correlation_id: "sess_1",
      causation_id: null,
      ts_wallclock: new Date().toISOString(),
      ts_monotonic_ms: 1,
      run_id: "run_1",
      session_ref: "sess_1",
      actor: "system",
      visibility: "org",
      type: "run.started",
      payload: {},
      prev_event_hash: null
    });
    const ev2 = withHash({
      schema_version: 1,
      event_id: "evt_2",
      correlation_id: "sess_1",
      causation_id: null,
      ts_wallclock: new Date().toISOString(),
      ts_monotonic_ms: 2,
      run_id: "run_1",
      session_ref: "sess_1",
      actor: "system",
      visibility: "org",
      type: "run.ended",
      payload: {},
      prev_event_hash: "wrong_hash"
    });

    const issues = verifyReplayEvents([ev1, ev2]);
    expect(issues.some((i) => i.code === "prev_hash_chain_mismatch")).toBe(true);
  });

  test("flags missing required keys", () => {
    const issues = verifyReplayEvents([
      {
        schema_version: 1,
        ts_wallclock: new Date().toISOString(),
        ts_monotonic_ms: 1,
        run_id: "run_1",
        session_ref: "sess_1",
        actor: "system",
        visibility: "org",
        type: "run.note",
        payload: {}
      }
    ]);
    expect(issues.some((i) => i.code === "missing_key")).toBe(true);
    expect(issues.some((i) => i.code === "invalid_event_hash")).toBe(true);
  });
});
