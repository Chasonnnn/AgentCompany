import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runChildProcess } from "./server-utils.js";

describe("runChildProcess", () => {
  it("waits for onSpawn before sending stdin to the child", async () => {
    const spawnDelayMs = 150;
    const startedAt = Date.now();
    let onSpawnCompletedAt = 0;

    const result = await runChildProcess(
      randomUUID(),
      process.execPath,
      [
        "-e",
        "let data='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>data+=chunk);process.stdin.on('end',()=>process.stdout.write(data));",
      ],
      {
        cwd: process.cwd(),
        env: {},
        stdin: "hello from stdin",
        timeoutSec: 5,
        graceSec: 1,
        onLog: async () => {},
        onSpawn: async () => {
          await new Promise((resolve) => setTimeout(resolve, spawnDelayMs));
          onSpawnCompletedAt = Date.now();
        },
      },
    );
    const finishedAt = Date.now();

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello from stdin");
    expect(onSpawnCompletedAt).toBeGreaterThanOrEqual(startedAt + spawnDelayMs);
    expect(finishedAt - startedAt).toBeGreaterThanOrEqual(spawnDelayMs);
  });

  it("ignores broken-pipe stdin errors when the child closes fd 0 before delayed prompt handoff", async () => {
    const logErrors: string[] = [];

    const result = await runChildProcess(
      randomUUID(),
      "/bin/sh",
      ["-lc", "exec 0<&-; sleep 0.2"],
      {
        cwd: process.cwd(),
        env: {},
        stdin: "hello from stdin",
        timeoutSec: 5,
        graceSec: 1,
        onLog: async () => {},
        onSpawn: async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
        },
        onLogError: (_err, _runId, message) => {
          logErrors.push(message);
        },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(logErrors).toEqual([]);
  });
});
