import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  renderPaperclipWakePrompt,
  runChildProcess,
  stringifyPaperclipWakePayload,
} from "./server-utils.js";

function isPidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid: number, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isPidAlive(pid);
}

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

  it.skipIf(process.platform === "win32")("kills descendant processes on timeout via the process group", async () => {
    let descendantPid: number | null = null;

    const result = await runChildProcess(
      randomUUID(),
      process.execPath,
      [
        "-e",
        [
          "const { spawn } = require('node:child_process');",
          "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
          "process.stdout.write(String(child.pid));",
          "setInterval(() => {}, 1000);",
        ].join(" "),
      ],
      {
        cwd: process.cwd(),
        env: {},
        timeoutSec: 1,
        graceSec: 1,
        onLog: async () => {},
        onSpawn: async () => {},
      },
    );

    descendantPid = Number.parseInt(result.stdout.trim(), 10);
    expect(result.timedOut).toBe(true);
    expect(Number.isInteger(descendantPid) && descendantPid > 0).toBe(true);
    expect(await waitForPidExit(descendantPid!, 2_000)).toBe(true);
  });
});

describe("renderPaperclipWakePrompt conference-room payloads", () => {
  it("renders room-specific guidance for conference room questions", () => {
    const payload = {
      reason: "conference_room_question",
      conferenceRoom: {
        id: "room-1",
        title: "Onboarding Meeting",
        kind: "project_leadership",
        status: "open",
        linkedIssues: [
          {
            id: "issue-1",
            identifier: "PAP-1",
            title: "Kickoff onboarding work",
          },
        ],
      },
      conferenceRoomMessage: {
        id: "comment-1",
        parentCommentId: null,
        messageType: "question",
        body: "How do you feel about the audit?",
        createdAt: "2026-04-17T00:48:07.000Z",
        author: {
          type: "user",
          id: "board-user",
        },
      },
      conferenceRoomThread: [
        {
          id: "comment-1",
          parentCommentId: null,
          messageType: "question",
          body: "How do you feel about the audit?",
          createdAt: "2026-04-17T00:48:07.000Z",
          author: {
            type: "user",
            id: "board-user",
          },
        },
      ],
      conferenceRoomPendingResponses: [
        {
          agent: { id: "agent-1", name: "Technical Project Lead" },
          status: "pending",
          repliedCommentId: null,
        },
      ],
    };

    expect(stringifyPaperclipWakePayload(payload)).toContain('"conferenceRoom"');

    const prompt = renderPaperclipWakePrompt(payload);

    expect(prompt).toContain("Paperclip Wake Payload");
    expect(prompt).toContain("conference room: Onboarding Meeting (room-1)");
    expect(prompt).toContain("reply in the conference room thread");
    expect(prompt).toContain("An invited board question is awaiting your in-thread response.");
    expect(prompt).toContain("Room response state:");
    expect(prompt).toContain("Technical Project Lead: pending");
    expect(prompt).not.toContain("issue below. Do not switch");
  });
});
