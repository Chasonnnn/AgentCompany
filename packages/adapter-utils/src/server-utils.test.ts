import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  renderPaperclipWakePrompt,
  runningProcesses,
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

async function waitForTextMatch(read: () => string, pattern: RegExp, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    const match = value.match(pattern);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return read().match(pattern);
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

  it.skipIf(process.platform === "win32")("cleans up a lingering process group after terminal output and child exit", async () => {
    const result = await runChildProcess(
      randomUUID(),
      process.execPath,
      [
        "-e",
        [
          "const { spawn } = require('node:child_process');",
          "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'ignore'] });",
          "process.stdout.write(`descendant:${child.pid}\\n`);",
          "process.stdout.write(`${JSON.stringify({ type: 'result', result: 'done' })}\\n`);",
          "setTimeout(() => process.exit(0), 25);",
        ].join(" "),
      ],
      {
        cwd: process.cwd(),
        env: {},
        timeoutSec: 0,
        graceSec: 1,
        onLog: async () => {},
        terminalResultCleanup: {
          graceMs: 100,
          hasTerminalResult: ({ stdout }) => stdout.includes('"type":"result"'),
        },
      },
    );

    const descendantPid = Number.parseInt(result.stdout.match(/descendant:(\d+)/)?.[1] ?? "", 10);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(Number.isInteger(descendantPid) && descendantPid > 0).toBe(true);
    expect(await waitForPidExit(descendantPid, 2_000)).toBe(true);
  });

  it.skipIf(process.platform === "win32")("cleans up a still-running child after terminal output", async () => {
    const result = await runChildProcess(
      randomUUID(),
      process.execPath,
      [
        "-e",
        [
          "process.stdout.write(`${JSON.stringify({ type: 'result', result: 'done' })}\\n`);",
          "setInterval(() => {}, 1000);",
        ].join(" "),
      ],
      {
        cwd: process.cwd(),
        env: {},
        timeoutSec: 0,
        graceSec: 1,
        onLog: async () => {},
        terminalResultCleanup: {
          graceMs: 100,
          hasTerminalResult: ({ stdout }) => stdout.includes('\"type\":\"result\"'),
        },
      },
    );

    expect(result.timedOut).toBe(false);
    expect(result.signal).toBe("SIGTERM");
    expect(result.stdout).toContain('"type":"result"');
  });

  it.skipIf(process.platform === "win32")("does not clean up noisy runs that have no terminal output", async () => {
    const runId = randomUUID();
    let observed = "";
    const resultPromise = runChildProcess(
      runId,
      process.execPath,
      [
        "-e",
        [
          "const { spawn } = require('node:child_process');",
          "const child = spawn(process.execPath, ['-e', \"setInterval(() => process.stdout.write('noise\\\\n'), 50)\"], { stdio: ['ignore', 'inherit', 'ignore'] });",
          "process.stdout.write(`descendant:${child.pid}\\n`);",
          "setTimeout(() => process.exit(0), 25);",
        ].join(" "),
      ],
      {
        cwd: process.cwd(),
        env: {},
        timeoutSec: 0,
        graceSec: 1,
        onLog: async (_stream, chunk) => {
          observed += chunk;
        },
        terminalResultCleanup: {
          graceMs: 50,
          hasTerminalResult: ({ stdout }) => stdout.includes('"type":"result"'),
        },
      },
    );

    const pidMatch = await waitForTextMatch(() => observed, /descendant:(\d+)/);
    const descendantPid = Number.parseInt(pidMatch?.[1] ?? "", 10);
    expect(Number.isInteger(descendantPid) && descendantPid > 0).toBe(true);

    const race = await Promise.race([
      resultPromise.then(() => "settled" as const),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 300)),
    ]);
    expect(race).toBe("pending");
    expect(isPidAlive(descendantPid)).toBe(true);

    const running = runningProcesses.get(runId) as
      | { child: { kill(signal: NodeJS.Signals): boolean }; processGroupId: number | null }
      | undefined;
    try {
      if (running?.processGroupId) {
        process.kill(-running.processGroupId, "SIGKILL");
      } else {
        running?.child.kill("SIGKILL");
      }
      await resultPromise;
    } finally {
      runningProcesses.delete(runId);
      if (isPidAlive(descendantPid)) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          // Ignore cleanup races.
        }
      }
    }
  });
});

