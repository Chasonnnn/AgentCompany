import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { appendEventJsonl, ensureRunFiles, newEnvelope } from "../src/runtime/events.js";

async function mkTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-"));
  return dir;
}

describe("events jsonl", () => {
  test("append writes a strict-envelope json line", async () => {
    const runDir = await mkTmpDir();
    const { eventsPath } = await ensureRunFiles(runDir);
    const ev = newEnvelope({
      schema_version: 1,
      ts_wallclock: new Date().toISOString(),
      run_id: "run_123",
      session_ref: "sess_abc",
      actor: "human",
      visibility: "org",
      type: "run.started",
      payload: { x: 1 }
    });
    await appendEventJsonl(eventsPath, ev);
    const s = await fs.readFile(eventsPath, { encoding: "utf8" });
    const lines = s.trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
    for (const k of [
      "schema_version",
      "event_id",
      "ts_wallclock",
      "ts_monotonic_ms",
      "run_id",
      "session_ref",
      "correlation_id",
      "causation_id",
      "actor",
      "visibility",
      "type",
      "payload"
    ]) {
      expect(parsed).toHaveProperty(k);
    }
    expect(typeof parsed.event_hash).toBe("string");
    expect(parsed.prev_event_hash).toBe(null);
  });

  test("concurrent appends keep all JSONL events parseable", async () => {
    const runDir = await mkTmpDir();
    const { eventsPath } = await ensureRunFiles(runDir);
    const count = 80;

    await Promise.all(
      Array.from({ length: count }, (_, idx) =>
        appendEventJsonl(
          eventsPath,
          newEnvelope({
            schema_version: 1,
            ts_wallclock: new Date().toISOString(),
            run_id: "run_123",
            session_ref: "sess_abc",
            actor: "system",
            visibility: "org",
            type: "test.event",
            payload: { idx }
          })
        )
      )
    );

    const s = await fs.readFile(eventsPath, { encoding: "utf8" });
    const lines = s.trim().split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(count);

    const seen = new Set<number>();
    for (const line of lines) {
      const parsed = JSON.parse(line) as { payload?: { idx?: number } };
      expect(typeof parsed.payload?.idx).toBe("number");
      seen.add(parsed.payload!.idx!);
    }
    expect(seen.size).toBe(count);
  });

  test("appended events form a hash chain", async () => {
    const runDir = await mkTmpDir();
    const { eventsPath } = await ensureRunFiles(runDir);
    const first = newEnvelope({
      schema_version: 1,
      ts_wallclock: new Date().toISOString(),
      run_id: "run_123",
      session_ref: "sess_abc",
      actor: "system",
      visibility: "org",
      type: "run.started",
      payload: { i: 1 }
    });
    const second = newEnvelope({
      schema_version: 1,
      ts_wallclock: new Date().toISOString(),
      run_id: "run_123",
      session_ref: "sess_abc",
      actor: "system",
      visibility: "org",
      type: "run.ended",
      payload: { i: 2 }
    });
    await appendEventJsonl(eventsPath, first);
    await appendEventJsonl(eventsPath, second);

    const lines = (await fs.readFile(eventsPath, { encoding: "utf8" }))
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toHaveLength(2);
    expect(lines[0].prev_event_hash).toBe(null);
    expect(typeof lines[0].event_hash).toBe("string");
    expect(lines[1].prev_event_hash).toBe(lines[0].event_hash);
    expect(typeof lines[1].event_hash).toBe("string");
  });
});
