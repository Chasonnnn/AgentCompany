import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { privateHostnameGuard } from "../middleware/private-hostname-guard.js";

const unknownHostname = "blocked-host.invalid";

function createApp(opts: { enabled: boolean; allowedHostnames?: string[]; bindHost?: string }) {
  const app = express();
  app.use(
    privateHostnameGuard({
      enabled: opts.enabled,
      allowedHostnames: opts.allowedHostnames ?? [],
      bindHost: opts.bindHost ?? "0.0.0.0",
    }),
  );
  app.get("/api/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });
  app.get("/dashboard", (_req, res) => {
    res.status(200).send("ok");
  });
  return app;
}

function createHeaderReader(headers: Record<string, string | undefined>) {
  return (name: string) => headers[name.toLowerCase()];
}

function invokePrivateHostnameGuard(
  opts: { enabled: boolean; allowedHostnames?: string[]; bindHost?: string },
  input: {
    path: string;
    headers?: Record<string, string | undefined>;
    accepts?: () => string | false;
  },
) {
  const middleware = privateHostnameGuard({
    enabled: opts.enabled,
    allowedHostnames: opts.allowedHostnames ?? [],
    bindHost: opts.bindHost ?? "0.0.0.0",
  });
  const req = {
    path: input.path,
    header: createHeaderReader(input.headers ?? {}),
    accepts: input.accepts ?? (() => "html"),
  } as any;
  const res = {} as any;
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.send = vi.fn().mockReturnValue(res);
  res.type = vi.fn().mockReturnValue(res);
  const next = vi.fn();

  middleware(req, res, next);

  return { res, next };
}

describe("privateHostnameGuard", () => {
  it("allows requests when disabled", async () => {
    const app = createApp({ enabled: false });
    const res = await request(app).get("/api/health").set("Host", "dotta-macbook-pro:3100");
    expect(res.status).toBe(200);
  });

  it("allows loopback hostnames", async () => {
    const app = createApp({ enabled: true });
    const res = await request(app).get("/api/health").set("Host", "localhost:3100");
    expect(res.status).toBe(200);
  });

  it("allows explicitly configured hostnames", async () => {
    const app = createApp({ enabled: true, allowedHostnames: ["dotta-macbook-pro"] });
    const res = await request(app).get("/api/health").set("Host", "dotta-macbook-pro:3100");
    expect(res.status).toBe(200);
  });

  it("blocks unknown hostnames with remediation command", async () => {
    const { res, next } = invokePrivateHostnameGuard(
      { enabled: true, allowedHostnames: ["some-other-host"] },
      {
        path: "/api/health",
        headers: { host: `${unknownHostname}:3100` },
        accepts: () => "json",
      },
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: expect.stringContaining(`please run pnpm paperclipai allowed-hostname ${unknownHostname}`),
    });
  });

  it("blocks unknown hostnames on page routes with plain-text remediation command", async () => {
    const { res, next } = invokePrivateHostnameGuard(
      { enabled: true, allowedHostnames: ["some-other-host"] },
      {
        path: "/dashboard",
        headers: { host: `${unknownHostname}:3100` },
        accepts: () => "html",
      },
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.type).toHaveBeenCalledWith("text/plain");
    expect(res.send).toHaveBeenCalledWith(
      expect.stringContaining(`please run pnpm paperclipai allowed-hostname ${unknownHostname}`),
    );
  }, 20_000);
});
