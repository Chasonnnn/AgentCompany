import readline from "node:readline";
import process from "node:process";
import path from "node:path";
import { z } from "zod";
import {
  error,
  isNotification,
  isRequest,
  success,
  type JsonRpcId,
  type JsonRpcNotification,
  type JsonRpcRequest
} from "./protocol.js";
import { routeRpcMethod, RpcUserError } from "./router.js";
import { subscribeRuntimeEvents } from "../runtime/event_bus.js";
import { listIndexedEvents, syncSqliteIndex } from "../index/sqlite.js";
import { createIndexSyncWorker } from "../index/sync_worker.js";
import { registerIndexSyncWorker } from "../runtime/index_sync_service.js";
import { HeartbeatService, setDefaultHeartbeatService } from "../runtime/heartbeat_service.js";

type StdioLike = {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
};

type Subscription = {
  subscription_id: string;
  project_id?: string;
  run_id?: string;
  event_types?: string[];
  last_ack_ts_monotonic_ms?: number;
};

const EventsSubscribeParams = z.object({
  subscription_id: z.string().min(1).optional(),
  workspace_dir: z.string().min(1).optional(),
  project_id: z.string().min(1).optional(),
  run_id: z.string().min(1).optional(),
  event_types: z.array(z.string().min(1)).optional(),
  backfill_limit: z.number().int().positive().max(5000).optional()
});

const EventsUnsubscribeParams = z.object({
  subscription_id: z.string().min(1)
});

const EventsAckParams = z.object({
  subscription_id: z.string().min(1),
  last_ack_ts_monotonic_ms: z.number().int().nonnegative().optional()
});

function writeJsonLine(out: NodeJS.WritableStream, obj: unknown): void {
  out.write(`${JSON.stringify(obj)}\n`);
}

function sendNotification(out: NodeJS.WritableStream, method: string, params: unknown): void {
  const n: JsonRpcNotification = { jsonrpc: "2.0", method, params };
  writeJsonLine(out, n);
}

function projectFromEventsPath(eventsPath: string): string | undefined {
  const normalized = eventsPath.split(path.sep).join("/");
  const m = normalized.match(/\/work\/projects\/([^/]+)\/runs\/[^/]+\/events\.jsonl$/);
  return m?.[1];
}

function workspaceFromEventsPath(eventsPath: string): string | undefined {
  const normalized = eventsPath.split(path.sep).join("/");
  const m = normalized.match(/^(.*)\/work\/projects\/[^/]+\/runs\/[^/]+\/events\.jsonl$/);
  if (!m?.[1]) return undefined;
  const prefix = m[1];
  if (!prefix) return undefined;
  return eventsPath.includes(path.sep) ? prefix.split("/").join(path.sep) : prefix;
}

function matchesSubscription(sub: Subscription, msg: { project_id?: string; event: any }): boolean {
  if (sub.project_id && msg.project_id !== sub.project_id) return false;
  if (sub.run_id && msg.event?.run_id !== sub.run_id) return false;
  if (sub.event_types?.length) {
    const t = String(msg.event?.type ?? "");
    if (!sub.event_types.includes(t)) return false;
  }
  return true;
}

function workspaceDirFromParams(params: unknown): string | undefined {
  if (!params || typeof params !== "object") return undefined;
  const asRecord = params as Record<string, unknown>;
  if (typeof asRecord.workspace_dir === "string" && asRecord.workspace_dir.trim()) {
    return asRecord.workspace_dir;
  }
  const job = asRecord.job;
  if (job && typeof job === "object") {
    const rec = job as Record<string, unknown>;
    if (typeof rec.workspace_dir === "string" && rec.workspace_dir.trim()) {
      return rec.workspace_dir;
    }
  }
  return undefined;
}

