import { beforeEach, describe, expect, it, vi } from "vitest";

const unknownHostname = "blocked-host.invalid";

async function runGuard(input: {
  enabled: boolean;
  allowedHostnames?: string[];
  bindHost?: string;
  path: string;
  host?: string;
}) {
  vi.doUnmock("../middleware/private-hostname-guard.js");
  const { privateHostnameGuard } = await import("../middleware/private-hostname-guard.js");

  const req = {
    path: input.path,
    header(name: string) {
      if (name.toLowerCase() === "host") return input.host ?? null;
      return null;
    },
    accepts() {
      return input.path.startsWith("/api") ? "json" : "html";
    },
  };

  let statusCode: number | null = null;
  let jsonBody: unknown = null;
  let textBody = "";
  let contentType: string | null = null;
  let nextCalled = false;

  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(payload: unknown) {
      jsonBody = payload;
      return res;
    },
    type(value: string) {
      contentType = value;
      return res;
    },
    send(payload: string) {
      textBody = payload;
      return res;
    },
  };

  const next = () => {
    nextCalled = true;
  };

  privateHostnameGuard({
    enabled: input.enabled,
    allowedHostnames: input.allowedHostnames ?? [],
    bindHost: input.bindHost ?? "0.0.0.0",
  })(req as any, res as any, next as any);

  return { statusCode, jsonBody, textBody, contentType, nextCalled };
}

describe("privateHostnameGuard", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("allows requests when disabled", async () => {
    const result = await runGuard({
      enabled: false,
      path: "/api/health",
      host: "dotta-macbook-pro:3100",
    });
    expect(result.nextCalled).toBe(true);
    expect(result.statusCode).toBeNull();
  });

  it("allows loopback hostnames", async () => {
    const result = await runGuard({
      enabled: true,
      path: "/api/health",
      host: "localhost:3100",
    });
    expect(result.nextCalled).toBe(true);
    expect(result.statusCode).toBeNull();
  });

  it("allows explicitly configured hostnames", async () => {
    const result = await runGuard({
      enabled: true,
      allowedHostnames: ["dotta-macbook-pro"],
      path: "/api/health",
      host: "dotta-macbook-pro:3100",
    });
    expect(result.nextCalled).toBe(true);
    expect(result.statusCode).toBeNull();
  });

  it("blocks unknown hostnames with remediation command", async () => {
    const result = await runGuard({
      enabled: true,
      allowedHostnames: ["some-other-host"],
      path: "/api/health",
      host: `${unknownHostname}:3100`,
    });
    expect(result.nextCalled).toBe(false);
    expect(result.statusCode).toBe(403);
    expect(result.jsonBody).toEqual({
      error: `Hostname '${unknownHostname}' is not allowed for this Paperclip instance. If you want to allow this hostname, please run pnpm paperclipai allowed-hostname ${unknownHostname}`,
    });
  });

  it("blocks unknown hostnames on page routes with plain-text remediation command", async () => {
    const result = await runGuard({
      enabled: true,
      allowedHostnames: ["some-other-host"],
      path: "/dashboard",
      host: `${unknownHostname}:3100`,
    });
    expect(result.nextCalled).toBe(false);
    expect(result.statusCode).toBe(403);
    expect(result.contentType).toBe("text/plain");
    expect(result.textBody).toContain(
      `please run pnpm paperclipai allowed-hostname ${unknownHostname}`,
    );
  });
});
