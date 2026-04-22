import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type WorkerMessage = {
  id: number;
  kind: "load" | "buildTranscript" | "invalidate";
  adapterType: string;
  chunks?: Array<{ ts: string; stream: "stdout" | "stderr" | "system"; chunk: string }>;
  opts?: { censorUsernameInLogs?: boolean };
  source?: string;
};

class MockWorker {
  onmessage: ((event: MessageEvent<any>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly messages: WorkerMessage[] = [];

  postMessage(message: WorkerMessage) {
    this.messages.push(message);
    queueMicrotask(() => {
      if (message.kind === "load") {
        this.onmessage?.({
          data: { id: message.id, kind: "load", ok: true },
        } as MessageEvent);
        return;
      }
      if (message.kind === "buildTranscript") {
        this.onmessage?.({
          data: {
            id: message.id,
            kind: "buildTranscript",
            ok: true,
            entries: [{ kind: "stdout", ts: message.chunks?.[0]?.ts ?? "", text: `worker:${message.adapterType}` }],
          },
        } as MessageEvent);
        return;
      }
      this.onmessage?.({
        data: { id: message.id, kind: "invalidate", ok: true },
      } as MessageEvent);
    });
  }

  terminate() {
    // no-op for tests
  }
}

describe("dynamic parser loader", () => {
  const workers: MockWorker[] = [];
  const fetchMock = vi.fn(async () => ({
    ok: true,
    text: async () => "export function parseStdoutLine(line, ts) { return [{ kind: 'stdout', ts, text: line }]; }",
  }));

  beforeEach(() => {
    workers.length = 0;
    vi.resetModules();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("Worker", class {
      constructor() {
        const worker = new MockWorker();
        workers.push(worker);
        return worker;
      }
    });
  });

  afterEach(() => {
    fetchMock.mockClear();
    vi.unstubAllGlobals();
  });

  it("loads dynamic parsers through the worker and caches the result", async () => {
    const { loadDynamicParser } = await import("./dynamic-loader");

    const parser = await loadDynamicParser("external_worker");
    expect(parser).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(workers).toHaveLength(1);
    expect(parser?.parseStdoutLine("hello", "2026-04-22T12:00:00.000Z")).toEqual([
      { kind: "stdout", ts: "2026-04-22T12:00:00.000Z", text: "hello" },
    ]);

    const transcript = await parser?.buildTranscriptAsync?.([
      { ts: "2026-04-22T12:00:00.000Z", stream: "stdout", chunk: "hello\n" },
    ]);
    expect(transcript).toEqual([
      { kind: "stdout", ts: "2026-04-22T12:00:00.000Z", text: "worker:external_worker" },
    ]);

    const cached = await loadDynamicParser("external_worker");
    expect(cached).toBe(parser);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(workers[0]?.messages.map((message) => message.kind)).toEqual(["load", "buildTranscript"]);
  });

  it("invalidates the cached parser and notifies the worker", async () => {
    const { invalidateDynamicParser, loadDynamicParser } = await import("./dynamic-loader");

    await loadDynamicParser("external_worker");
    expect(invalidateDynamicParser("external_worker")).toBe(true);
    await Promise.resolve();
    await loadDynamicParser("external_worker");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(workers[0]?.messages.some((message) => message.kind === "invalidate")).toBe(true);
  });
});
