import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Dirent } from "node:fs";
import { ensureDir, pathExists, writeFileAtomic } from "../store/fs.js";
import { readYamlFile, writeYamlFile } from "../store/yaml.js";

export const EVENT_ENVELOPE_MIGRATION_ID = "2026-02-12-event-envelope-v1-backfill";

type MigrationState = {
  schema_version: number;
  type: "workspace_migration_state";
  applied: Array<{
    id: string;
    applied_at: string;
    dry_run: boolean;
    files_scanned: number;
    files_updated: number;
    events_rewritten: number;
    parse_errors: number;
  }>;
};

export type WorkspaceMigrateArgs = {
  workspace_dir: string;
  dry_run?: boolean;
  force?: boolean;
};

export type WorkspaceMigrateResult = {
  workspace_dir: string;
  migration_id: string;
  dry_run: boolean;
  forced: boolean;
  already_applied: boolean;
  applied: boolean;
  state_relpath: string;
  files_scanned: number;
  files_updated: number;
  events_rewritten: number;
  parse_errors: number;
};

type RewriteResult = {
  changed: boolean;
  updated_lines: string[];
  rewritten_events: number;
  parse_errors: number;
};

function nowIso(): string {
  return new Date().toISOString();
}

function migrationStatePath(workspaceDir: string): string {
  return path.join(workspaceDir, "company", "migrations", "applied.yaml");
}

function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

async function listProjectRunDirs(workspaceDir: string): Promise<Array<{ project_id: string; run_id: string }>> {
  const out: Array<{ project_id: string; run_id: string }> = [];
  const projectsRoot = path.join(workspaceDir, "work/projects");
  let projectEntries: Dirent[] = [];
  try {
    projectEntries = await fs.readdir(projectsRoot, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const p of projectEntries) {
    if (!p.isDirectory()) continue;
    const runsDir = path.join(projectsRoot, p.name, "runs");
    let runEntries: Dirent[] = [];
    try {
      runEntries = await fs.readdir(runsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const r of runEntries) {
      if (!r.isDirectory()) continue;
      out.push({ project_id: p.name, run_id: r.name });
    }
  }
  return out;
}

async function readMigrationState(workspaceDir: string): Promise<MigrationState> {
  const p = migrationStatePath(workspaceDir);
  if (!(await pathExists(p))) {
    return {
      schema_version: 1,
      type: "workspace_migration_state",
      applied: []
    };
  }
  const raw = await readYamlFile(p);
  if (!isRecord(raw)) {
    return {
      schema_version: 1,
      type: "workspace_migration_state",
      applied: []
    };
  }
  const appliedRaw = Array.isArray(raw.applied) ? raw.applied : [];
  const applied: MigrationState["applied"] = [];
  for (const item of appliedRaw) {
    if (!isRecord(item)) continue;
    if (typeof item.id !== "string" || !item.id.trim()) continue;
    applied.push({
      id: item.id,
      applied_at: typeof item.applied_at === "string" ? item.applied_at : nowIso(),
      dry_run: Boolean(item.dry_run),
      files_scanned: typeof item.files_scanned === "number" ? item.files_scanned : 0,
      files_updated: typeof item.files_updated === "number" ? item.files_updated : 0,
      events_rewritten: typeof item.events_rewritten === "number" ? item.events_rewritten : 0,
      parse_errors: typeof item.parse_errors === "number" ? item.parse_errors : 0
    });
  }
  return {
    schema_version: 1,
    type: "workspace_migration_state",
    applied
  };
}

function rewriteEventsJsonl(lines: string[], runId: string): RewriteResult {
  const out: string[] = [];
  let changed = false;
  let prevHash: string | null = null;
  let rewrittenEvents = 0;
  let parseErrors = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    const line = rawLine.trim();
    if (!line) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      parseErrors += 1;
      out.push(rawLine);
      continue;
    }
    if (!isRecord(parsed)) {
      parseErrors += 1;
      out.push(rawLine);
      continue;
    }

    const original = parsed;
    const seq = i + 1;
    const normalized: Record<string, unknown> = { ...original };
    if (
      typeof normalized.schema_version !== "number" ||
      !Number.isInteger(normalized.schema_version) ||
      normalized.schema_version <= 0
    ) {
      normalized.schema_version = 1;
    }
    if (typeof normalized.run_id !== "string" || !normalized.run_id.trim()) {
      normalized.run_id = runId;
    }
    if (typeof normalized.session_ref !== "string" || !normalized.session_ref.trim()) {
      normalized.session_ref = `local_${runId}`;
    }
    if (typeof normalized.event_id !== "string" || !normalized.event_id.trim()) {
      normalized.event_id = `evt_migrated_${runId}_${seq}`;
    }
    if (!Object.prototype.hasOwnProperty.call(normalized, "correlation_id")) {
      normalized.correlation_id =
        typeof normalized.session_ref === "string" ? normalized.session_ref : null;
    }
    if (!Object.prototype.hasOwnProperty.call(normalized, "causation_id")) {
      normalized.causation_id = null;
    }
    if (
      typeof normalized.ts_monotonic_ms !== "number" ||
      !Number.isFinite(normalized.ts_monotonic_ms)
    ) {
      normalized.ts_monotonic_ms = seq;
    }
    normalized.prev_event_hash = prevHash;
    normalized.event_hash = undefined;

    const canonical = JSON.stringify(normalized);
    const eventHash = sha256Hex(canonical);
    const finalized: Record<string, unknown> = {
      ...normalized,
      event_hash: eventHash
    };
    const rewritten = JSON.stringify(finalized);
    if (rewritten !== line) {
      changed = true;
      rewrittenEvents += 1;
    }
    out.push(rewritten);
    prevHash = eventHash;
  }

  return {
    changed,
    updated_lines: out,
    rewritten_events: rewrittenEvents,
    parse_errors: parseErrors
  };
}

