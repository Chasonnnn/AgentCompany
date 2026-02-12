import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { newId } from "../core/ids.js";
import { appendFileAtomic, writeFileAtomic } from "../store/fs.js";
import { publishRuntimeEvent } from "./event_bus.js";

export type EventVisibility = "private_agent" | "team" | "managers" | "org";

export type EventEnvelope<TPayload = unknown> = {
  schema_version: number;
  event_id: string;
  correlation_id: string | null;
  causation_id: string | null;
  ts_wallclock: string;
  ts_monotonic_ms: number;
  run_id: string;
  session_ref: string;
  actor: string; // "human" | "system" | agent_id
  visibility: EventVisibility;
  type: string;
  payload: TPayload;
  prev_event_hash?: string | null;
  event_hash?: string;
};

type NewEnvelopeBase<TPayload> = Omit<
  EventEnvelope<TPayload>,
  "event_id" | "correlation_id" | "causation_id" | "ts_monotonic_ms" | "prev_event_hash" | "event_hash"
> & {
  correlation_id?: string | null;
  causation_id?: string | null;
};

const eventAppendQueues = new Map<string, Promise<void>>();
const lastEventHashByFile = new Map<string, string | null>();

function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

async function withEventAppendQueue<T>(eventsFilePath: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(eventsFilePath);
  const prev = eventAppendQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  eventAppendQueues.set(key, prev.then(() => next));
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (eventAppendQueues.get(key) === next) {
      eventAppendQueues.delete(key);
    }
  }
}

async function loadLastEventHash(eventsFilePath: string): Promise<string | null> {
  const key = path.resolve(eventsFilePath);
  const cached = lastEventHashByFile.get(key);
  if (cached !== undefined) return cached;
  let s = "";
  try {
    s = await fs.readFile(eventsFilePath, { encoding: "utf8" });
  } catch {
    lastEventHashByFile.set(key, null);
    return null;
  }
  const lines = s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]) as { event_hash?: unknown };
      if (typeof parsed.event_hash === "string" && parsed.event_hash.length > 0) {
        lastEventHashByFile.set(key, parsed.event_hash);
        return parsed.event_hash;
      }
    } catch {
      // ignore malformed tail lines
    }
  }
  lastEventHashByFile.set(key, null);
  return null;
}

export function newEnvelope<TPayload>(
  base: NewEnvelopeBase<TPayload>
): EventEnvelope<TPayload> {
  // Best-effort monotonic time: milliseconds since process start.
  const ms = Math.floor(performance.now());
  return {
    ...base,
    event_id: newId("evt"),
    correlation_id: base.correlation_id ?? base.session_ref,
    causation_id: base.causation_id ?? null,
    ts_monotonic_ms: ms
  };
}

export async function appendEventJsonl<TPayload>(
  eventsFilePath: string,
  ev: EventEnvelope<TPayload>
): Promise<void> {
  await withEventAppendQueue(eventsFilePath, async () => {
    const prevHash = await loadLastEventHash(eventsFilePath);
    const withoutHash: EventEnvelope<TPayload> = {
      ...ev,
      prev_event_hash: prevHash,
      event_hash: undefined
    };
    const canonical = JSON.stringify(withoutHash);
    const eventHash = sha256Hex(canonical);
    const finalized: EventEnvelope<TPayload> = {
      ...withoutHash,
      event_hash: eventHash
    };
    const line = `${JSON.stringify(finalized)}\n`;
    await appendFileAtomic(eventsFilePath, line, { workspace_lock: false });
    lastEventHashByFile.set(path.resolve(eventsFilePath), eventHash);
    publishRuntimeEvent({ events_file_path: eventsFilePath, event: finalized });
  });
}

export async function ensureRunFiles(runDir: string): Promise<{ eventsPath: string }> {
  const eventsPath = path.join(runDir, "events.jsonl");
  try {
    await fs.access(eventsPath);
  } catch {
    await writeFileAtomic(eventsPath, "");
  }
  return { eventsPath };
}

// Test helper: clears append queues/hash cache to simulate runtime restart behavior.
export function resetEventStateForTests(): void {
  eventAppendQueues.clear();
  lastEventHashByFile.clear();
}
