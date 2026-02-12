import path from "node:path";

export const LaunchLanePriorities = ["high", "normal", "low"] as const;
export type LaunchLanePriority = (typeof LaunchLanePriorities)[number];

export type LaunchLaneOptions = {
  provider?: string;
  team_id?: string;
  priority?: LaunchLanePriority;
  workspace_limit?: number;
  provider_limit?: number;
  team_limit?: number;
};

type QueueItem<T> = {
  id: number;
  provider: string;
  team_id: string;
  priority: LaunchLanePriority;
  workspace_limit: number;
  provider_limit: number;
  team_limit: number;
  run: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

type LaneState = {
  queue: QueueItem<any>[];
  running: number;
  running_by_provider: Map<string, number>;
  running_by_team: Map<string, number>;
  draining: boolean;
};

const lanes = new Map<string, LaneState>();
let nextQueueId = 1;

function laneKey(workspaceDir: string): string {
  return path.resolve(workspaceDir);
}

function readEnvLimit(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) return fallback;
  return value;
}

function normalizePriority(value: LaunchLanePriority | undefined): LaunchLanePriority {
  if (value === "high" || value === "low" || value === "normal") return value;
  return "normal";
}

function priorityRank(priority: LaunchLanePriority): number {
  if (priority === "high") return 0;
  if (priority === "normal") return 1;
  return 2;
}

function getOrCreateLane(key: string): LaneState {
  const existing = lanes.get(key);
  if (existing) return existing;
  const created: LaneState = {
    queue: [],
    running: 0,
    running_by_provider: new Map<string, number>(),
    running_by_team: new Map<string, number>(),
    draining: false
  };
  lanes.set(key, created);
  return created;
}

function getRunningByProvider(state: LaneState, provider: string): number {
  return state.running_by_provider.get(provider) ?? 0;
}

function getRunningByTeam(state: LaneState, teamId: string): number {
  return state.running_by_team.get(teamId) ?? 0;
}

function findRunnableIndex(state: LaneState): number {
  if (state.queue.length === 0) return -1;
  const indices = state.queue
    .map((q, idx) => ({ idx, rank: priorityRank(q.priority), id: q.id }))
    .sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : a.id - b.id));
  for (const entry of indices) {
    const item = state.queue[entry.idx];
    if (state.running >= item.workspace_limit) continue;
    if (getRunningByProvider(state, item.provider) >= item.provider_limit) continue;
    if (getRunningByTeam(state, item.team_id) >= item.team_limit) continue;
    return entry.idx;
  }
  return -1;
}

