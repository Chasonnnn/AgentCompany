import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_SETTLE_MS = 1_500;
const POLL_INTERVAL_MS = 100;

const TRACKED_PROCESS_PATTERNS = [
  /\bpaperclipai run\b/,
  /\bcli\/src\/index\.ts run --config\b/,
  /(?:^|\s)(?:[^ ]+\/)?server\/(?:dist\/index\.js|src\/index\.ts)\b/,
  /\bclaude\s+(?:--print\b.*\b--output-format\s+(?:stream-json|json)\b|auth\s+status\b|login\b)/,
  /\bcodex\s+(?:--search\s+)?(?:exec\s+--json\b|resume\s+\S+\s+-\b)/,
  /\bgemini\b.*(?:^|\s)--output-format\s+(?:stream-json|json)\b/,
  /\bagent\s+-p\b.*(?:^|\s)--output-format\s+(?:stream-json|json)\b/,
  /\bopencode\s+run\s+--format\s+json\b/,
  /\bpi\s+--mode\s+json\b.*(?:\s|^)-p(?:\s|$)/,
  /(?:\/|\\)paperclip-skills-[^/\\\s]+/,
];

function parseProcessLine(line) {
  const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
  if (!match) return null;

  const pid = Number.parseInt(match[1] ?? "", 10);
  const pgid = Number.parseInt(match[2] ?? "", 10);
  const ppid = Number.parseInt(match[3] ?? "", 10);
  const etime = match[4] ?? "";
  const command = match[5] ?? "";

  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (!Number.isInteger(pgid) || pgid <= 0) return null;
  if (!Number.isInteger(ppid) || ppid < 0) return null;
  if (!command.trim()) return null;

  return { pid, pgid, ppid, etime, command };
}

export function isTrackedProcessCommand(command) {
  const normalized = command.replace(/\s+/g, " ").trim();
  return TRACKED_PROCESS_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function findTrackedProcessLeaks(baselinePids, processes) {
  return processes.filter((processInfo) => !baselinePids.has(processInfo.pid));
}

export async function listTrackedProcesses() {
  if (process.platform === "win32") return [];

  try {
    const { stdout } = await execFileAsync(
      "ps",
      ["-ax", "-o", "pid=,pgid=,ppid=,etime=,command="],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    return stdout
      .split(/\r?\n/)
      .map((line) => parseProcessLine(line))
      .filter((entry) => entry !== null)
      .filter((entry) => isTrackedProcessCommand(entry.command));
  } catch (error) {
    console.warn("[vitest-process-guard] Failed to scan processes:", error);
    return [];
  }
}

function describeProject(project) {
  return project?.config?.name ?? project?.config?.root ?? process.cwd();
}

function formatProcesses(processes) {
  return processes
    .map((entry) => `pid=${entry.pid} pgid=${entry.pgid} ppid=${entry.ppid} etime=${entry.etime} ${entry.command}`)
    .join("\n");
}

function getSettleMs() {
  const raw = process.env.PAPERCLIP_VITEST_PROCESS_GUARD_SETTLE_MS;
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_SETTLE_MS;
}

function isAlive(targetId, signalAsGroup) {
  try {
    process.kill(signalAsGroup ? -targetId : targetId, 0);
    return true;
  } catch {
    return false;
  }
}

async function cleanupTrackedProcesses(processes) {
  const targets = new Map();

  for (const entry of processes) {
    const signalAsGroup = process.platform !== "win32" && entry.pgid > 1 && entry.pgid === entry.pid;
    const id = signalAsGroup ? entry.pgid : entry.pid;
    targets.set(`${signalAsGroup ? "pgid" : "pid"}:${id}`, {
      id,
      signalAsGroup,
      command: entry.command,
    });
  }

  for (const target of targets.values()) {
    try {
      process.kill(target.signalAsGroup ? -target.id : target.id, "SIGTERM");
    } catch {
      // Ignore races with already-dead children.
    }
  }

  await delay(500);

  for (const target of targets.values()) {
    if (!isAlive(target.id, target.signalAsGroup)) continue;
    try {
      process.kill(target.signalAsGroup ? -target.id : target.id, "SIGKILL");
    } catch {
      // Ignore races with already-dead children.
    }
  }
}

async function waitForLeaksToSettle(baselinePids) {
  const deadline = Date.now() + getSettleMs();
  let leaks = findTrackedProcessLeaks(baselinePids, await listTrackedProcesses());

  while (leaks.length > 0 && Date.now() < deadline) {
    await delay(POLL_INTERVAL_MS);
    leaks = findTrackedProcessLeaks(baselinePids, await listTrackedProcesses());
  }

  return leaks;
}

export async function setup(project) {
  if (process.platform === "win32") return;
  if (process.env.PAPERCLIP_VITEST_PROCESS_GUARD === "0") return;

  const projectLabel = describeProject(project);
  const baselinePids = new Set((await listTrackedProcesses()).map((entry) => entry.pid));

  return async () => {
    const leaked = await waitForLeaksToSettle(baselinePids);
    if (leaked.length === 0) return;

    await cleanupTrackedProcesses(leaked);
    const remaining = findTrackedProcessLeaks(baselinePids, await listTrackedProcesses());
    const cleanupNote =
      remaining.length === 0
        ? "Cleanup removed the leaked processes, but the test run still failed so the missing teardown gets fixed."
        : `Cleanup could not stop all leaked processes.\n${formatProcesses(remaining)}`;

    throw new Error(
      `[vitest-process-guard] ${projectLabel} leaked Paperclip-managed processes after tests settled.\n` +
        `${formatProcesses(leaked)}\n\n${cleanupNote}`,
    );
  };
}

export default setup;
