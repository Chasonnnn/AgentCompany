import path from "node:path";
import { nowIso } from "../core/time.js";
import { ensureDir, pathExists, writeFileAtomic } from "../store/fs.js";
import { doctorWorkspace } from "./doctor.js";
import { listAdapterStatuses } from "../adapters/registry.js";
import { readIndexStats, indexDbPath } from "../index/sqlite.js";
import { listSessions } from "../runtime/session.js";
import { buildRunMonitorSnapshot } from "../runtime/run_monitor.js";
import { buildReviewInboxSnapshot } from "../runtime/review_inbox.js";

export type WorkspaceDiagnosticsArgs = {
  workspace_dir: string;
  out_dir: string;
  rebuild_index?: boolean;
  sync_index?: boolean;
  monitor_limit?: number;
  pending_limit?: number;
  decisions_limit?: number;
};

export type WorkspaceDiagnosticsResult = {
  workspace_dir: string;
  out_dir: string;
  bundle_dir: string;
  generated_at: string;
  files: {
    manifest: string;
    doctor: string;
    adapters: string;
    sessions: string;
    monitor_snapshot: string;
    review_inbox_snapshot: string;
    index_stats: string | null;
  };
};

function compactTs(iso: string): string {
  return iso.replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "T");
}

async function writeJson(p: string, value: unknown): Promise<void> {
  await writeFileAtomic(p, `${JSON.stringify(value, null, 2)}\n`, { workspace_lock: false });
}

export async function createWorkspaceDiagnosticsBundle(
  args: WorkspaceDiagnosticsArgs
): Promise<WorkspaceDiagnosticsResult> {
  const generatedAt = nowIso();
  const bundleDir = path.join(
    args.out_dir,
    `agentcompany-diagnostics-${compactTs(generatedAt)}-${process.pid}`
  );
  await ensureDir(bundleDir);

  const doctor = await doctorWorkspace({
    workspace_dir: args.workspace_dir,
    rebuild_index: args.rebuild_index ?? false,
    sync_index: args.sync_index ?? true
  });
  const adapters = await listAdapterStatuses(args.workspace_dir);
  const sessions = await listSessions({ workspace_dir: args.workspace_dir });
  const monitor = await buildRunMonitorSnapshot({
    workspace_dir: args.workspace_dir,
    limit: args.monitor_limit ?? 200,
    refresh_index: false,
    sync_index: args.sync_index ?? true
  });
  const inbox = await buildReviewInboxSnapshot({
    workspace_dir: args.workspace_dir,
    pending_limit: args.pending_limit ?? 200,
    decisions_limit: args.decisions_limit ?? 200,
    refresh_index: false,
    sync_index: args.sync_index ?? true
  });

  const dbPath = indexDbPath(args.workspace_dir);
  const hasIndex = await pathExists(dbPath);
  const indexStats = hasIndex ? await readIndexStats(args.workspace_dir).catch(() => null) : null;

  const files = {
    manifest: "manifest.json",
    doctor: "doctor.json",
    adapters: "adapters.json",
    sessions: "sessions.json",
    monitor_snapshot: "monitor.snapshot.json",
    review_inbox_snapshot: "review_inbox.snapshot.json",
    index_stats: indexStats ? "index.stats.json" : null
  } as const;

  const manifest = {
    schema_version: 1,
    type: "workspace_diagnostics",
    generated_at: generatedAt,
    workspace_dir: path.resolve(args.workspace_dir),
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch
    },
    doctor: {
      ok: doctor.ok,
      summary: doctor.summary,
      checks: doctor.checks.length
    },
    monitor: {
      rows: monitor.rows.length,
      index_rebuilt: monitor.index_rebuilt,
      index_synced: monitor.index_synced
    },
    review_inbox: {
      pending: inbox.pending.length,
      recent_decisions: inbox.recent_decisions.length,
      parse_errors: inbox.parse_errors
    },
    sessions: {
      total: sessions.length,
      running: sessions.filter((s) => s.status === "running").length
    },
    files
  };

  await Promise.all([
    writeJson(path.join(bundleDir, files.manifest), manifest),
    writeJson(path.join(bundleDir, files.doctor), doctor),
    writeJson(path.join(bundleDir, files.adapters), adapters),
    writeJson(path.join(bundleDir, files.sessions), sessions),
    writeJson(path.join(bundleDir, files.monitor_snapshot), monitor),
    writeJson(path.join(bundleDir, files.review_inbox_snapshot), inbox),
    files.index_stats
      ? writeJson(path.join(bundleDir, files.index_stats), indexStats)
      : Promise.resolve()
  ]);

  return {
    workspace_dir: args.workspace_dir,
    out_dir: args.out_dir,
    bundle_dir: bundleDir,
    generated_at: generatedAt,
    files
  };
}
