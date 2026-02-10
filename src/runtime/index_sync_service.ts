import type { IndexSyncWorker, IndexSyncWorkerStatus } from "../index/sync_worker.js";

export type IndexSyncServiceStatus = {
  enabled: boolean;
} & IndexSyncWorkerStatus;

let workerRef: IndexSyncWorker | null = null;

function disabledStatus(): IndexSyncServiceStatus {
  return {
    enabled: false,
    running: false,
    closed: true,
    pending_workspaces: 0,
    debounce_ms: 0,
    min_interval_ms: 0,
    last_run_at_ms: null,
    last_notify_at_ms: null,
    last_notified_workspace: null,
    last_batch_started_at_ms: null,
    last_batch_completed_at_ms: null,
    total_notify_calls: 0,
    total_batches: 0,
    total_workspace_sync_attempts: 0,
    total_workspace_sync_errors: 0,
    last_error_message: null,
    last_error_workspace: null,
    last_error_at_ms: null
  };
}

export function registerIndexSyncWorker(worker: IndexSyncWorker | null): void {
  workerRef = worker;
}

export function readIndexSyncWorkerStatus(): IndexSyncServiceStatus {
  if (!workerRef) return disabledStatus();
  return {
    enabled: true,
    ...workerRef.status()
  };
}

export async function flushIndexSyncWorker(): Promise<IndexSyncServiceStatus> {
  if (!workerRef) return disabledStatus();
  await workerRef.flush();
  return {
    enabled: true,
    ...workerRef.status()
  };
}