async function handleEventsMethod(
  req: JsonRpcRequest,
  subscriptions: Map<string, Subscription>,
  out: NodeJS.WritableStream
): Promise<boolean> {
  if (req.method === "events.subscribe") {
    const p = EventsSubscribeParams.parse(req.params);
    const id = p.subscription_id ?? `sub_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    const sub: Subscription = {
      subscription_id: id,
      project_id: p.project_id,
      run_id: p.run_id,
      event_types: p.event_types
    };
    subscriptions.set(id, sub);
    writeJsonLine(out, success(req.id, { subscription_id: id }));

    if (p.workspace_dir && p.backfill_limit) {
      try {
        await syncSqliteIndex(p.workspace_dir);
        const events = await listIndexedEvents({
          workspace_dir: p.workspace_dir,
          project_id: p.project_id,
          run_id: p.run_id,
          limit: p.backfill_limit,
          order: "asc"
        });
        for (const e of events) {
          let ev: unknown;
          try {
            ev = JSON.parse(e.raw_json);
          } catch {
            continue;
          }
          if (!matchesSubscription(sub, { project_id: e.project_id, event: ev })) continue;
          sendNotification(out, "events.notification", {
            subscription_id: sub.subscription_id,
            project_id: e.project_id,
            event: ev
          });
        }
      } catch {
        // Best-effort: backfill should not block a live subscription.
      }
    }
    return true;
  }
  if (req.method === "events.unsubscribe") {
    const p = EventsUnsubscribeParams.parse(req.params);
    const removed = subscriptions.delete(p.subscription_id);
    writeJsonLine(out, success(req.id, { removed }));
    return true;
  }
  if (req.method === "events.ack") {
    const p = EventsAckParams.parse(req.params);
    const sub = subscriptions.get(p.subscription_id);
    if (!sub) {
      writeJsonLine(out, error(req.id, -32000, `Unknown subscription_id: ${p.subscription_id}`));
      return true;
    }
    sub.last_ack_ts_monotonic_ms = p.last_ack_ts_monotonic_ms;
    writeJsonLine(out, success(req.id, { ok: true }));
    return true;
  }
  return false;
}

async function handleRequest(
  req: JsonRpcRequest,
  io: StdioLike,
  subscriptions: Map<string, Subscription>,
  heartbeatService: HeartbeatService
): Promise<void> {
  try {
    const workspaceDir = workspaceDirFromParams(req.params);
    if (workspaceDir) {
      await heartbeatService.observeWorkspace(workspaceDir);
    }
    if (await handleEventsMethod(req, subscriptions, io.stdout)) return;
    const result = await routeRpcMethod(req.method, req.params);
    writeJsonLine(io.stdout, success(req.id, result));
  } catch (e) {
    if (e instanceof z.ZodError) {
      writeJsonLine(io.stdout, error(req.id, -32602, "Invalid params", e.issues));
      return;
    }
    if (e instanceof RpcUserError) {
      writeJsonLine(io.stdout, error(req.id, -32601, e.message));
      return;
    }
    const err = e instanceof Error ? e : new Error(String(e));
    writeJsonLine(io.stdout, error(req.id, -32000, err.message));
  }
}

export async function runJsonRpcServer(io: StdioLike = {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr
}): Promise<void> {
  const subscriptions = new Map<string, Subscription>();
  const heartbeatService = new HeartbeatService();
  setDefaultHeartbeatService(heartbeatService);
  const syncWorker = createIndexSyncWorker({
    debounce_ms: 250,
    min_interval_ms: 1000,
    sync: async (workspaceDir: string) => {
      await syncSqliteIndex(workspaceDir);
    },
    on_error: (error, workspaceDir) => {
      const msg = error instanceof Error ? error.message : String(error);
      io.stderr.write(`[index-sync-worker] ${workspaceDir}: ${msg}\n`);
    }
  });
  registerIndexSyncWorker(syncWorker);

  const unsub = subscribeRuntimeEvents((msg) => {
    const project_id = projectFromEventsPath(msg.events_file_path);
    const workspaceDir = workspaceFromEventsPath(msg.events_file_path);
    if (workspaceDir) {
      syncWorker.notify(workspaceDir);
      void heartbeatService.observeWorkspace(workspaceDir);
    }
    const ev = msg.event as any;
    for (const sub of subscriptions.values()) {
      if (!matchesSubscription(sub, { project_id, event: ev })) continue;
      sendNotification(io.stdout, "events.notification", {
        subscription_id: sub.subscription_id,
        project_id: project_id ?? null,
        event: ev
      });
    }
  });

  const rl = readline.createInterface({ input: io.stdin, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        writeJsonLine(io.stdout, error(null, -32700, "Parse error"));
        continue;
      }

      if (isNotification(parsed)) {
        // v1: ignore incoming notifications.
        continue;
      }
      if (!isRequest(parsed)) {
        writeJsonLine(io.stdout, error(null, -32600, "Invalid Request"));
        continue;
      }
      await handleRequest(parsed, io, subscriptions, heartbeatService);
    }
  } finally {
    unsub();
    try {
      await Promise.allSettled([syncWorker.close(), heartbeatService.close()]);
    } finally {
      registerIndexSyncWorker(null);
      setDefaultHeartbeatService(null);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runJsonRpcServer().catch((e) => {
    const err = e instanceof Error ? e : new Error(String(e));
    process.stderr.write(`ERROR: ${err.message}\n`);
    process.exitCode = 1;
  });
}
