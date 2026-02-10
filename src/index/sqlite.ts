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

type RebuildCounters = {
  runs_indexed: number;
  events_indexed: number;
  event_parse_errors: number;
  reviews_indexed: number;
  help_requests_indexed: number;
};

export type RebuildIndexResult = RebuildCounters & {
  db_path: string;
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

export async function rebuildSqliteIndex(workspaceDir: string): Promise<RebuildIndexResult> {
  const { db, dbPath } = await openFreshDb(workspaceDir);
  const counters: RebuildCounters = {
    runs_indexed: 0,
    events_indexed: 0,
    event_parse_errors: 0,
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
