import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { boardMutationGuard } from "../middleware/board-mutation-guard.js";

function createApp(
  actorType: "board" | "agent",
  boardSource: "session" | "local_implicit" | "board_key" = "session",
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actorType === "board"
      ? { type: "board", userId: "board", source: boardSource }
      : { type: "agent", agentId: "agent-1" };
    next();
  });
  app.use(boardMutationGuard());
  app.post("/mutate", (_req, res) => {
    res.status(204).end();
  });
  app.get("/read", (_req, res) => {
    res.status(204).end();
  });
  return app;
}

function createHeaderReader(headers: Record<string, string | undefined>) {
  return (name: string) => headers[name.toLowerCase()];
}

function invokeBoardMutationGuard(input: {
  method?: string;
  actor: Record<string, unknown>;
  headers?: Record<string, string | undefined>;
}) {
  const middleware = boardMutationGuard();
  const req = {
    method: input.method ?? "POST",
    actor: input.actor,
    header: createHeaderReader(input.headers ?? {}),
  } as any;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  } as any;
  const next = vi.fn();

  middleware(req, res, next);

  return { res, next };
}

describe("boardMutationGuard", () => {
  it("allows safe methods for board actor", async () => {
    const app = createApp("board");
    const res = await request(app).get("/read");
    expect([200, 204]).toContain(res.status);
  });

  it("blocks board mutations without trusted origin", () => {
    const { res, next } = invokeBoardMutationGuard({
      actor: { type: "board", userId: "board", source: "session" },
    });

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: "Board mutation requires trusted browser origin",
    });
  });

  it("allows local implicit board mutations without origin", async () => {
    const app = createApp("board", "local_implicit");
    const res = await request(app).post("/mutate").send({ ok: true });
    expect([200, 204]).toContain(res.status);
  });

  it("allows board bearer-key mutations without origin", async () => {
    const app = createApp("board", "board_key");
    const res = await request(app).post("/mutate").send({ ok: true });
    expect([200, 204]).toContain(res.status);
  });

  it("allows board mutations from trusted origin", async () => {
    const app = createApp("board");
    const res = await request(app)
      .post("/mutate")
      .set("Origin", "http://localhost:3100")
      .send({ ok: true });
    expect([200, 204]).toContain(res.status);
  });

  it("allows board mutations from trusted referer origin", async () => {
    const app = createApp("board");
    const res = await request(app)
      .post("/mutate")
      .set("Referer", "http://localhost:3100/issues/abc")
      .send({ ok: true });
    expect([200, 204]).toContain(res.status);
  });

  it("allows board mutations when x-forwarded-host matches origin", async () => {
    const app = createApp("board");
    const res = await request(app)
      .post("/mutate")
      .set("Host", "127.0.0.1")
      .set("X-Forwarded-Host", "10.90.10.20:3443")
      .set("Origin", "https://10.90.10.20:3443")
      .send({ ok: true });
    expect([200, 204]).toContain(res.status);
  });

  it("blocks board mutations when x-forwarded-host does not match origin", async () => {
    const { res, next } = invokeBoardMutationGuard({
      actor: { type: "board", userId: "board", source: "session" },
      headers: {
        host: "127.0.0.1",
        "x-forwarded-host": "10.90.10.20:3443",
        origin: "https://evil.example.com",
      },
    });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("does not block authenticated agent mutations", async () => {
    const { res, next } = invokeBoardMutationGuard({
      actor: { type: "agent", agentId: "agent-1" },
    });

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });
});
