import { describe, expect, it, vi } from "vitest";
import {
  buildLocalServerSpawnSpec,
  buildPromptfooEvalSpawnSpec,
  runComponentEvalPreflight,
  waitForHealth,
} from "./local-component-eval-lib.mjs";

describe("local component eval helpers", () => {
  it("builds a loopback-only local server spawn spec", () => {
    const spec = buildLocalServerSpawnSpec({
      port: 4123,
      paperclipHome: "/tmp/paperclip-component-evals",
      instanceId: "component_evals_test",
    });

    expect(spec.command).toBe("pnpm");
    expect(spec.args).toEqual(["--filter", "@paperclipai/server", "exec", "tsx", "src/index.ts"]);
    expect(spec.env.PORT).toBe("4123");
    expect(spec.env.PAPERCLIP_BIND).toBe("loopback");
    expect(spec.env.SERVE_UI).toBe("false");
  });

  it("builds a promptfoo eval spawn spec with the local component base url", () => {
    const spec = buildPromptfooEvalSpawnSpec("http://127.0.0.1:4123/");

    expect(spec.command).toBe("pnpm");
    expect(spec.args).toEqual(["dlx", "promptfoo@0.103.3", "eval", "-c", "promptfooconfig.yaml"]);
    expect(spec.env.PAPERCLIP_COMPONENT_EVAL_BASE_URL).toBe("http://127.0.0.1:4123");
  });

  it("waits for health and resolves once the endpoint becomes healthy", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("nope", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "ok" }), { status: 200 }));

    await waitForHealth("http://127.0.0.1:4123", {
      fetchImpl: fetchMock as typeof fetch,
      timeoutMs: 1_000,
      intervalMs: 1,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails preflight when a local adapter cannot complete a trivial run", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({
        executionStatus: "blocked",
        adapterType: "codex_local",
        errorMessage: "Codex CLI is installed, but authentication is not ready.",
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      });
    });

    await expect(runComponentEvalPreflight("http://127.0.0.1:4123", {
      adapters: ["codex_local"],
      fetchImpl: fetchMock as typeof fetch,
      timeoutMs: 1_000,
    })).rejects.toThrow("authentication is not ready");
  });
});
