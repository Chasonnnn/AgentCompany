import { nowIso } from "../core/time.js";
import {
  indexDbPath,
  rebuildSqliteIndex,
  syncSqliteIndex,
  listIndexedPendingApprovals,
  listIndexedReviewDecisions,
  listIndexedRunParseErrorCounts
} from "../index/sqlite.js";
import { pathExists } from "../store/fs.js";

export type ReviewInboxSnapshotArgs = {
  workspace_dir: string;
  project_id?: string;
  pending_limit?: number;
  decisions_limit?: number;
  refresh_index?: boolean;
  sync_index?: boolean;
};

export type ReviewInboxPendingItem = {
  project_id: string;
  artifact_id: string;
  artifact_type: string;
  title: string | null;
  visibility: string | null;
  produced_by: string | null;
  run_id: string | null;
  created_at: string | null;
  parse_error_count: number;
};

export type ReviewInboxDecisionItem = {
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
  run_id: string | null;
  parse_error_count: number;
};

export type ReviewInboxSnapshot = {
  workspace_dir: string;
  generated_at: string;
  index_rebuilt: boolean;
  index_synced: boolean;
  parse_errors: {
    has_parse_errors: boolean;
    pending_with_errors: number;
    decisions_with_errors: number;
    max_parse_error_count: number;
  };
  pending: ReviewInboxPendingItem[];
  recent_decisions: ReviewInboxDecisionItem[];
};

export async function buildReviewInboxSnapshot(
  args: ReviewInboxSnapshotArgs
): Promise<ReviewInboxSnapshot> {
  let indexRebuilt = false;
  let indexSynced = false;
  const dbPath = indexDbPath(args.workspace_dir);
  const dbExists = await pathExists(dbPath);
  if (args.refresh_index || !dbExists) {
    await rebuildSqliteIndex(args.workspace_dir);
    indexRebuilt = true;
  } else if (args.sync_index !== false) {
    await syncSqliteIndex(args.workspace_dir);
    indexSynced = true;
  }

  const [pending, decisions, parseCounts] = await Promise.all([
    listIndexedPendingApprovals({
      workspace_dir: args.workspace_dir,
      project_id: args.project_id,
      limit: args.pending_limit ?? 200
    }),
    listIndexedReviewDecisions({
      workspace_dir: args.workspace_dir,
      project_id: args.project_id,
      limit: args.decisions_limit ?? 200
    }),
    listIndexedRunParseErrorCounts({
      workspace_dir: args.workspace_dir,
      project_id: args.project_id,
      limit: 2000
    })
  ]);

  const parseByRun = new Map<string, number>();
  for (const row of parseCounts) {
    parseByRun.set(`${row.project_id}::${row.run_id}`, row.parse_error_count);
  }

  const pendingItems: ReviewInboxPendingItem[] = pending.map((p) => ({
    project_id: p.project_id,
    artifact_id: p.artifact_id,
    artifact_type: p.artifact_type,
    title: p.title,
    visibility: p.visibility,
    produced_by: p.produced_by,
    run_id: p.run_id,
    created_at: p.created_at,
    parse_error_count: p.run_id ? (parseByRun.get(`${p.project_id}::${p.run_id}`) ?? 0) : 0
  }));

  const decisionItems: ReviewInboxDecisionItem[] = decisions.map((d) => ({
    review_id: d.review_id,
    created_at: d.created_at,
    decision: d.decision,
    actor_id: d.actor_id,
    actor_role: d.actor_role,
    subject_kind: d.subject_kind,
    subject_artifact_id: d.subject_artifact_id,
    project_id: d.project_id,
    notes: d.notes ?? null,
    artifact_type: d.artifact_type ?? null,
    run_id: d.artifact_run_id ?? null,
    parse_error_count: d.artifact_run_id
      ? (parseByRun.get(`${d.project_id}::${d.artifact_run_id}`) ?? 0)
      : 0
  }));

  const pendingWithErrors = pendingItems.filter((p) => p.parse_error_count > 0).length;
  const decisionsWithErrors = decisionItems.filter((d) => d.parse_error_count > 0).length;
  const maxParseErrorCount = Math.max(
    0,
    ...pendingItems.map((p) => p.parse_error_count),
    ...decisionItems.map((d) => d.parse_error_count)
  );

  return {
    workspace_dir: args.workspace_dir,
    generated_at: nowIso(),
    index_rebuilt: indexRebuilt,
    index_synced: indexSynced,
    parse_errors: {
      has_parse_errors: maxParseErrorCount > 0,
      pending_with_errors: pendingWithErrors,
      decisions_with_errors: decisionsWithErrors,
      max_parse_error_count: maxParseErrorCount
    },
    pending: pendingItems,
    recent_decisions: decisionItems
  };
}