describe("renderPaperclipWakePrompt", () => {
  it("keeps the default local-agent prompt action-oriented", () => {
    expect(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE).toContain("Start actionable work in this heartbeat");
    expect(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE).toContain("do not stop at a plan");
    expect(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE).toContain("Prefer the smallest verification that proves the change");
    expect(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE).toContain("Use child issues");
    expect(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE).toContain("instead of polling agents, sessions, or processes");
    expect(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE).toContain("Create child issues directly when you know what needs to be done");
    expect(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE).toContain("POST /api/issues/{issueId}/interactions");
    expect(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE).toContain("kind suggest_tasks, ask_user_questions, or request_confirmation");
    expect(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE).toContain("confirmation:{issueId}:plan:{revisionId}");
    expect(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE).toContain("Wait for acceptance before creating implementation subtasks");
    expect(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE).toContain(
      "Respect budget, pause/cancel, approval gates, and company boundaries",
    );
  });

  it("adds the execution contract to scoped wake prompts", () => {
    const prompt = renderPaperclipWakePrompt({
      reason: "issue_assigned",
      issue: {
        id: "issue-1",
        identifier: "PAP-1580",
        title: "Update prompts",
        status: "in_progress",
      },
    });

    expect(prompt).toContain("Execution contract:");
    expect(prompt).toContain("Start actionable work in this heartbeat");
    expect(prompt).toContain("Use child issues for parallel or long delegated work");
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

describe("renderPaperclipWakePrompt office coordination payloads", () => {
  it("renders company-scoped coordination guidance for the office operator", () => {
    const prompt = renderPaperclipWakePrompt({
      reason: "office_coordination_requested",
      officeCoordination: {
        companyId: "company-1",
        officeAgentId: "office-1",
        trigger: {
          reason: "issue_intake_created",
          entityType: "issue",
          entityId: "issue-1",
          summary: "PAP-1 Architecture audit",
        },
        queueCounts: {
          untriagedIntake: 1,
          unassignedIssues: 1,
          blockedIssues: 1,
          staleIssues: 0,
          staffingGaps: 1,
          engagementsNeedingAttention: 1,
          sharedSkillItems: 1,
        },
        untriagedIntake: [
          {
            id: "issue-1",
            identifier: "PAP-1",
            title: "Architecture audit",
            status: "todo",
            priority: "medium",
            projectId: "project-1",
            projectName: "Platform",
            updatedAt: "2026-04-21T12:00:00.000Z",
          },
        ],
        unassignedIssues: [],
        blockedIssues: [],
        staleIssues: [],
        staffingGaps: [
          {
            projectId: "project-1",
            projectName: "Platform",
            missingRoles: ["project_lead"],
            openIssueCount: 3,
          },
        ],
        engagementsNeedingAttention: [
          {
            id: "engagement-1",
            title: "Security audit",
            serviceAreaKey: "security",
            status: "requested",
            targetProjectId: "project-1",
            targetProjectName: "Platform",
            updatedAt: "2026-04-21T12:00:00.000Z",
          },
        ],
        sharedSkillItems: [
          {
            sharedSkillId: "shared-skill-1",
            key: "global/codex/find-skills",
            name: "Find Skills",
            mirrorState: "paperclip_modified",
            sourceDriftState: "diverged_needs_review",
            openProposalId: "proposal-1",
            openProposalStatus: "pending",
            openProposalSummary: "Merge upstream changes",
          },
        ],
        recentActions: [
          {
            action: "issue.assigned",
            entityType: "issue",
            entityId: "issue-2",
            summary: "PAP-2",
            createdAt: "2026-04-21T12:00:00.000Z",
          },
        ],
      },
    });

    expect(prompt).toContain("company-wide office/logistics operator");
    expect(prompt).toContain("Company coordination queue counts");
    expect(prompt).toContain("Untriaged Intake");
    expect(prompt).toContain("Project staffing gaps");
    expect(prompt).toContain("Shared skill coordination items");
    expect(prompt).toContain("Do not become the continuity owner by default");
  });
});
