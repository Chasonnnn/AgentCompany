import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const cp = await importOriginal<typeof import("node:child_process")>();
  return {
    ...cp,
    spawn: (...args: Parameters<typeof cp.spawn>) => mockSpawn(...args) as ReturnType<typeof cp.spawn>,
  };
});

import { CodexAppServerClient } from "./app-server-client.js";

type MockChild = ChildProcess & {
  stdout: EventEmitter & { setEncoding: (encoding: string) => void };
  stderr: EventEmitter & { setEncoding: (encoding: string) => void };
  stdin: { write: ReturnType<typeof vi.fn> };
  kill: ReturnType<typeof vi.fn>;
};

function createMockChild(writes: string[]): MockChild {
  const stdout = Object.assign(new EventEmitter(), {
    setEncoding: () => {},
  });
  const stderr = Object.assign(new EventEmitter(), {
    setEncoding: () => {},
  });
  const child = new EventEmitter() as MockChild;
  Object.assign(child, {
    pid: 12345,
    stdout,
    stderr,
    stdin: {
      write: vi.fn((chunk: string) => {
        writes.push(String(chunk));
        return true;
      }),
    },
    kill: vi.fn(() => {
      queueMicrotask(() => {
        child.emit("exit", 0, null);
        child.emit("close", 0, null);
      });
      return true;
    }),
  });
  return child;
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("CodexAppServerClient", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes notifications, replies to server requests, and shuts down cleanly", async () => {
    const writes: string[] = [];
    const child = createMockChild(writes);
    mockSpawn.mockReturnValue(child);

    const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
    const client = new CodexAppServerClient({
      onNotification: async (method, params) => {
        notifications.push({ method, params });
      },
      onRequest: async () => ({
        answers: {
          scope: {
            answers: ["Runtime"],
          },
        },
      }),
    });

    const initializePromise = client.initialize();
    expect(JSON.parse(writes.shift() ?? "{}")).toMatchObject({
      method: "initialize",
    });
    child.stdout.emit("data", JSON.stringify({ id: 1, result: {} }) + "\n");
    await initializePromise;
    expect(JSON.parse(writes.shift() ?? "{}")).toEqual({
      method: "initialized",
      params: {},
    });

    child.stdout.emit("data", JSON.stringify({ method: "thread/started", params: { thread: { id: "thread-1" } } }) + "\n");
    child.stdout.emit(
      "data",
      JSON.stringify({
        id: "req-1",
        method: "item/tool/requestUserInput",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-1",
          questions: [],
        },
      }) + "\n",
    );
    await flush();

    expect(notifications).toEqual([
      {
        method: "thread/started",
        params: {
          thread: {
            id: "thread-1",
          },
        },
      },
    ]);
    expect(JSON.parse(writes.pop() ?? "{}")).toEqual({
      id: "req-1",
      result: {
        answers: {
          scope: {
            answers: ["Runtime"],
          },
        },
      },
    });

    await client.shutdown({ graceMs: 0 });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("surfaces request timeouts", async () => {
    const writes: string[] = [];
    const child = createMockChild(writes);
    mockSpawn.mockReturnValue(child);

    const client = new CodexAppServerClient();
    const requestPromise = client.request("thread/start", {}, 5);
    expect(JSON.parse(writes.shift() ?? "{}")).toMatchObject({
      method: "thread/start",
    });
    await expect(requestPromise).rejects.toThrow("codex app-server timed out on thread/start");
    await client.shutdown({ graceMs: 0 });
  });
});
