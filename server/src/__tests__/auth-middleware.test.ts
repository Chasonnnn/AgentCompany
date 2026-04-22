import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { actorMiddleware } from "../middleware/auth.ts";

const companyA = "22222222-2222-4222-8222-222222222222";
const companyB = "33333333-3333-4333-8333-333333333333";
const agentA = "44444444-4444-4444-8444-444444444444";
const runA = "55555555-5555-4555-8555-555555555555";

function createSelectQueueDb(rows: Array<Array<Record<string, unknown>>>) {
  let callIndex = 0;
  return {
    select: () => {
      const responseRows = rows[callIndex] ?? [];
      callIndex += 1;
      return {
        from: () => ({
          where: () => Promise.resolve(responseRows),
        }),
      };
    },
  };
}

function createApp(db: unknown) {
  const app = express();
  app.use(actorMiddleware(db as any, {
    deploymentMode: "authenticated",
    resolveSession: async () => ({
      user: {
        id: "user-1",
        name: "Board User",
        email: "board@example.com",
      },
    }) as any,
  }));
  app.get("/ping", (req, res) => {
    res.json(req.actor);
  });
  return app;
}

describe("actorMiddleware run-id validation", () => {
  it("rejects a board-scoped run id outside the actor company scope", async () => {
    const app = createApp(createSelectQueueDb([
      [],
      [{ companyId: companyA, membershipRole: "owner", status: "active" }],
      [{ id: runA, companyId: companyB, agentId: agentA }],
    ]));

    const res = await request(app)
      .get("/ping")
      .set("x-paperclip-run-id", runA);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: "X-Paperclip-Run-Id is outside the actor's company scope",
    });
  });

  it("allows a board-scoped run id inside the actor company scope", async () => {
    const app = createApp(createSelectQueueDb([
      [],
      [{ companyId: companyA, membershipRole: "owner", status: "active" }],
      [{ id: runA, companyId: companyA, agentId: agentA }],
    ]));

    const res = await request(app)
      .get("/ping")
      .set("x-paperclip-run-id", runA);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      type: "board",
      userId: "user-1",
      runId: runA,
      companyIds: [companyA],
    }));
  });
});
