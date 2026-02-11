import { nowIso } from "../core/time.js";
import { buildRunMonitorSnapshot, type RunMonitorSnapshot } from "./run_monitor.js";
import { buildReviewInboxSnapshot, type ReviewInboxSnapshot } from "./review_inbox.js";
import { readIndexSyncWorkerStatus, type IndexSyncServiceStatus } from "./index_sync_service.js";
import { buildUiColleagues, type UiColleague } from "./colleagues.js";
import { listComments, type CommentEntry } from "../comments/comment.js";
import { buildUsageAnalyticsSnapshot, type UsageAnalyticsSnapshot } from "./usage_analytics.js";

export type UiSnapshotArgs = {
  workspace_dir: string;
  project_id?: string;
  monitor_limit?: number;
  pending_limit?: number;
  decisions_limit?: number;
  comments_limit?: number;
  refresh_index?: boolean;
  sync_index?: boolean;
};

export type UiSnapshot = {
  workspace_dir: string;
  generated_at: string;
  index_sync_worker: IndexSyncServiceStatus;
  monitor: RunMonitorSnapshot;
  review_inbox: ReviewInboxSnapshot;
  usage_analytics: UsageAnalyticsSnapshot;
  colleagues: UiColleague[];
  comments: CommentEntry[];
};

export async function buildUiSnapshot(args: UiSnapshotArgs): Promise<UiSnapshot> {
  const monitor = await buildRunMonitorSnapshot({
    workspace_dir: args.workspace_dir,
    project_id: args.project_id,
    limit: args.monitor_limit,
    refresh_index: args.refresh_index,
    sync_index: args.sync_index
  });
  const reviewInbox = await buildReviewInboxSnapshot({
    workspace_dir: args.workspace_dir,
    project_id: args.project_id,
    pending_limit: args.pending_limit,
    decisions_limit: args.decisions_limit,
    refresh_index: false,
    sync_index: false
  });
  // ui.snapshot performs index write paths once via monitor, then reuses indexed reads.
  reviewInbox.index_rebuilt = monitor.index_rebuilt;
  reviewInbox.index_synced = monitor.index_synced;
  const usageAnalytics = await buildUsageAnalyticsSnapshot({
    workspace_dir: args.workspace_dir,
    project_id: args.project_id,
    limit: args.monitor_limit,
    refresh_index: false,
    sync_index: false
  });
  usageAnalytics.index_rebuilt = monitor.index_rebuilt;
  usageAnalytics.index_synced = monitor.index_synced;
  const colleagues = await buildUiColleagues({
    workspace_dir: args.workspace_dir,
    monitor,
    review_inbox: reviewInbox
  });
  const comments =
    args.project_id == null
      ? []
      : await listComments({
          workspace_dir: args.workspace_dir,
          project_id: args.project_id,
          limit: args.comments_limit
        });

  return {
    workspace_dir: args.workspace_dir,
    generated_at: nowIso(),
    index_sync_worker: readIndexSyncWorkerStatus(),
    monitor,
    review_inbox: reviewInbox,
    usage_analytics: usageAnalytics,
    colleagues,
    comments
  };
}
