import fs from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

const writeQueues = new Map<string, Promise<void>>();
const workspaceRootCache = new Map<string, string>();
const LOCK_WAIT_MS = 25;
const LOCK_TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 2 * 60 * 1000;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function syncDirectory(dirPath: string): Promise<void> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(dirPath, "r");
    await handle.sync();
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EPERM") throw e;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function isPidAlive(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code !== "ESRCH";
  }
}

async function resolveWorkspaceRootForPath(filePath: string): Promise<string | null> {
  let dir = path.resolve(path.dirname(filePath));
  const visited: string[] = [];
  // Climb up until root; workspace root is a folder containing company/company.yaml.
  // This keeps write locking scoped to workspace state and avoids globally serializing unrelated writes.
  while (true) {
    const cached = workspaceRootCache.get(dir);
    if (cached) {
      for (const v of visited) workspaceRootCache.set(v, cached);
      return cached;
    }
    visited.push(dir);
    if (await pathExists(path.join(dir, "company", "company.yaml"))) {
      for (const v of visited) workspaceRootCache.set(v, dir);
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

async function clearStaleWorkspaceLock(lockPath: string, staleMs: number): Promise<void> {
  let stat: Stats;
  try {
    stat = await fs.stat(lockPath);
  } catch {
    return;
  }
  const lockAge = Date.now() - stat.mtimeMs;
  if (!Number.isFinite(lockAge) || lockAge < staleMs) return;

  let ownerPid: number | undefined;
  try {
    const raw = await fs.readFile(lockPath, { encoding: "utf8" });
    const parsed = JSON.parse(raw) as { pid?: unknown };
    if (typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0) {
      ownerPid = parsed.pid;
    }
  } catch {
    // If lock payload is unreadable and stale, treat it as stale lock metadata.
  }

  if (ownerPid !== undefined && (await isPidAlive(ownerPid))) return;
  await fs.unlink(lockPath).catch(() => {});
}

async function acquireWorkspaceLock(workspaceRoot: string): Promise<() => Promise<void>> {
  const lockDir = path.join(workspaceRoot, ".local", "locks");
  await ensureDir(lockDir);
  const lockPath = path.join(lockDir, "workspace.write.lock");
  const start = Date.now();

  // Retry until timeout; stale lock cleanup handles crashed writers.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(lockPath, "wx");
      const payload = `${JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() })}\n`;
      await handle.writeFile(payload, { encoding: "utf8" });
      await handle.sync();
      return async () => {
        await handle?.close().catch(() => {});
        await fs.unlink(lockPath).catch(() => {});
      };
    } catch (e) {
      await handle?.close().catch(() => {});
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw e;
      await clearStaleWorkspaceLock(lockPath, LOCK_STALE_MS);
      if (Date.now() - start >= LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for workspace write lock: ${lockPath}`);
      }
      await sleep(LOCK_WAIT_MS);
    }
  }
}

async function withWriteQueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeQueues.get(key) ?? Promise.resolve();
  let resolveNext!: () => void;
  const next = new Promise<void>((resolve) => {
    resolveNext = resolve;
  });
  writeQueues.set(key, prev.then(() => next));
  await prev;
  try {
    return await fn();
  } finally {
    resolveNext();
    if (writeQueues.get(key) === next) writeQueues.delete(key);
  }
}

async function withPathWriteLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const workspaceRoot = await resolveWorkspaceRootForPath(filePath);
  const queueKey = workspaceRoot ? `workspace:${workspaceRoot}` : `file:${path.resolve(filePath)}`;
  return withWriteQueue(queueKey, async () => {
    if (!workspaceRoot) return fn();
    const release = await acquireWorkspaceLock(workspaceRoot);
    try {
      return await fn();
    } finally {
      await release();
    }
  });
}

export type WriteAtomicOptions = {
  workspace_lock?: boolean;
};

export async function writeFileAtomic(
  filePath: string,
  contents: string,
  opts: WriteAtomicOptions = {}
): Promise<void> {
  const absolutePath = path.resolve(filePath);
  const withLock =
    opts.workspace_lock === false
      ? async <T>(fn: () => Promise<T>): Promise<T> => withWriteQueue(`file:${absolutePath}`, fn)
      : async <T>(fn: () => Promise<T>): Promise<T> => withPathWriteLock(absolutePath, fn);

  await withLock(async () => {
    const dir = path.dirname(absolutePath);
    await ensureDir(dir);
    const tmpPath = path.join(
      dir,
      `.${path.basename(absolutePath)}.tmp-${process.pid}-${Date.now()}-${Math.random()
        .toString(16)
        .slice(2)}`
    );
    let tmpHandle: fs.FileHandle | undefined;
    try {
      tmpHandle = await fs.open(tmpPath, "w");
      await tmpHandle.writeFile(contents, { encoding: "utf8" });
      await tmpHandle.sync();
      await tmpHandle.close();
      tmpHandle = undefined;
      await fs.rename(tmpPath, absolutePath);
      await syncDirectory(dir);
    } finally {
      await tmpHandle?.close().catch(() => {});
      await fs.unlink(tmpPath).catch(() => {});
    }
  });
}

export async function appendFileAtomic(
  filePath: string,
  contents: string,
  opts: WriteAtomicOptions = {}
): Promise<void> {
  const absolutePath = path.resolve(filePath);
  const withLock =
    opts.workspace_lock === false
      ? async <T>(fn: () => Promise<T>): Promise<T> => withWriteQueue(`file:${absolutePath}`, fn)
      : async <T>(fn: () => Promise<T>): Promise<T> => withPathWriteLock(absolutePath, fn);

  await withLock(async () => {
    const dir = path.dirname(absolutePath);
    await ensureDir(dir);
    const fileHandle = await fs.open(absolutePath, "a");
    try {
      await fileHandle.writeFile(contents, { encoding: "utf8" });
      await fileHandle.sync();
    } finally {
      await fileHandle.close().catch(() => {});
    }
    await syncDirectory(dir);
  });
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}
