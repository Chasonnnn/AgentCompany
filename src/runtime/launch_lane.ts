import path from "node:path";

type LaneState = {
  tail: Promise<void>;
  pending: number;
  running: number;
};

const lanes = new Map<string, LaneState>();

function laneKey(workspaceDir: string): string {
  return path.resolve(workspaceDir);
}

function getOrCreateLane(key: string): LaneState {
  const existing = lanes.get(key);
  if (existing) return existing;
  const created: LaneState = {
    tail: Promise.resolve(),
    pending: 0,
    running: 0
  };
  lanes.set(key, created);
  return created;
}

function maybeCleanupLane(key: string): void {
  const state = lanes.get(key);
  if (!state) return;
  if (state.pending === 0 && state.running === 0) {
    lanes.delete(key);
  }
}

export async function withLaunchLane<T>(workspaceDir: string, fn: () => Promise<T>): Promise<T> {
  const key = laneKey(workspaceDir);
  const lane = getOrCreateLane(key);
  lane.pending += 1;
  const waitFor = lane.tail;
  let releaseQueue!: () => void;
  const queued = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  lane.tail = waitFor.then(() => queued);
  await waitFor;
  lane.pending = Math.max(0, lane.pending - 1);
  lane.running += 1;
  try {
    return await fn();
  } finally {
    lane.running = Math.max(0, lane.running - 1);
    releaseQueue();
    maybeCleanupLane(key);
  }
}

export function readLaunchLaneStatsForWorkspace(workspaceDir: string): {
  workspace_dir: string;
  pending: number;
  running: number;
} {
  const key = laneKey(workspaceDir);
  const lane = lanes.get(key);
  return {
    workspace_dir: key,
    pending: lane?.pending ?? 0,
    running: lane?.running ?? 0
  };
}
