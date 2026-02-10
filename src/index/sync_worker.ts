export type IndexSyncWorkerOptions = {
  sync: (workspace_dir: string) => Promise<void>;
  debounce_ms?: number;
  min_interval_ms?: number;
  on_error?: (error: unknown, workspace_dir: string) => void;
};

export type IndexSyncWorker = {
  notify: (workspace_dir: string) => void;
  flush: () => Promise<void>;
  close: () => Promise<void>;
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
    runningPromise = (async () => {
      try {
        for (const workspaceDir of batch) {
          try {
            await opts.sync(workspaceDir);
          } catch (e) {
            opts.on_error?.(e, workspaceDir);
          }
        }
      } finally {
        lastRunAtMs = Date.now();
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
      pending.add(workspaceDir);
      schedule();
    },
    flush,
    close
  };
}
