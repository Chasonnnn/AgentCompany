import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { rateLimitMiddleware } from "../middleware/rate-limit.js";

function createApp(maxRequests: number, windowMs: number) {
  const app = express();
  app.use(rateLimitMiddleware({ maxRequests, windowMs }));
  app.get("/test", (_req, res) => {
    res.status(200).json({ ok: true });
  });
  return app;
}

describe("rateLimitMiddleware", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows requests within the limit", async () => {
    const app = createApp(3, 60_000);
    for (let i = 0; i < 3; i++) {
      const res = await request(app).get("/test");
      expect(res.status).toBe(200);
    }
  });

  it("rejects requests that exceed the limit with 429", async () => {
    const app = createApp(2, 60_000);
    await request(app).get("/test");
    await request(app).get("/test");
    const res = await request(app).get("/test");
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ error: expect.any(String) });
  });

  it("includes rate-limit headers on every response", async () => {
    const app = createApp(5, 60_000);
    const res = await request(app).get("/test");
    expect(res.status).toBe(200);
    expect(res.headers["x-ratelimit-limit"]).toBe("5");
    expect(res.headers["x-ratelimit-remaining"]).toBeDefined();
    expect(res.headers["x-ratelimit-reset"]).toBeDefined();
  });

  it("includes Retry-After header on 429 responses", async () => {
    const app = createApp(1, 60_000);
    await request(app).get("/test");
    const res = await request(app).get("/test");
    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
  });

  it("resets the window after windowMs elapses", async () => {
    const app = createApp(1, 60_000);
    await request(app).get("/test");
    const blocked = await request(app).get("/test");
    expect(blocked.status).toBe(429);

    vi.advanceTimersByTime(61_000);

    const allowed = await request(app).get("/test");
    expect(allowed.status).toBe(200);
  });

  it("tracks different IPs independently", async () => {
    const app = createApp(1, 60_000);
    // First IP exhausts limit
    await request(app).get("/test").set("X-Forwarded-For", "10.0.0.1");
    const ip1Blocked = await request(app).get("/test").set("X-Forwarded-For", "10.0.0.1");
    expect(ip1Blocked.status).toBe(429);
    // Second IP still has budget
    const ip2Allowed = await request(app).get("/test").set("X-Forwarded-For", "10.0.0.2");
    expect(ip2Allowed.status).toBe(200);
  });
});
