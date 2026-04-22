import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const httpMocks = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({ deploymentMode: "authenticated" })),
  dnsLookup: vi.fn(),
}));

vi.mock("../config.js", () => ({
  loadConfig: httpMocks.loadConfig,
}));

vi.mock("node:dns/promises", () => ({
  lookup: httpMocks.dnsLookup,
}));

function makeExecutionContext(config: Record<string, unknown>) {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Agent One",
      adapterType: "process",
      adapterConfig: config,
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config,
    context: {
      issueId: "issue-1",
    },
    onLog: async () => {},
  };
}

describe("adapter safety guards", () => {
  beforeEach(() => {
    vi.resetModules();
    httpMocks.loadConfig.mockReset();
    httpMocks.loadConfig.mockReturnValue({ deploymentMode: "authenticated" });
    httpMocks.dnsLookup.mockReset();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("http adapter", () => {
    it("rejects non-http protocols before any network call", async () => {
      const { execute } = await import("../adapters/http/execute.js");

      await expect(
        execute(makeExecutionContext({ url: "ftp://example.com/webhook" }) as any),
      ).rejects.toThrow(/only supports http:\/\/ and https:\/\//i);

      expect(httpMocks.dnsLookup).not.toHaveBeenCalled();
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("rejects insecure public http targets", async () => {
      httpMocks.dnsLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
      const { execute } = await import("../adapters/http/execute.js");

      await expect(
        execute(makeExecutionContext({ url: "http://example.com/webhook" }) as any),
      ).rejects.toThrow(/requires https:\/\/ for non-loopback targets/i);

      expect(httpMocks.dnsLookup).toHaveBeenCalledWith("example.com", { all: true, verbatim: true });
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("rejects loopback targets outside local_trusted mode", async () => {
      httpMocks.dnsLookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
      const { execute } = await import("../adapters/http/execute.js");

      await expect(
        execute(makeExecutionContext({ url: "http://localhost:3100/api/health" }) as any),
      ).rejects.toThrow(/blocks local, private, link-local, metadata, multicast, and reserved targets/i);

      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("allows explicit loopback http targets in local_trusted mode", async () => {
      httpMocks.loadConfig.mockReturnValue({ deploymentMode: "local_trusted" });
      httpMocks.dnsLookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
      vi.mocked(globalThis.fetch).mockResolvedValue({
        ok: true,
        status: 200,
      } as Response);
      const { execute } = await import("../adapters/http/execute.js");

      const result = await execute(
        makeExecutionContext({ url: "http://localhost:3100/api/health", method: "post" }) as any,
      );

      expect(result).toMatchObject({
        exitCode: 0,
        timedOut: false,
        summary: "HTTP POST http://localhost:3100/api/health",
      });
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.any(URL),
        expect.objectContaining({
          method: "POST",
          redirect: "error",
        }),
      );
    });

    it("rejects public https hostnames that resolve to private addresses", async () => {
      httpMocks.dnsLookup.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
      const { execute } = await import("../adapters/http/execute.js");

      await expect(
        execute(makeExecutionContext({ url: "https://gateway.example.test/hook" }) as any),
      ).rejects.toThrow(/blocks local, private, link-local, metadata, multicast, and reserved targets/i);

      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("allows public https targets after validation", async () => {
      httpMocks.dnsLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
      vi.mocked(globalThis.fetch).mockResolvedValue({
        ok: true,
        status: 204,
      } as Response);
      const { execute } = await import("../adapters/http/execute.js");

      const result = await execute(
        makeExecutionContext({ url: "https://gateway.example.test/hook", timeoutMs: 5000 }) as any,
      );

      expect(result).toMatchObject({
        exitCode: 0,
        timedOut: false,
        summary: "HTTP POST https://gateway.example.test/hook",
      });
      expect(httpMocks.dnsLookup).toHaveBeenCalledWith("gateway.example.test", {
        all: true,
        verbatim: true,
      });
      expect(globalThis.fetch).toHaveBeenCalledOnce();
    });
  });

  describe("http adapter testEnvironment", () => {
    function makeTestContext(config: Record<string, unknown>) {
      return {
        companyId: "company-1",
        adapterType: "http",
        config,
      } as const;
    }

    it("blocks HEAD probe for loopback URLs outside local_trusted mode", async () => {
      httpMocks.dnsLookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
      const { testEnvironment } = await import("../adapters/http/test.js");

      const result = await testEnvironment(
        makeTestContext({ url: "http://127.0.0.1:3100/aiw6-probe" }) as any,
      );

      expect(result.status).toBe("fail");
      const blocked = result.checks.find((c) => c.code === "http_url_target_blocked");
      expect(blocked).toBeDefined();
      expect(blocked?.level).toBe("error");
      expect(blocked?.message).toMatch(/blocks local, private, link-local, metadata, multicast, and reserved targets/i);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("blocks HEAD probe for metadata IPs even under local_trusted", async () => {
      httpMocks.loadConfig.mockReturnValue({ deploymentMode: "local_trusted" });
      httpMocks.dnsLookup.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
      const { testEnvironment } = await import("../adapters/http/test.js");

      const result = await testEnvironment(
        makeTestContext({ url: "http://169.254.169.254/latest/meta-data/" }) as any,
      );

      expect(result.status).toBe("fail");
      expect(result.checks.some((c) => c.code === "http_url_target_blocked")).toBe(true);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("blocks HEAD probe for RFC1918 private IPs", async () => {
      httpMocks.dnsLookup.mockResolvedValue([{ address: "10.0.0.1", family: 4 }]);
      const { testEnvironment } = await import("../adapters/http/test.js");

      const result = await testEnvironment(
        makeTestContext({ url: "http://10.0.0.1/internal" }) as any,
      );

      expect(result.status).toBe("fail");
      expect(result.checks.some((c) => c.code === "http_url_target_blocked")).toBe(true);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("blocks HEAD probe for public hostnames that resolve to private addresses", async () => {
      httpMocks.dnsLookup.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
      const { testEnvironment } = await import("../adapters/http/test.js");

      const result = await testEnvironment(
        makeTestContext({ url: "https://gateway.example.test/hook" }) as any,
      );

      expect(result.status).toBe("fail");
      expect(result.checks.some((c) => c.code === "http_url_target_blocked")).toBe(true);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("allows HEAD probe for explicit loopback in local_trusted mode", async () => {
      httpMocks.loadConfig.mockReturnValue({ deploymentMode: "local_trusted" });
      httpMocks.dnsLookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
      vi.mocked(globalThis.fetch).mockResolvedValue({ ok: true, status: 200 } as Response);
      const { testEnvironment } = await import("../adapters/http/test.js");

      const result = await testEnvironment(
        makeTestContext({ url: "http://localhost:3100/api/health" }) as any,
      );

      expect(result.status).toBe("pass");
      expect(result.checks.some((c) => c.code === "http_endpoint_probe_ok")).toBe(true);
      expect(globalThis.fetch).toHaveBeenCalledOnce();
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.any(URL),
        expect.objectContaining({ method: "HEAD", redirect: "error" }),
      );
    });

    it("allows HEAD probe for public https targets after validation", async () => {
      httpMocks.dnsLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
      vi.mocked(globalThis.fetch).mockResolvedValue({ ok: true, status: 200 } as Response);
      const { testEnvironment } = await import("../adapters/http/test.js");

      const result = await testEnvironment(
        makeTestContext({ url: "https://example.com/hook" }) as any,
      );

      expect(result.status).toBe("pass");
      expect(result.checks.some((c) => c.code === "http_endpoint_probe_ok")).toBe(true);
      expect(httpMocks.dnsLookup).toHaveBeenCalledWith("example.com", {
        all: true,
        verbatim: true,
      });
      expect(globalThis.fetch).toHaveBeenCalledOnce();
    });

    it("does not probe when url is missing", async () => {
      const { testEnvironment } = await import("../adapters/http/test.js");

      const result = await testEnvironment(makeTestContext({}) as any);

      expect(result.status).toBe("fail");
      expect(result.checks.some((c) => c.code === "http_url_missing")).toBe(true);
      expect(httpMocks.dnsLookup).not.toHaveBeenCalled();
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
  });

  describe("process adapter", () => {
    it("fails closed unless unsafeAllowLocalExecution is explicitly enabled", async () => {
      const { execute } = await import("../adapters/process/execute.js");

      await expect(
        execute(
          makeExecutionContext({
            command: process.execPath,
            args: ["-e", "console.log('blocked')"],
          }) as any,
        ),
      ).rejects.toThrow(/unsafeAllowLocalExecution=true/i);
    });

    it("executes only when unsafeAllowLocalExecution is explicitly enabled", async () => {
      const { execute } = await import("../adapters/process/execute.js");

      const result = await execute(
        makeExecutionContext({
          command: process.execPath,
          args: ["-e", "console.log('process adapter ok')"],
          unsafeAllowLocalExecution: true,
        }) as any,
      );

      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);
      expect(result.resultJson?.stdout).toContain("process adapter ok");
    });
  });
});
