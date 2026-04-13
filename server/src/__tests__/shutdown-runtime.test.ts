import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { runningProcesses } from "../adapters/index.ts";
import { stopRunningAdapterProcesses } from "../shutdown-runtime.ts";

function spawnAliveProcessGroup() {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
}

function isPidAlive(pid: number | null | undefined) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid: number, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isPidAlive(pid);
}

describe.skipIf(process.platform === "win32")("shutdown runtime cleanup", () => {
  afterEach(async () => {
    await stopRunningAdapterProcesses();
  });

  it("terminates detached adapter child process groups", async () => {
    const child = spawnAliveProcessGroup();
    const pid = child.pid;

    expect(typeof pid).toBe("number");
    expect(pid && pid > 0).toBe(true);

    runningProcesses.set("run-1", {
      child: child as ChildProcess,
      graceSec: 1,
      processGroupId: pid ?? null,
    });

    const result = await stopRunningAdapterProcesses();

    expect(result).toEqual({ attempted: 1, signaled: 1 });
    expect(await waitForPidExit(pid!, 3_000)).toBe(true);
    runningProcesses.clear();
  });
});
