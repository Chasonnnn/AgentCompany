export type IndexSyncWorkerOptions = {
  sync: (workspace_dir: string) => Promise<void>;
  debounce_ms?: number;
  min_interval_ms?: number;
  on_error?: (error: unknown, workspace_dir: string) => void;
};

export type IndexSyncWorkerStatus = {
  running: boolean;
  closed: boolean;
  pending_workspaces: number;
  debounce_ms: number;
  min_interval_ms: number;
  last_run_at_ms: number | null;
  last_notify_at_ms: number | null;
  last_notified_workspace: string | null;
  last_batch_started_at_ms: number | null;
  last_batch_completed_at_ms: number | null;
  total_notify_calls: number;
  total_batches: number;
  total_workspace_sync_attempts: number;
  total_workspace_sync_errors: number;
  last_error_message: string | null;
  last_error_workspace: string | null;
  last_error_at_ms: number | null;
};

export type IndexSyncWorker = {
  notify: (workspace_dir: string) => void;
  flush: () => Promise<void>;
  close: () => Promise<void>;
  status: () => IndexSyncWorkerStatus;
};

export function createIndexSyncWorker(opts: IndexSyncWorkerOptions): IndexSyncWorker {
  const debounceMs = Math.max(0, opts.debounce_ms ?? 250);
  const minIntervalMs = Math.max(0, opts.min_interval_ms ?? 1000);

  const pending = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let closed = false;
  let lastRunAtMs = 0;
  let runningPromise: Promise<void> | null = null;
  let lastNotifyAtMs: number | null = null;
  let lastNotifiedWorkspace: string | null = null;
  let lastBatchStartedAtMs: number | null = null;
  let lastBatchCompletedAtMs: number | null = null;
  let totalNotifyCalls = 0;
  let totalBatches = 0;
  let totalWorkspaceSyncAttempts = 0;
  let totalWorkspaceSyncErrors = 0;
  let lastErrorMessage: string | null = null;
  let lastErrorWorkspace: string | null = null;
  let lastErrorAtMs: number | null = null;

  const schedule = (): void => {
    if (closed || running || timer || pending.size === 0) return;
    const now = Date.now();
    const earliestByThrottle = lastRunAtMs + minIntervalMs;
    const target = Math.max(now + debounceMs, earliestByThrottle);
    const delay = Math.max(0, target - now);
    timer = setTimeout(() => {
      timer = null;
      void runOnce();
    }, delay);
    timer.unref?.();
  };

  const runOnce = async (): Promise<void> => {
    if (closed || running || pending.size === 0) return;
    const batch = [...pending];
    pending.clear();
    running = true;
    totalBatches += 1;
    lastBatchStartedAtMs = Date.now();
    runningPromise = (async () => {
      try {
        for (const workspaceDir of batch) {
          totalWorkspaceSyncAttempts += 1;
          try {
            await opts.sync(workspaceDir);
          } catch (e) {
            totalWorkspaceSyncErrors += 1;
            lastErrorMessage = e instanceof Error ? e.message : String(e);
            lastErrorWorkspace = workspaceDir;
            lastErrorAtMs = Date.now();
            opts.on_error?.(e, workspaceDir);
          }
        }
      } finally {
        lastRunAtMs = Date.now();
        lastBatchCompletedAtMs = lastRunAtMs;
        running = false;
        runningPromise = null;
        schedule();
      }
    })();
    await runningPromise;
  };

  const flush = async (): Promise<void> => {
    if (closed) return;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    while (!closed && (running || pending.size > 0)) {
      if (runningPromise) {
        await runningPromise;
      } else if (pending.size > 0) {
        await runOnce();
      }
    }
  };

  const close = async (): Promise<void> => {
    if (closed) return;
    await flush();
    closed = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (runningPromise) {
      await runningPromise;
    }
    pending.clear();
  };

  return {
    notify: (workspaceDir: string) => {
      if (closed) return;
      if (!workspaceDir.trim()) return;
      totalNotifyCalls += 1;
      lastNotifyAtMs = Date.now();
      lastNotifiedWorkspace = workspaceDir;
      pending.add(workspaceDir);
      schedule();
    },
    flush,
    close,
    status: () => ({
      running,
      closed,
      pending_workspaces: pending.size,
      debounce_ms: debounceMs,
      min_interval_ms: minIntervalMs,
      last_run_at_ms: lastRunAtMs > 0 ? lastRunAtMs : null,
      last_notify_at_ms: lastNotifyAtMs,
      last_notified_workspace: lastNotifiedWorkspace,
      last_batch_started_at_ms: lastBatchStartedAtMs,
      last_batch_completed_at_ms: lastBatchCompletedAtMs,
      total_notify_calls: totalNotifyCalls,
      total_batches: totalBatches,
      total_workspace_sync_attempts: totalWorkspaceSyncAttempts,
      total_workspace_sync_errors: totalWorkspaceSyncErrors,
      last_error_message: lastErrorMessage,
      last_error_workspace: lastErrorWorkspace,
      last_error_at_ms: lastErrorAtMs
    })
  };
}
