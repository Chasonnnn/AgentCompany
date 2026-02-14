import { nowIso } from "../core/time.js";
import { buildRunMonitorSnapshot, type RunMonitorSnapshot } from "./run_monitor.js";
import { buildReviewInboxSnapshot, type ReviewInboxSnapshot } from "./review_inbox.js";
import { readIndexSyncWorkerStatus, type IndexSyncServiceStatus } from "./index_sync_service.js";
import { buildUiColleagues, type UiColleague } from "./colleagues.js";
import { listComments, type CommentEntry } from "../comments/comment.js";
import { buildUsageAnalyticsSnapshot, type UsageAnalyticsSnapshot } from "./usage_analytics.js";
import { readHeartbeatConfig, readHeartbeatState } from "./heartbeat_store.js";

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
  heartbeat: {
    enabled: boolean;
    running: boolean;
    tick_interval_minutes: number;
    top_k_workers: number;
    min_wake_score: number;
    hierarchy_mode: "standard" | "enterprise_v1";
    executive_manager_agent_id?: string;
    allow_director_to_spawn_workers: boolean;
    last_tick_at?: string;
    next_tick_at?: string;
    stats: {
      ticks_total: number;
      workers_woken_total: number;
      reports_ok_total: number;
      reports_actions_total: number;
      actions_executed_total: number;
      approvals_queued_total: number;
      deduped_actions_total: number;
    };
  };
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
  const [reviewInbox, usageAnalytics, heartbeatConfig, heartbeatState] = await Promise.all([
    buildReviewInboxSnapshot({
      workspace_dir: args.workspace_dir,
      project_id: args.project_id,
      pending_limit: args.pending_limit,
      decisions_limit: args.decisions_limit,
      refresh_index: false,
      sync_index: false
    }),
    buildUsageAnalyticsSnapshot({
      workspace_dir: args.workspace_dir,
      project_id: args.project_id,
      limit: args.monitor_limit,
      refresh_index: false,
      sync_index: false
    }),
    readHeartbeatConfig(args.workspace_dir),
    readHeartbeatState(args.workspace_dir)
  ]);
  // ui.snapshot performs index write paths once via monitor, then reuses indexed reads.
  reviewInbox.index_rebuilt = monitor.index_rebuilt;
  reviewInbox.index_synced = monitor.index_synced;
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
    heartbeat: {
      enabled: heartbeatConfig.enabled,
      running: heartbeatState.running,
      tick_interval_minutes: heartbeatConfig.tick_interval_minutes,
      top_k_workers: heartbeatConfig.top_k_workers,
      min_wake_score: heartbeatConfig.min_wake_score,
      hierarchy_mode: heartbeatConfig.hierarchy_mode,
      executive_manager_agent_id: heartbeatConfig.executive_manager_agent_id,
      allow_director_to_spawn_workers: heartbeatConfig.allow_director_to_spawn_workers,
      last_tick_at: heartbeatState.last_tick_at,
      next_tick_at: heartbeatState.next_tick_at,
      stats: {
        ticks_total: heartbeatState.stats.ticks_total,
        workers_woken_total: heartbeatState.stats.workers_woken_total,
        reports_ok_total: heartbeatState.stats.reports_ok_total,
        reports_actions_total: heartbeatState.stats.reports_actions_total,
        actions_executed_total: heartbeatState.stats.actions_executed_total,
        approvals_queued_total: heartbeatState.stats.approvals_queued_total,
        deduped_actions_total: heartbeatState.stats.deduped_actions_total
      }
    },
    monitor,
    review_inbox: reviewInbox,
    usage_analytics: usageAnalytics,
    colleagues,
    comments
  };
}