export async function migrateWorkspace(args: WorkspaceMigrateArgs): Promise<WorkspaceMigrateResult> {
  const dryRun = args.dry_run === true;
  const forced = args.force === true;
  const workspaceDir = path.resolve(args.workspace_dir);
  const stateRelpath = path.join("company", "migrations", "applied.yaml");
  const statePath = migrationStatePath(workspaceDir);

  const state = await readMigrationState(workspaceDir);
  const alreadyApplied = state.applied.some((m) => m.id === EVENT_ENVELOPE_MIGRATION_ID);
  if (alreadyApplied && !forced) {
    return {
      workspace_dir: workspaceDir,
      migration_id: EVENT_ENVELOPE_MIGRATION_ID,
      dry_run: dryRun,
      forced,
      already_applied: true,
      applied: false,
      state_relpath: stateRelpath,
      files_scanned: 0,
      files_updated: 0,
      events_rewritten: 0,
      parse_errors: 0
    };
  }

  const runDirs = await listProjectRunDirs(workspaceDir);
  let filesScanned = 0;
  let filesUpdated = 0;
  let eventsRewritten = 0;
  let parseErrors = 0;

  for (const { project_id, run_id } of runDirs) {
    const eventsPath = path.join(
      workspaceDir,
      "work",
      "projects",
      project_id,
      "runs",
      run_id,
      "events.jsonl"
    );
    if (!(await pathExists(eventsPath))) continue;
    filesScanned += 1;

    const raw = await fs.readFile(eventsPath, { encoding: "utf8" });
    const lines = raw.split("\n").filter((line) => line.trim().length > 0);
    const rewritten = rewriteEventsJsonl(lines, run_id);
    parseErrors += rewritten.parse_errors;
    eventsRewritten += rewritten.rewritten_events;
    if (!rewritten.changed) continue;
    filesUpdated += 1;

    if (!dryRun) {
      await writeFileAtomic(eventsPath, `${rewritten.updated_lines.join("\n")}\n`);
    }
  }

  if (!dryRun) {
    await ensureDir(path.dirname(statePath));
    const next: MigrationState = {
      schema_version: 1,
      type: "workspace_migration_state",
      applied: [
        ...state.applied.filter((m) => m.id !== EVENT_ENVELOPE_MIGRATION_ID),
        {
          id: EVENT_ENVELOPE_MIGRATION_ID,
          applied_at: nowIso(),
          dry_run: false,
          files_scanned: filesScanned,
          files_updated: filesUpdated,
          events_rewritten: eventsRewritten,
          parse_errors: parseErrors
        }
      ]
    };
    await writeYamlFile(statePath, next);
  }

  return {
    workspace_dir: workspaceDir,
    migration_id: EVENT_ENVELOPE_MIGRATION_ID,
    dry_run: dryRun,
    forced,
    already_applied: false,
    applied: !dryRun,
    state_relpath: stateRelpath,
    files_scanned: filesScanned,
    files_updated: filesUpdated,
    events_rewritten: eventsRewritten,
    parse_errors: parseErrors
  };
}