function incrementMapCount(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function decrementMapCount(map: Map<string, number>, key: string): void {
  const curr = map.get(key) ?? 0;
  if (curr <= 1) map.delete(key);
  else map.set(key, curr - 1);
}

function maybeCleanupLane(key: string): void {
  const state = lanes.get(key);
  if (!state) return;
  if (state.running === 0 && state.queue.length === 0 && !state.draining) {
    lanes.delete(key);
  }
}

function scheduleDrain(key: string): void {
  const state = lanes.get(key);
  if (!state) return;
  if (state.draining) return;
  state.draining = true;
  queueMicrotask(() => {
    void drainLane(key);
  });
}

async function drainLane(key: string): Promise<void> {
  const state = lanes.get(key);
  if (!state) return;
  try {
    // Start as many queued jobs as capacity allows.
    while (true) {
      const idx = findRunnableIndex(state);
      if (idx < 0) break;
      const [item] = state.queue.splice(idx, 1);
      if (!item) break;
      state.running += 1;
      incrementMapCount(state.running_by_provider, item.provider);
      incrementMapCount(state.running_by_team, item.team_id);

      void (async () => {
        try {
          const value = await item.run();
          item.resolve(value);
        } catch (e) {
          item.reject(e);
        } finally {
          state.running = Math.max(0, state.running - 1);
          decrementMapCount(state.running_by_provider, item.provider);
          decrementMapCount(state.running_by_team, item.team_id);
          scheduleDrain(key);
          maybeCleanupLane(key);
        }
      })();
    }
  } finally {
    state.draining = false;
    // If new work arrived while we were draining, continue.
    if (state.queue.length > 0 && findRunnableIndex(state) >= 0) {
      scheduleDrain(key);
    } else {
      maybeCleanupLane(key);
    }
  }
}

function normalizeArgs<T>(
  workspaceDir: string,
  optionsOrFn: LaunchLaneOptions | (() => Promise<T>),
  maybeFn?: () => Promise<T>
): { key: string; options: Required<Pick<LaunchLaneOptions, "provider" | "team_id" | "priority">> & {
  workspace_limit: number;
  provider_limit: number;
  team_limit: number;
}; fn: () => Promise<T> } {
  const key = laneKey(workspaceDir);
  const fn = typeof optionsOrFn === "function" ? optionsOrFn : maybeFn;
  if (!fn) throw new Error("withLaunchLane requires an async function");
  const opts: LaunchLaneOptions =
    typeof optionsOrFn === "function" ? {} : optionsOrFn;

  const workspaceLimit = normalizeLimit(
    opts.workspace_limit,
    readEnvLimit("AC_LAUNCH_WORKSPACE_LIMIT", 1)
  );
  const providerLimit = normalizeLimit(
    opts.provider_limit,
    readEnvLimit("AC_LAUNCH_PROVIDER_LIMIT", 1)
  );
  const teamLimit = normalizeLimit(opts.team_limit, readEnvLimit("AC_LAUNCH_TEAM_LIMIT", 1));
  const provider = opts.provider?.trim() ? opts.provider.trim() : "__default_provider__";
  const teamId = opts.team_id?.trim() ? opts.team_id.trim() : "__default_team__";
  const priority = normalizePriority(opts.priority);

  return {
    key,
    options: {
      provider,
      team_id: teamId,
      priority,
      workspace_limit: workspaceLimit,
      provider_limit: providerLimit,
      team_limit: teamLimit
    },
    fn
  };
}

export async function withLaunchLane<T>(workspaceDir: string, fn: () => Promise<T>): Promise<T>;
export async function withLaunchLane<T>(
  workspaceDir: string,
  options: LaunchLaneOptions,
  fn: () => Promise<T>
): Promise<T>;
export async function withLaunchLane<T>(
  workspaceDir: string,
  optionsOrFn: LaunchLaneOptions | (() => Promise<T>),
  maybeFn?: () => Promise<T>
): Promise<T> {
  const normalized = normalizeArgs(workspaceDir, optionsOrFn, maybeFn);
  const lane = getOrCreateLane(normalized.key);
  return await new Promise<T>((resolve, reject) => {
    lane.queue.push({
      id: nextQueueId++,
      provider: normalized.options.provider,
      team_id: normalized.options.team_id,
      priority: normalized.options.priority,
      workspace_limit: normalized.options.workspace_limit,
      provider_limit: normalized.options.provider_limit,
      team_limit: normalized.options.team_limit,
      run: normalized.fn,
      resolve,
      reject
    });
    scheduleDrain(normalized.key);
  });
}

export function readLaunchLaneStatsForWorkspace(workspaceDir: string): {
  workspace_dir: string;
  pending: number;
  running: number;
  pending_high: number;
  pending_normal: number;
  pending_low: number;
  running_by_provider: Record<string, number>;
  running_by_team: Record<string, number>;
} {
  const key = laneKey(workspaceDir);
  const lane = lanes.get(key);
  const pendingHigh = lane?.queue.filter((q) => q.priority === "high").length ?? 0;
  const pendingNormal = lane?.queue.filter((q) => q.priority === "normal").length ?? 0;
  const pendingLow = lane?.queue.filter((q) => q.priority === "low").length ?? 0;

  return {
    workspace_dir: key,
    pending: lane?.queue.length ?? 0,
    running: lane?.running ?? 0,
    pending_high: pendingHigh,
    pending_normal: pendingNormal,
    pending_low: pendingLow,
    running_by_provider: Object.fromEntries(lane?.running_by_provider ?? []),
    running_by_team: Object.fromEntries(lane?.running_by_team ?? [])
  };
}
