import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

const AUTH_WILDCARD_ROUTE = /^\/api\/auth(?:\/.*)?$/;

/**
 * Regression test for https://github.com/paperclipai/paperclip/issues/2898
 *
 * Express 5 (path-to-regexp v8+) dropped support for the `*paramName`
 * wildcard syntax used in Express 4. Routes declared with the old syntax
 * silently fail to match, causing every `/api/auth/*` request to fall
 * through and return 404.
 *
 * We use an explicit regex route instead of string wildcard syntax so
 * auth matching stays precise under Express 5/path-to-regexp changes.
 * These tests verify that the better-auth handler is invoked for both
 * shallow and deep auth sub-paths without broadening past /api/auth.
 */
describe("Express 5 /api/auth wildcard route", () => {
  function buildApp() {
    const app = express();
    let hits = 0;
    const handler = vi.fn((_req: express.Request, res: express.Response) => {
      hits += 1;
      res.status(200).json({ ok: true });
    });
    app.all(AUTH_WILDCARD_ROUTE, handler);
    return { app, handler, getHits: () => hits };
  }

  it("matches a shallow auth sub-path (sign-in/email)", async () => {
    const { app } = buildApp();
    const res = await request(app).post("/api/auth/sign-in/email");
    expect(res.status).toBe(200);
  });

  it("matches a deep auth sub-path (callback/credentials/sign-in)", async () => {
    const { app } = buildApp();
    const res = await request(app).get(
      "/api/auth/callback/credentials/sign-in"
    );
    expect(res.status).toBe(200);
  });

  it("does not match unrelated paths outside /api/auth", async () => {
    // Confirm the route is not over-broad — requests to other API paths
    // must fall through to 404 and not reach the better-auth handler.
    const { app, handler } = buildApp();
    const res = await request(app).get("/api/other/endpoint");
    expect(res.status).toBe(404);
    expect(handler).not.toHaveBeenCalled();
  });

  it("invokes the handler for every matched sub-path", async () => {
    const { app, getHits } = buildApp();
    const signOut = await request(app).post("/api/auth/sign-out");
    const session = await request(app).get("/api/auth/session");
    expect(signOut.status).toBe(200);
    expect(session.status).toBe(200);
    expect(getHits()).toBe(2);
  });
});
