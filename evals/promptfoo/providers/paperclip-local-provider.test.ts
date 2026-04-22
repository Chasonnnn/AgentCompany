import { afterEach, describe, expect, it, vi } from "vitest";

const originalFetch = globalThis.fetch;

afterEach(() => {
  if (originalFetch) {
    vi.stubGlobal("fetch", originalFetch);
  } else {
    vi.unstubAllGlobals();
  }
});

describe("paperclip local promptfoo provider", () => {
  it("posts structured component eval requests and returns stable JSON text", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Response(JSON.stringify({
        executionStatus: "succeeded",
        adapterType: "codex_local",
        modelId: "codex-test",
        finalText: "hello",
        durationMs: 25,
        stderrExcerpt: null,
        traceSummary: {
          eventKinds: ["assistant"],
          toolNames: [],
          sessionId: "session-1",
          warnings: [],
        },
        rawTranscript: [{ type: "assistant", text: "hello" }],
        errorMessage: null,
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock as typeof fetch);

    const { default: PaperclipLocalProvider } = await import("./paperclip-local-provider.mjs");
    const provider = new PaperclipLocalProvider({
      label: "codex_local",
      config: {
        adapterType: "codex_local",
        baseUrl: "http://127.0.0.1:4123",
        timeoutMs: 60_000,
      },
    });

    const result = await provider.callApi("Respond with hello.", {
      vars: {
        caseId: "core.assignment_pickup",
        agentId: "agent-1",
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:4123/api/instance/evals/component-run");
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      caseId: "core.assignment_pickup",
      adapterType: "codex_local",
      prompt: "Respond with hello.",
      vars: {
        caseId: "core.assignment_pickup",
        agentId: "agent-1",
      },
    });
    expect(JSON.parse(String(result.output))).toMatchObject({
      executionStatus: "succeeded",
      finalText: "hello",
    });
  });

  it("surfaces non-2xx endpoint failures as provider errors", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ error: "Unsupported component eval adapter type" }), {
        status: 422,
        headers: {
          "content-type": "application/json",
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock as typeof fetch);

    const { default: PaperclipLocalProvider } = await import("./paperclip-local-provider.mjs");
    const provider = new PaperclipLocalProvider({
      label: "broken",
      config: {
        adapterType: "broken_adapter",
        baseUrl: "http://127.0.0.1:4123",
      },
    });

    const result = await provider.callApi("Respond with hello.", {
      vars: {
        caseId: "broken.case",
      },
    });

    expect(String(result.error)).toContain("Unsupported component eval adapter type");
    expect(JSON.parse(String(result.output)).errorMessage).toContain("Unsupported component eval adapter type");
  });
});
