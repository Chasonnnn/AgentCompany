import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { readYamlFile } from "../store/yaml.js";
import { RunYaml } from "../schemas/run.js";
import { ReviewYaml, ReviewDecision } from "../schemas/review.js";
import { validateHelpRequestMarkdown } from "../help/help_request.js";
import { parseFrontMatter } from "../artifacts/frontmatter.js";

type SqliteModule = typeof import("node:sqlite");

async function loadSqliteModule(): Promise<SqliteModule> {
  try {
    return await import("node:sqlite");
  } catch {
    throw new Error(
      "node:sqlite is unavailable in this runtime. Use Node.js 24+ where node:sqlite is built in."
    );
  }
}

export function indexDbPath(workspaceDir: string): string {
  return path.join(workspaceDir, ".local", "index.sqlite");
}

const workspaceWriteLocks = new Map<string, Promise<void>>();

function lockKey(workspaceDir: string): string {
  return path.resolve(workspaceDir);
}

async function withWorkspaceWriteLock<T>(
  workspaceDir: string,
  fn: () => Promise<T>
): Promise<T> {
  const key = lockKey(workspaceDir);
  const prev = workspaceWriteLocks.get(key) ?? Promise.resolve();
  let release: (value?: void | PromiseLike<void>) => void = () => {};
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  workspaceWriteLocks.set(key, next);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (workspaceWriteLocks.get(key) === next) {
      workspaceWriteLocks.delete(key);
    }
  }
}

type RebuildCounters = {
  runs_indexed: number;
  events_indexed: number;
  event_parse_errors: number;
  artifacts_indexed: number;
  reviews_indexed: number;
  help_requests_indexed: number;
};

export type RebuildIndexResult = RebuildCounters & {
  db_path: string;
};

export type SyncIndexResult = {
  db_path: string;
  db_created: boolean;
  runs_upserted: number;
  runs_deleted: number;
  events_indexed: number;
  events_deleted: number;
  event_parse_errors_indexed: number;
  event_parse_errors_deleted: number;
  artifacts_upserted: number;
  artifacts_deleted: number;
  reviews_upserted: number;
  reviews_deleted: number;
  help_requests_upserted: number;
  help_requests_deleted: number;
};

export type IndexedRun = {
  project_id: string;
  run_id: string;
  created_at: string;
  status: string;
  provider: string;
  agent_id: string;
  context_pack_id: string;
};

export type IndexedEvent = {
  project_id: string;
  run_id: string;
  seq: number;
  type: string;
  ts_wallclock: string | null;
  ts_monotonic_ms: number | null;
  actor: string | null;
  session_ref: string | null;
  visibility: string | null;
  payload_json: string;
  raw_json: string;
};

export type IndexedEventParseError = {
  project_id: string;
  run_id: string;
  seq: number;
  error: string;
  raw_line: string;
};

export type IndexedRunLastEvent = {
  project_id: string;
  run_id: string;
  seq: number;
  type: string;
  ts_wallclock: string | null;
  actor: string | null;
  visibility: string | null;
};

export type IndexedRunParseErrorCount = {
  project_id: string;
  run_id: string;
  parse_error_count: number;
};

export type IndexedRunEventTypeCount = {
  project_id: string;
  run_id: string;
  type: string;
  event_count: number;
};

export type IndexedRunLatestTypedEvent = {
  project_id: string;
  run_id: string;
  type: string;
  seq: number;
  ts_wallclock: string | null;
  payload_json: string;
};

export type IndexedArtifact = {
  project_id: string;
  artifact_id: string;
  type: string;
  title: string | null;
  visibility: string | null;
  produced_by: string | null;
  run_id: string | null;
  context_pack_id: string | null;
  created_at: string | null;
  relpath: string;
};

export type IndexedPendingApproval = {
  project_id: string;
  artifact_id: string;
  artifact_type: string;
  title: string | null;
  visibility: string | null;
  produced_by: string | null;
  run_id: string | null;
  created_at: string | null;
};

export type IndexedReviewDecision = {
  review_id: string;
  created_at: string;
  decision: "approved" | "denied";
  actor_id: string;
  actor_role: string;
  subject_kind: string;
  subject_artifact_id: string;
  project_id: string;
  notes: string | null;
  artifact_type: string | null;
  artifact_run_id: string | null;
};

export type IndexedReview = {
  review_id: string;
  created_at: string;
  decision: "approved" | "denied";
  actor_id: string;
  actor_role: string;
  subject_kind: string;
  subject_artifact_id: string;
  project_id: string;
  notes?: string;
};

export type IndexedHelpRequest = {
  help_request_id: string;
  created_at: string;
  title: string;
  visibility: string;
  requester: string;
  target_manager: string;
  project_id?: string;
  share_pack_id?: string;
};

type DbWithPath = {
  db: DatabaseSync;
  dbPath: string;
};

async function openFreshDb(workspaceDir: string): Promise<DbWithPath> {
  const { DatabaseSync } = await loadSqliteModule();
  const dbPath = indexDbPath(workspaceDir);
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  await fs.rm(dbPath, { force: true });
  const db = new DatabaseSync(dbPath);
  return { db, dbPath };
}

async function openExistingDb(workspaceDir: string): Promise<DbWithPath> {
  const { DatabaseSync } = await loadSqliteModule();
  const dbPath = indexDbPath(workspaceDir);
  try {
    await fs.access(dbPath);
  } catch {
    throw new Error(`Index database not found: ${dbPath}. Run index.rebuild first.`);
  }
  const db = new DatabaseSync(dbPath);
  return { db, dbPath };
}

async function openIndexDb(workspaceDir: string): Promise<DbWithPath & { created: boolean }> {
  const { DatabaseSync } = await loadSqliteModule();
  const dbPath = indexDbPath(workspaceDir);
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  let created = false;
  try {
    await fs.access(dbPath);
  } catch {
    created = true;
  }
  const db = new DatabaseSync(dbPath);
  return { db, dbPath, created };
}

function createSchema(db: DatabaseSync): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS runs (
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL,
  provider TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  context_pack_id TEXT NOT NULL,
  events_relpath TEXT NOT NULL,
  PRIMARY KEY (project_id, run_id)
);
CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);

