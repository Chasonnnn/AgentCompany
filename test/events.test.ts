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
      "ts_wallclock",
      "ts_monotonic_ms",
      "run_id",
      "session_ref",
      "actor",
      "visibility",
      "type",
      "payload"
    ]) {
      expect(parsed).toHaveProperty(k);
    }
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
});
