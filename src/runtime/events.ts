import fs from "node:fs/promises";
import path from "node:path";
import { appendFileAtomic, writeFileAtomic } from "../store/fs.js";
import { publishRuntimeEvent } from "./event_bus.js";

export type EventVisibility = "private_agent" | "team" | "managers" | "org";

export type EventEnvelope<TPayload = unknown> = {
  schema_version: number;
  ts_wallclock: string;
  ts_monotonic_ms: number;
  run_id: string;
  session_ref: string;
  actor: string; // "human" | "system" | agent_id
  visibility: EventVisibility;
  type: string;
  payload: TPayload;
};

export function newEnvelope<TPayload>(
  base: Omit<EventEnvelope<TPayload>, "ts_monotonic_ms">
): EventEnvelope<TPayload> {
  // Best-effort monotonic time: milliseconds since process start.
  const ms = Math.floor(performance.now());
  return { ...base, ts_monotonic_ms: ms };
}

export async function appendEventJsonl<TPayload>(
  eventsFilePath: string,
  ev: EventEnvelope<TPayload>
): Promise<void> {
  const line = `${JSON.stringify(ev)}\n`;
  await appendFileAtomic(eventsFilePath, line, { workspace_lock: false });
  publishRuntimeEvent({ events_file_path: eventsFilePath, event: ev });
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