CREATE TABLE IF NOT EXISTS events (
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  ts_wallclock TEXT,
  ts_monotonic_ms INTEGER,
  actor TEXT,
  session_ref TEXT,
  visibility TEXT,
  payload_json TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  PRIMARY KEY (project_id, run_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
CREATE INDEX IF NOT EXISTS idx_events_wallclock ON events(ts_wallclock DESC);

CREATE TABLE IF NOT EXISTS event_parse_errors (
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  error TEXT NOT NULL,
  raw_line TEXT NOT NULL,
  PRIMARY KEY (project_id, run_id, seq)
);

CREATE TABLE IF NOT EXISTS artifacts (
  project_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT,
  visibility TEXT,
  produced_by TEXT,
  run_id TEXT,
  context_pack_id TEXT,
  created_at TEXT,
  relpath TEXT NOT NULL,
  PRIMARY KEY (project_id, artifact_id)
);
CREATE INDEX IF NOT EXISTS idx_artifacts_type ON artifacts(type);
CREATE INDEX IF NOT EXISTS idx_artifacts_created_at ON artifacts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_artifacts_run_id ON artifacts(run_id);

CREATE TABLE IF NOT EXISTS reviews (
  review_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  decision TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  subject_kind TEXT NOT NULL,
  subject_artifact_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_reviews_created_at ON reviews(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reviews_project_id ON reviews(project_id);

CREATE TABLE IF NOT EXISTS help_requests (
  help_request_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  title TEXT NOT NULL,
  visibility TEXT NOT NULL,
  requester TEXT NOT NULL,
  target_manager TEXT NOT NULL,
  project_id TEXT,
  share_pack_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_help_requests_created_at ON help_requests(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_help_requests_target ON help_requests(target_manager);
`);
}

function parseJsonLine(line: string): { ok: true; value: any } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(line) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function parseArtifactForIndex(args: {
  project_id: string;
  relpath: string;
  markdown: string;
}): IndexedArtifact | null {
  const parsed = parseFrontMatter(args.markdown);
  if (!parsed.ok) return null;
  const fm = parsed.frontmatter;
  if (!fm || typeof fm !== "object") return null;
  const obj = fm as Record<string, unknown>;
  const artifactId = typeof obj.id === "string" && obj.id.trim() ? obj.id : null;
  const type = typeof obj.type === "string" && obj.type.trim() ? obj.type : null;
  if (!artifactId || !type) return null;
  return {
    project_id: args.project_id,
    artifact_id: artifactId,
    type,
    title: typeof obj.title === "string" ? obj.title : null,
    visibility: typeof obj.visibility === "string" ? obj.visibility : null,
    produced_by: typeof obj.produced_by === "string" ? obj.produced_by : null,
    run_id: typeof obj.run_id === "string" ? obj.run_id : null,
    context_pack_id: typeof obj.context_pack_id === "string" ? obj.context_pack_id : null,
    created_at: typeof obj.created_at === "string" ? obj.created_at : null,
    relpath: args.relpath
  };
}

function changesOf(runResult: unknown): number {
  if (!runResult || typeof runResult !== "object") return 0;
  const v = (runResult as { changes?: unknown }).changes;
  return typeof v === "number" ? v : 0;
}

async function listDirectoryNames(absDir: string): Promise<string[]> {
  try {
    const ents = await fs.readdir(absDir, { withFileTypes: true });
    return ents
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

async function listFiles(absDir: string, ext: string): Promise<string[]> {
  try {
    const ents = await fs.readdir(absDir, { withFileTypes: true });
    return ents
      .filter((e) => e.isFile() && e.name.endsWith(ext))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

async function rebuildSqliteIndexUnlocked(workspaceDir: string): Promise<RebuildIndexResult> {
  const { db, dbPath } = await openFreshDb(workspaceDir);
  const counters: RebuildCounters = {
    runs_indexed: 0,
    events_indexed: 0,
    event_parse_errors: 0,
    artifacts_indexed: 0,
    reviews_indexed: 0,
    help_requests_indexed: 0
  };

  try {
    createSchema(db);

    const insertRun = db.prepare(`
      INSERT INTO runs (
        project_id, run_id, created_at, status, provider, agent_id, context_pack_id, events_relpath
      ) VALUES (
        :project_id, :run_id, :created_at, :status, :provider, :agent_id, :context_pack_id, :events_relpath
      )
    `);
    const insertEvent = db.prepare(`
      INSERT INTO events (
        project_id, run_id, seq, type, ts_wallclock, ts_monotonic_ms, actor, session_ref, visibility, payload_json, raw_json
      ) VALUES (
        :project_id, :run_id, :seq, :type, :ts_wallclock, :ts_monotonic_ms, :actor, :session_ref, :visibility, :payload_json, :raw_json
      )
    `);
    const insertEventParseError = db.prepare(`
      INSERT INTO event_parse_errors (project_id, run_id, seq, error, raw_line)
      VALUES (:project_id, :run_id, :seq, :error, :raw_line)
    `);
    const insertArtifact = db.prepare(`
      INSERT INTO artifacts (
        project_id, artifact_id, type, title, visibility, produced_by, run_id, context_pack_id, created_at, relpath
      ) VALUES (
        :project_id, :artifact_id, :type, :title, :visibility, :produced_by, :run_id, :context_pack_id, :created_at, :relpath
      )
    `);
    const insertReview = db.prepare(`
      INSERT INTO reviews (
        review_id, created_at, decision, actor_id, actor_role, subject_kind, subject_artifact_id, project_id, notes
      ) VALUES (
        :review_id, :created_at, :decision, :actor_id, :actor_role, :subject_kind, :subject_artifact_id, :project_id, :notes
      )
    `);
    const insertHelpRequest = db.prepare(`
      INSERT INTO help_requests (
        help_request_id, created_at, title, visibility, requester, target_manager, project_id, share_pack_id
      ) VALUES (
        :help_request_id, :created_at, :title, :visibility, :requester, :target_manager, :project_id, :share_pack_id
      )
    `);

    const projectIds = await listDirectoryNames(path.join(workspaceDir, "work/projects"));

    db.exec("BEGIN");
    try {
      for (const projectId of projectIds) {
        const runsDir = path.join(workspaceDir, "work/projects", projectId, "runs");
        const runIds = await listDirectoryNames(runsDir);
        for (const runId of runIds) {
          const runYamlPath = path.join(runsDir, runId, "run.yaml");
          let run: RunYaml;
          try {
            run = RunYaml.parse(await readYamlFile(runYamlPath));
          } catch {
            continue;
          }
          insertRun.run({
            project_id: projectId,
            run_id: run.id,
            created_at: run.created_at,
            status: run.status,
            provider: run.provider,
            agent_id: run.agent_id,
            context_pack_id: run.context_pack_id,
            events_relpath: run.events_relpath
          });
          counters.runs_indexed += 1;

          const eventsAbs = path.join(runsDir, runId, "events.jsonl");
          let text = "";
          try {
            text = await fs.readFile(eventsAbs, { encoding: "utf8" });
          } catch {
            continue;
          }
          const lines = text.split("\n").filter((l) => l.trim().length > 0);
          let seq = 0;
          for (const line of lines) {
            seq += 1;
            const parsed = parseJsonLine(line);
            if (!parsed.ok) {
              insertEventParseError.run({
                project_id: projectId,
                run_id: run.id,
                seq,
                error: parsed.error,
                raw_line: line
              });
              counters.event_parse_errors += 1;
              continue;
            }
            const ev =
              parsed.value && typeof parsed.value === "object" ? (parsed.value as any) : undefined;
            const payload = ev && Object.hasOwn(ev, "payload") ? ev.payload : null;
            insertEvent.run({
              project_id: projectId,
              run_id: run.id,
              seq,
              type: typeof ev?.type === "string" ? ev.type : "unknown",
              ts_wallclock: typeof ev?.ts_wallclock === "string" ? ev.ts_wallclock : null,
              ts_monotonic_ms:
                typeof ev?.ts_monotonic_ms === "number" ? Math.floor(ev.ts_monotonic_ms) : null,
              actor: typeof ev?.actor === "string" ? ev.actor : null,
              session_ref: typeof ev?.session_ref === "string" ? ev.session_ref : null,
              visibility: typeof ev?.visibility === "string" ? ev.visibility : null,
              payload_json: JSON.stringify(payload),
              raw_json: line
            });
            counters.events_indexed += 1;
          }
        }

        const artifactsDir = path.join(workspaceDir, "work/projects", projectId, "artifacts");
        const artifactFiles = await listFiles(artifactsDir, ".md");
        for (const file of artifactFiles) {
          const rel = path.join("work/projects", projectId, "artifacts", file);
          const abs = path.join(workspaceDir, rel);
          let markdown = "";
          try {
            markdown = await fs.readFile(abs, { encoding: "utf8" });
          } catch {
            continue;
          }
          const parsed = parseArtifactForIndex({
            project_id: projectId,
            relpath: rel,
            markdown
          });
          if (!parsed) continue;
          insertArtifact.run(parsed);
          counters.artifacts_indexed += 1;
        }
      }

      const reviewFiles = await listFiles(path.join(workspaceDir, "inbox/reviews"), ".yaml");
      for (const file of reviewFiles) {
        const abs = path.join(workspaceDir, "inbox/reviews", file);
        let review: ReviewYaml;
        try {
          review = ReviewYaml.parse(await readYamlFile(abs));
        } catch {
          continue;
        }
        insertReview.run({
          review_id: review.id,
          created_at: review.created_at,
          decision: review.decision,
          actor_id: review.actor_id,
          actor_role: review.actor_role,
          subject_kind: review.subject.kind,
          subject_artifact_id: review.subject.artifact_id,
          project_id: review.subject.project_id,
          notes: review.notes ?? null
        });
        counters.reviews_indexed += 1;
      }

      const helpFiles = await listFiles(path.join(workspaceDir, "inbox/help_requests"), ".md");
      for (const file of helpFiles) {
        const abs = path.join(workspaceDir, "inbox/help_requests", file);
        let markdown = "";
        try {
          markdown = await fs.readFile(abs, { encoding: "utf8" });
        } catch {
          continue;
        }
        const validated = validateHelpRequestMarkdown(markdown);
        if (!validated.ok) continue;
        const fm = validated.frontmatter;
        insertHelpRequest.run({
          help_request_id: fm.id,
          created_at: fm.created_at,
          title: fm.title,
          visibility: fm.visibility,
          requester: fm.requester,
          target_manager: fm.target_manager,
          project_id: fm.project_id ?? null,
          share_pack_id: fm.share_pack_id ?? null
        });
        counters.help_requests_indexed += 1;
      }

      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }

    return {
      db_path: dbPath,
      ...counters
    };
  } finally {
    db.close();
  }
}

async function syncSqliteIndexUnlocked(workspaceDir: string): Promise<SyncIndexResult> {
  const { db, dbPath, created } = await openIndexDb(workspaceDir);
  const counters: Omit<SyncIndexResult, "db_path" | "db_created"> = {
    runs_upserted: 0,
    runs_deleted: 0,
    events_indexed: 0,
    events_deleted: 0,
    event_parse_errors_indexed: 0,
    event_parse_errors_deleted: 0,
    artifacts_upserted: 0,
    artifacts_deleted: 0,
    reviews_upserted: 0,
    reviews_deleted: 0,
    help_requests_upserted: 0,
    help_requests_deleted: 0
  };

  try {
    createSchema(db);

    const upsertRun = db.prepare(`
      INSERT INTO runs (
        project_id, run_id, created_at, status, provider, agent_id, context_pack_id, events_relpath
      ) VALUES (
        :project_id, :run_id, :created_at, :status, :provider, :agent_id, :context_pack_id, :events_relpath
      )
      ON CONFLICT(project_id, run_id) DO UPDATE SET
        created_at = excluded.created_at,
        status = excluded.status,
        provider = excluded.provider,
        agent_id = excluded.agent_id,
        context_pack_id = excluded.context_pack_id,
        events_relpath = excluded.events_relpath
    `);

    const upsertEvent = db.prepare(`
      INSERT INTO events (
        project_id, run_id, seq, type, ts_wallclock, ts_monotonic_ms, actor, session_ref, visibility, payload_json, raw_json
      ) VALUES (
        :project_id, :run_id, :seq, :type, :ts_wallclock, :ts_monotonic_ms, :actor, :session_ref, :visibility, :payload_json, :raw_json
      )
      ON CONFLICT(project_id, run_id, seq) DO UPDATE SET
        type = excluded.type,
        ts_wallclock = excluded.ts_wallclock,
        ts_monotonic_ms = excluded.ts_monotonic_ms,
        actor = excluded.actor,
        session_ref = excluded.session_ref,
        visibility = excluded.visibility,
        payload_json = excluded.payload_json,
        raw_json = excluded.raw_json
    `);

    const upsertEventParseError = db.prepare(`
      INSERT INTO event_parse_errors (project_id, run_id, seq, error, raw_line)
      VALUES (:project_id, :run_id, :seq, :error, :raw_line)
      ON CONFLICT(project_id, run_id, seq) DO UPDATE SET
        error = excluded.error,
        raw_line = excluded.raw_line
    `);
    const upsertArtifact = db.prepare(`
      INSERT INTO artifacts (
        project_id, artifact_id, type, title, visibility, produced_by, run_id, context_pack_id, created_at, relpath
      ) VALUES (
        :project_id, :artifact_id, :type, :title, :visibility, :produced_by, :run_id, :context_pack_id, :created_at, :relpath
      )
      ON CONFLICT(project_id, artifact_id) DO UPDATE SET
        type = excluded.type,
        title = excluded.title,
        visibility = excluded.visibility,
        produced_by = excluded.produced_by,
        run_id = excluded.run_id,
        context_pack_id = excluded.context_pack_id,
        created_at = excluded.created_at,
        relpath = excluded.relpath
    `);

    const deleteRun = db.prepare(`
      DELETE FROM runs
      WHERE project_id = :project_id AND run_id = :run_id
    `);
    const deleteRunEvents = db.prepare(`
      DELETE FROM events
      WHERE project_id = :project_id AND run_id = :run_id
    `);
    const deleteRunParseErrors = db.prepare(`
      DELETE FROM event_parse_errors
      WHERE project_id = :project_id AND run_id = :run_id
    `);
    const deleteEventSeq = db.prepare(`
      DELETE FROM events
      WHERE project_id = :project_id AND run_id = :run_id AND seq = :seq
    `);
    const deleteParseErrorSeq = db.prepare(`
      DELETE FROM event_parse_errors
      WHERE project_id = :project_id AND run_id = :run_id AND seq = :seq
    `);
    const deleteArtifact = db.prepare(`
      DELETE FROM artifacts
      WHERE project_id = :project_id AND artifact_id = :artifact_id
    `);

    const maxEventSeq = db.prepare(`
      SELECT COALESCE(MAX(seq), 0) AS max_seq
      FROM events
      WHERE project_id = :project_id AND run_id = :run_id
    `);
    const maxParseErrorSeq = db.prepare(`
      SELECT COALESCE(MAX(seq), 0) AS max_seq
      FROM event_parse_errors
      WHERE project_id = :project_id AND run_id = :run_id
    `);

    const upsertReview = db.prepare(`
      INSERT INTO reviews (
        review_id, created_at, decision, actor_id, actor_role, subject_kind, subject_artifact_id, project_id, notes
      ) VALUES (
        :review_id, :created_at, :decision, :actor_id, :actor_role, :subject_kind, :subject_artifact_id, :project_id, :notes
      )
      ON CONFLICT(review_id) DO UPDATE SET
        created_at = excluded.created_at,
        decision = excluded.decision,
        actor_id = excluded.actor_id,
        actor_role = excluded.actor_role,
        subject_kind = excluded.subject_kind,
        subject_artifact_id = excluded.subject_artifact_id,
        project_id = excluded.project_id,
        notes = excluded.notes
    `);
    const deleteReview = db.prepare(`
      DELETE FROM reviews
      WHERE review_id = :review_id
    `);

    const upsertHelpRequest = db.prepare(`
      INSERT INTO help_requests (
        help_request_id, created_at, title, visibility, requester, target_manager, project_id, share_pack_id
      ) VALUES (
        :help_request_id, :created_at, :title, :visibility, :requester, :target_manager, :project_id, :share_pack_id
      )
      ON CONFLICT(help_request_id) DO UPDATE SET
        created_at = excluded.created_at,
        title = excluded.title,
        visibility = excluded.visibility,
        requester = excluded.requester,
        target_manager = excluded.target_manager,
        project_id = excluded.project_id,
        share_pack_id = excluded.share_pack_id
    `);
    const deleteHelpRequest = db.prepare(`
      DELETE FROM help_requests
      WHERE help_request_id = :help_request_id
    `);

    const existingRuns = new Set(
      (
        db.prepare(`SELECT project_id, run_id FROM runs`).all() as Array<{
          project_id: string;
          run_id: string;
        }>
      ).map((r) => `${r.project_id}::${r.run_id}`)
    );
    const existingArtifactKeys = new Set(
      (
        db.prepare(`SELECT project_id, artifact_id FROM artifacts`).all() as Array<{
          project_id: string;
          artifact_id: string;
        }>
      ).map((r) => `${r.project_id}::${r.artifact_id}`)
    );
    const existingReviewIds = new Set(
      (
        db.prepare(`SELECT review_id FROM reviews`).all() as Array<{
          review_id: string;
        }>
      ).map((r) => r.review_id)
    );
    const existingHelpRequestIds = new Set(
      (
        db.prepare(`SELECT help_request_id FROM help_requests`).all() as Array<{
          help_request_id: string;
        }>
      ).map((r) => r.help_request_id)
    );

    const seenRuns = new Set<string>();
    const seenArtifactKeys = new Set<string>();
    const seenReviewIds = new Set<string>();
    const seenHelpRequestIds = new Set<string>();

    db.exec("BEGIN");
    try {
      const projectIds = await listDirectoryNames(path.join(workspaceDir, "work/projects"));
      for (const projectId of projectIds) {
        const runsDir = path.join(workspaceDir, "work/projects", projectId, "runs");
        const runIds = await listDirectoryNames(runsDir);
        for (const runId of runIds) {
          const runYamlPath = path.join(runsDir, runId, "run.yaml");
          let run: RunYaml;
          try {
            run = RunYaml.parse(await readYamlFile(runYamlPath));
          } catch {
            continue;
          }
          const runKey = `${projectId}::${run.id}`;
          seenRuns.add(runKey);

          upsertRun.run({
            project_id: projectId,
            run_id: run.id,
            created_at: run.created_at,
            status: run.status,
            provider: run.provider,
            agent_id: run.agent_id,
            context_pack_id: run.context_pack_id,
            events_relpath: run.events_relpath
          });
          counters.runs_upserted += 1;

          const eventsAbs = path.join(runsDir, runId, "events.jsonl");
          let text = "";
          try {
            text = await fs.readFile(eventsAbs, { encoding: "utf8" });
          } catch {
            continue;
          }
          const lines = text.split("\n").filter((l) => l.trim().length > 0);
          const maxEvent = (
            maxEventSeq.get({ project_id: projectId, run_id: run.id }) as { max_seq: number }
          ).max_seq;
          const maxErr = (
            maxParseErrorSeq.get({ project_id: projectId, run_id: run.id }) as { max_seq: number }
          ).max_seq;
          const maxIndexed = Math.max(Number(maxEvent ?? 0), Number(maxErr ?? 0));

          let startSeq = maxIndexed + 1;
          if (maxIndexed > lines.length) {
            counters.events_deleted += changesOf(
              deleteRunEvents.run({ project_id: projectId, run_id: run.id })
            );
            counters.event_parse_errors_deleted += changesOf(
              deleteRunParseErrors.run({ project_id: projectId, run_id: run.id })
            );
            startSeq = 1;
          }

          for (let seq = startSeq; seq <= lines.length; seq += 1) {
            const line = lines[seq - 1]!;
            const parsed = parseJsonLine(line);
            if (!parsed.ok) {
              counters.events_deleted += changesOf(
                deleteEventSeq.run({ project_id: projectId, run_id: run.id, seq })
              );
              upsertEventParseError.run({
                project_id: projectId,
                run_id: run.id,
                seq,
                error: parsed.error,
                raw_line: line
              });
              counters.event_parse_errors_indexed += 1;
              continue;
            }

            counters.event_parse_errors_deleted += changesOf(
              deleteParseErrorSeq.run({ project_id: projectId, run_id: run.id, seq })
            );
            const ev =
              parsed.value && typeof parsed.value === "object" ? (parsed.value as any) : undefined;
            const payload = ev && Object.hasOwn(ev, "payload") ? ev.payload : null;
            upsertEvent.run({
              project_id: projectId,
              run_id: run.id,
              seq,
              type: typeof ev?.type === "string" ? ev.type : "unknown",
              ts_wallclock: typeof ev?.ts_wallclock === "string" ? ev.ts_wallclock : null,
              ts_monotonic_ms:
                typeof ev?.ts_monotonic_ms === "number" ? Math.floor(ev.ts_monotonic_ms) : null,
              actor: typeof ev?.actor === "string" ? ev.actor : null,
              session_ref: typeof ev?.session_ref === "string" ? ev.session_ref : null,
              visibility: typeof ev?.visibility === "string" ? ev.visibility : null,
              payload_json: JSON.stringify(payload),
              raw_json: line
            });
            counters.events_indexed += 1;
          }
        }

        const artifactsDir = path.join(workspaceDir, "work/projects", projectId, "artifacts");
        const artifactFiles = await listFiles(artifactsDir, ".md");
        for (const file of artifactFiles) {
          const rel = path.join("work/projects", projectId, "artifacts", file);
          const abs = path.join(workspaceDir, rel);
          let markdown = "";
          try {
            markdown = await fs.readFile(abs, { encoding: "utf8" });
          } catch {
            continue;
          }
          const artifact = parseArtifactForIndex({
            project_id: projectId,
            relpath: rel,
            markdown
          });
          if (!artifact) continue;
          seenArtifactKeys.add(`${projectId}::${artifact.artifact_id}`);
          upsertArtifact.run(artifact);
          counters.artifacts_upserted += 1;
        }
      }

      for (const key of existingRuns) {
        if (seenRuns.has(key)) continue;
        const [project_id, run_id] = key.split("::");
        counters.events_deleted += changesOf(deleteRunEvents.run({ project_id, run_id }));
        counters.event_parse_errors_deleted += changesOf(
          deleteRunParseErrors.run({ project_id, run_id })
        );
        counters.runs_deleted += changesOf(deleteRun.run({ project_id, run_id }));
      }

      for (const key of existingArtifactKeys) {
        if (seenArtifactKeys.has(key)) continue;
        const [project_id, artifact_id] = key.split("::");
        counters.artifacts_deleted += changesOf(deleteArtifact.run({ project_id, artifact_id }));
      }

      const reviewFiles = await listFiles(path.join(workspaceDir, "inbox/reviews"), ".yaml");
      for (const file of reviewFiles) {
        const abs = path.join(workspaceDir, "inbox/reviews", file);
        let review: ReviewYaml;
        try {
          review = ReviewYaml.parse(await readYamlFile(abs));
        } catch {
          continue;
        }
        seenReviewIds.add(review.id);
        upsertReview.run({
          review_id: review.id,
          created_at: review.created_at,
          decision: review.decision,
          actor_id: review.actor_id,
          actor_role: review.actor_role,
          subject_kind: review.subject.kind,
          subject_artifact_id: review.subject.artifact_id,
          project_id: review.subject.project_id,
          notes: review.notes ?? null
        });
        counters.reviews_upserted += 1;
      }

      for (const reviewId of existingReviewIds) {
        if (seenReviewIds.has(reviewId)) continue;
        counters.reviews_deleted += changesOf(deleteReview.run({ review_id: reviewId }));
      }

      const helpFiles = await listFiles(path.join(workspaceDir, "inbox/help_requests"), ".md");
      for (const file of helpFiles) {
        const abs = path.join(workspaceDir, "inbox/help_requests", file);
        let markdown = "";
        try {
          markdown = await fs.readFile(abs, { encoding: "utf8" });
        } catch {
          continue;
        }
        const validated = validateHelpRequestMarkdown(markdown);
        if (!validated.ok) continue;
        const fm = validated.frontmatter;
        seenHelpRequestIds.add(fm.id);
        upsertHelpRequest.run({
          help_request_id: fm.id,
          created_at: fm.created_at,
          title: fm.title,
          visibility: fm.visibility,
          requester: fm.requester,
          target_manager: fm.target_manager,
          project_id: fm.project_id ?? null,
          share_pack_id: fm.share_pack_id ?? null
        });
        counters.help_requests_upserted += 1;
      }

      for (const helpRequestId of existingHelpRequestIds) {
        if (seenHelpRequestIds.has(helpRequestId)) continue;
        counters.help_requests_deleted += changesOf(
          deleteHelpRequest.run({ help_request_id: helpRequestId })
        );
      }

      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }

    return {
      db_path: dbPath,
      db_created: created,
      ...counters
    };
  } finally {
    db.close();
  }
}

export async function rebuildSqliteIndex(workspaceDir: string): Promise<RebuildIndexResult> {
  return withWorkspaceWriteLock(workspaceDir, async () => rebuildSqliteIndexUnlocked(workspaceDir));
}

export async function syncSqliteIndex(workspaceDir: string): Promise<SyncIndexResult> {
  return withWorkspaceWriteLock(workspaceDir, async () => syncSqliteIndexUnlocked(workspaceDir));
}

export type ListIndexedRunsArgs = {
  workspace_dir: string;
  project_id?: string;
  status?: string;
  limit?: number;
};

export async function listIndexedRuns(args: ListIndexedRunsArgs): Promise<IndexedRun[]> {
  const { db } = await openExistingDb(args.workspace_dir);
  try {
    const where: string[] = [];
    const params: Record<string, SQLInputValue> = {};
    if (args.project_id) {
      where.push("project_id = :project_id");
      params.project_id = args.project_id;
    }
    if (args.status) {
      where.push("status = :status");
      params.status = args.status;
    }
    const limit = Math.max(1, Math.min(args.limit ?? 200, 5000));
    params.limit = limit;

    const sql = `
      SELECT project_id, run_id, created_at, status, provider, agent_id, context_pack_id
      FROM runs
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY created_at DESC
      LIMIT :limit
    `;
    const rows = db.prepare(sql).all(params) as IndexedRun[];
    return rows;
  } finally {
    db.close();
  }
}

export type ListIndexedReviewsArgs = {
  workspace_dir: string;
  project_id?: string;
  decision?: "approved" | "denied";
  limit?: number;
};

export type ListIndexedEventsArgs = {
  workspace_dir: string;
  project_id?: string;
  run_id?: string;
  type?: string;
  since_seq?: number;
  limit?: number;
  order?: "asc" | "desc";
};

export async function listIndexedReviews(args: ListIndexedReviewsArgs): Promise<IndexedReview[]> {
  const { db } = await openExistingDb(args.workspace_dir);
  try {
    const where: string[] = [];
    const params: Record<string, SQLInputValue> = {};
    if (args.project_id) {
      where.push("project_id = :project_id");
      params.project_id = args.project_id;
    }
    if (args.decision) {
      where.push("decision = :decision");
      params.decision = ReviewDecision.parse(args.decision);
    }
    const limit = Math.max(1, Math.min(args.limit ?? 200, 5000));
    params.limit = limit;
    const sql = `
      SELECT
        review_id,
        created_at,
        decision,
        actor_id,
        actor_role,
        subject_kind,
        subject_artifact_id,
        project_id,
        notes
      FROM reviews
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY created_at DESC
      LIMIT :limit
    `;
    return db.prepare(sql).all(params) as IndexedReview[];
  } finally {
    db.close();
  }
}

export async function listIndexedEvents(args: ListIndexedEventsArgs): Promise<IndexedEvent[]> {
  const { db } = await openExistingDb(args.workspace_dir);
  try {
    const where: string[] = [];
    const params: Record<string, SQLInputValue> = {};
    if (args.project_id) {
      where.push("project_id = :project_id");
      params.project_id = args.project_id;
    }
    if (args.run_id) {
      where.push("run_id = :run_id");
      params.run_id = args.run_id;
    }
    if (args.type) {
      where.push("type = :type");
      params.type = args.type;
    }
    if (args.since_seq !== undefined) {
      const since = Math.max(0, Math.floor(args.since_seq));
      where.push("seq > :since_seq");
      params.since_seq = since;
    }
    const limit = Math.max(1, Math.min(args.limit ?? 500, 5000));
    params.limit = limit;
    const order = args.order === "asc" ? "ASC" : "DESC";

    const sql = `
      SELECT
        project_id,
        run_id,
        seq,
        type,
        ts_wallclock,
        ts_monotonic_ms,
        actor,
        session_ref,
        visibility,
        payload_json,
        raw_json
      FROM events
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY ts_wallclock ${order}, seq ${order}
      LIMIT :limit
    `;
    return db.prepare(sql).all(params) as IndexedEvent[];
  } finally {
    db.close();
  }
}

export async function listIndexedArtifacts(args: {
  workspace_dir: string;
  project_id?: string;
  artifact_id?: string;
  type?: string;
  run_id?: string;
  limit?: number;
}): Promise<IndexedArtifact[]> {
  const { db } = await openExistingDb(args.workspace_dir);
  try {
    const where: string[] = [];
    const params: Record<string, SQLInputValue> = {};
    if (args.project_id) {
      where.push("project_id = :project_id");
      params.project_id = args.project_id;
    }
    if (args.artifact_id) {
      where.push("artifact_id = :artifact_id");
      params.artifact_id = args.artifact_id;
    }
    if (args.type) {
      where.push("type = :type");
      params.type = args.type;
    }
    if (args.run_id) {
      where.push("run_id = :run_id");
      params.run_id = args.run_id;
    }
    const limit = Math.max(1, Math.min(args.limit ?? 500, 5000));
    params.limit = limit;
    const sql = `
      SELECT
        project_id,
        artifact_id,
        type,
        title,
        visibility,
        produced_by,
        run_id,
        context_pack_id,
        created_at,
        relpath
      FROM artifacts
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY created_at DESC, artifact_id DESC
      LIMIT :limit
    `;
    return db.prepare(sql).all(params) as IndexedArtifact[];
  } finally {
    db.close();
  }
}

export async function listIndexedPendingApprovals(args: {
  workspace_dir: string;
  project_id?: string;
  limit?: number;
}): Promise<IndexedPendingApproval[]> {
  const { db } = await openExistingDb(args.workspace_dir);
  try {
    const where: string[] = [];
    const params: Record<string, SQLInputValue> = {};
    if (args.project_id) {
      where.push("a.project_id = :project_id");
      params.project_id = args.project_id;
    }
    const limit = Math.max(1, Math.min(args.limit ?? 200, 5000));
    params.limit = limit;
    const sql = `
      SELECT
        a.project_id,
        a.artifact_id,
        a.type AS artifact_type,
        a.title,
        a.visibility,
        a.produced_by,
        a.run_id,
        a.created_at
      FROM artifacts a
      WHERE (
        (
          a.type = 'memory_delta'
          AND NOT EXISTS (
            SELECT 1 FROM reviews r
            WHERE r.project_id = a.project_id
              AND r.subject_artifact_id = a.artifact_id
              AND r.subject_kind = 'memory_delta'
          )
        )
        OR
        (
          a.type = 'milestone_report'
          AND NOT EXISTS (
            SELECT 1 FROM reviews r
            WHERE r.project_id = a.project_id
              AND r.subject_artifact_id = a.artifact_id
              AND r.subject_kind = 'milestone'
          )
        )
      )
      ${where.length ? `AND ${where.join(" AND ")}` : ""}
      ORDER BY a.created_at DESC, a.artifact_id DESC
      LIMIT :limit
    `;
    return db.prepare(sql).all(params) as IndexedPendingApproval[];
  } finally {
    db.close();
  }
}

export async function listIndexedReviewDecisions(args: {
  workspace_dir: string;
  project_id?: string;
  decision?: "approved" | "denied";
  limit?: number;
}): Promise<IndexedReviewDecision[]> {
  const { db } = await openExistingDb(args.workspace_dir);
  try {
    const where: string[] = [];
    const params: Record<string, SQLInputValue> = {};
    if (args.project_id) {
      where.push("r.project_id = :project_id");
      params.project_id = args.project_id;
    }
    if (args.decision) {
      where.push("r.decision = :decision");
      params.decision = args.decision;
    }
    const limit = Math.max(1, Math.min(args.limit ?? 200, 5000));
    params.limit = limit;
    const sql = `
      SELECT
        r.review_id,
        r.created_at,
        r.decision,
        r.actor_id,
        r.actor_role,
        r.subject_kind,
        r.subject_artifact_id,
        r.project_id,
        r.notes,
        a.type AS artifact_type,
        a.run_id AS artifact_run_id
      FROM reviews r
      LEFT JOIN artifacts a
        ON a.project_id = r.project_id
       AND a.artifact_id = r.subject_artifact_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY r.created_at DESC, r.review_id DESC
      LIMIT :limit
    `;
    return db.prepare(sql).all(params) as IndexedReviewDecision[];
  } finally {
    db.close();
  }
}

export async function listIndexedRunLastEvents(args: {
  workspace_dir: string;
  project_id?: string;
  limit?: number;
}): Promise<IndexedRunLastEvent[]> {
  const { db } = await openExistingDb(args.workspace_dir);
  try {
    const params: Record<string, SQLInputValue> = {};
    const limit = Math.max(1, Math.min(args.limit ?? 500, 5000));
    params.limit = limit;

    const where = args.project_id ? "WHERE project_id = :project_id" : "";
    if (args.project_id) params.project_id = args.project_id;

    const sql = `
      SELECT
        e.project_id,
        e.run_id,
        e.seq,
        e.type,
        e.ts_wallclock,
        e.actor,
        e.visibility
      FROM events e
      INNER JOIN (
        SELECT project_id, run_id, MAX(seq) AS max_seq
        FROM events
        ${where}
        GROUP BY project_id, run_id
      ) m
      ON e.project_id = m.project_id AND e.run_id = m.run_id AND e.seq = m.max_seq
      ORDER BY e.ts_wallclock DESC, e.seq DESC
      LIMIT :limit
    `;
    return db.prepare(sql).all(params) as IndexedRunLastEvent[];
  } finally {
    db.close();
  }
}

export async function listIndexedRunParseErrorCounts(args: {
  workspace_dir: string;
  project_id?: string;
  limit?: number;
}): Promise<IndexedRunParseErrorCount[]> {
  const { db } = await openExistingDb(args.workspace_dir);
  try {
    const params: Record<string, SQLInputValue> = {};
    const where = args.project_id ? "WHERE project_id = :project_id" : "";
    if (args.project_id) params.project_id = args.project_id;
    const limit = Math.max(1, Math.min(args.limit ?? 500, 5000));
    params.limit = limit;
    const sql = `
      SELECT project_id, run_id, COUNT(*) AS parse_error_count
      FROM event_parse_errors
      ${where}
      GROUP BY project_id, run_id
      ORDER BY parse_error_count DESC, run_id DESC
      LIMIT :limit
    `;
    return db.prepare(sql).all(params) as IndexedRunParseErrorCount[];
  } finally {
    db.close();
  }
}

export async function listIndexedRunEventTypeCounts(args: {
  workspace_dir: string;
  project_id?: string;
  types: string[];
  limit?: number;
}): Promise<IndexedRunEventTypeCount[]> {
  if (args.types.length === 0) return [];
  const { db } = await openExistingDb(args.workspace_dir);
  try {
    const params: Record<string, SQLInputValue> = {};
    const where: string[] = [];
    if (args.project_id) {
      where.push("project_id = :project_id");
      params.project_id = args.project_id;
    }
    const typePlaceholders = args.types.map((_, idx) => `:type_${idx}`);
    for (const [idx, type] of args.types.entries()) {
      params[`type_${idx}`] = type;
    }
    where.push(`type IN (${typePlaceholders.join(", ")})`);
    const limit = Math.max(1, Math.min(args.limit ?? 5000, 20000));
    params.limit = limit;
    const sql = `
      SELECT project_id, run_id, type, COUNT(*) AS event_count
      FROM events
      WHERE ${where.join(" AND ")}
      GROUP BY project_id, run_id, type
      ORDER BY event_count DESC, run_id DESC
      LIMIT :limit
    `;
    return db.prepare(sql).all(params) as IndexedRunEventTypeCount[];
  } finally {
    db.close();
  }
}

export async function listIndexedRunLatestTypedEvents(args: {
  workspace_dir: string;
  project_id?: string;
  types: string[];
  limit?: number;
}): Promise<IndexedRunLatestTypedEvent[]> {
  if (args.types.length === 0) return [];
  const { db } = await openExistingDb(args.workspace_dir);
  try {
    const params: Record<string, SQLInputValue> = {};
    const where: string[] = [];
    if (args.project_id) {
      where.push("project_id = :project_id");
      params.project_id = args.project_id;
    }
    const typePlaceholders = args.types.map((_, idx) => `:type_${idx}`);
    for (const [idx, type] of args.types.entries()) {
      params[`type_${idx}`] = type;
    }
    where.push(`type IN (${typePlaceholders.join(", ")})`);
    const limit = Math.max(1, Math.min(args.limit ?? 5000, 20000));
    params.limit = limit;
    const sql = `
      SELECT project_id, run_id, type, seq, ts_wallclock, payload_json
      FROM (
        SELECT
          project_id,
          run_id,
          type,
          seq,
          ts_wallclock,
          payload_json,
          ROW_NUMBER() OVER (
            PARTITION BY project_id, run_id, type
            ORDER BY seq DESC
          ) AS rn
        FROM events
        WHERE ${where.join(" AND ")}
      ) ranked
      WHERE rn = 1
      ORDER BY ts_wallclock DESC, seq DESC
      LIMIT :limit
    `;
    return db.prepare(sql).all(params) as IndexedRunLatestTypedEvent[];
  } finally {
    db.close();
  }
}

export type ListIndexedHelpRequestsArgs = {
  workspace_dir: string;
  target_manager?: string;
  project_id?: string;
  limit?: number;
};

export async function listIndexedHelpRequests(
  args: ListIndexedHelpRequestsArgs
): Promise<IndexedHelpRequest[]> {
  const { db } = await openExistingDb(args.workspace_dir);
  try {
    const where: string[] = [];
    const params: Record<string, SQLInputValue> = {};
    if (args.target_manager) {
      where.push("target_manager = :target_manager");
      params.target_manager = args.target_manager;
    }
    if (args.project_id) {
      where.push("project_id = :project_id");
      params.project_id = args.project_id;
    }
    const limit = Math.max(1, Math.min(args.limit ?? 200, 5000));
    params.limit = limit;
    const sql = `
      SELECT
        help_request_id,
        created_at,
        title,
        visibility,
        requester,
        target_manager,
        project_id,
        share_pack_id
      FROM help_requests
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY created_at DESC
      LIMIT :limit
    `;
    return db.prepare(sql).all(params) as IndexedHelpRequest[];
  } finally {
    db.close();
  }
}

export async function listIndexedEventParseErrors(args: {
  workspace_dir: string;
  project_id?: string;
  run_id?: string;
  limit?: number;
}): Promise<IndexedEventParseError[]> {
  const { db } = await openExistingDb(args.workspace_dir);
  try {
    const where: string[] = [];
    const params: Record<string, SQLInputValue> = {};
    if (args.project_id) {
      where.push("project_id = :project_id");
      params.project_id = args.project_id;
    }
    if (args.run_id) {
      where.push("run_id = :run_id");
      params.run_id = args.run_id;
    }
    const limit = Math.max(1, Math.min(args.limit ?? 200, 5000));
    params.limit = limit;
    const sql = `
      SELECT project_id, run_id, seq, error, raw_line
      FROM event_parse_errors
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY run_id DESC, seq DESC
      LIMIT :limit
    `;
    return db.prepare(sql).all(params) as IndexedEventParseError[];
  } finally {
    db.close();
  }
}

export type IndexStats = {
  runs: number;
  events: number;
  event_parse_errors: number;
  artifacts: number;
  reviews: number;
  help_requests: number;
};

export async function readIndexStats(workspaceDir: string): Promise<IndexStats> {
  const { db } = await openExistingDb(workspaceDir);
  try {
    const count = (table: string): number => {
      const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number };
      return row.c;
    };
    return {
      runs: count("runs"),
      events: count("events"),
      event_parse_errors: count("event_parse_errors"),
      artifacts: count("artifacts"),
      reviews: count("reviews"),
      help_requests: count("help_requests")
    };
  } finally {
    db.close();
  }
}

export async function readIndexedArtifactFrontmatter(args: {
  workspace_dir: string;
  project_id: string;
  artifact_id: string;
}): Promise<Record<string, unknown> | null> {
  const artifactAbs = path.join(
    args.workspace_dir,
    "work/projects",
    args.project_id,
    "artifacts",
    `${args.artifact_id}.md`
  );
  try {
    const md = await fs.readFile(artifactAbs, { encoding: "utf8" });
    const parsed = parseFrontMatter(md);
    if (!parsed.ok) return null;
    if (!parsed.frontmatter || typeof parsed.frontmatter !== "object") return null;
    return parsed.frontmatter as Record<string, unknown>;
  } catch {
    return null;
  }
}
