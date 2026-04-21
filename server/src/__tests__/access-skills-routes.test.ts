import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockAccessService = vi.hoisted(() => ({
  isInstanceAdmin: vi.fn(),
  hasPermission: vi.fn(),
  canUser: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockBoardAuthService = vi.hoisted(() => ({
  createCliAuthChallenge: vi.fn(),
  describeCliAuthChallenge: vi.fn(),
  approveCliAuthChallenge: vi.fn(),
  cancelCliAuthChallenge: vi.fn(),
  resolveBoardAccess: vi.fn(),
  resolveBoardActivityCompanyIds: vi.fn(),
  assertCurrentBoardKey: vi.fn(),
  revokeBoardApiKey: vi.fn(),
}));

function registerServiceMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    boardAuthService: () => mockBoardAuthService,
    logActivity: vi.fn(),
    notifyHireApproved: vi.fn(),
    deduplicateAgentName: vi.fn((name: string) => name),
  }));
}

function createApp(actor: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  return vi.importActual<typeof import("../routes/access.js")>("../routes/access.js").then(({ accessRoutes }) =>
    Promise.resolve().then(() => {
      app.use(
        "/api",
        accessRoutes({} as any, {
          deploymentMode: "authenticated",
          deploymentExposure: "private",
          bindHost: "127.0.0.1",
          allowedHostnames: [],
        }),
      );
      app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(err?.status ?? 500).json({ error: err?.message ?? "Internal server error" });
      });
      return app;
    }),
  );
}

describe("access skill routes", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    vi.resetAllMocks();
    vi.doUnmock("../routes/access.js");
    vi.doUnmock("../home-paths.js");
    vi.doUnmock("../config-file.js");
    vi.doUnmock("node:fs");
    registerServiceMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.doUnmock("../routes/access.js");
    vi.doUnmock("../home-paths.js");
    vi.doUnmock("../config-file.js");
    vi.doUnmock("node:fs");
  });

  it("lists every bundled Paperclip skill in the public skill index", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: true,
      companyIds: [],
    });

    const res = await request(app).get("/api/skills/index");

    expect(res.status).toBe(200);
    expect(res.body.skills).toEqual(expect.arrayContaining([
      { name: "paperclip", path: "/api/skills/paperclip" },
      { name: "paperclip-create-agent", path: "/api/skills/paperclip-create-agent" },
      { name: "paperclip-create-plugin", path: "/api/skills/paperclip-create-plugin" },
      { name: "para-memory-files", path: "/api/skills/para-memory-files" },
    ]));
  });

  it("serves markdown for bundled skills that were previously omitted from the index", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: true,
      companyIds: [],
    });

    const res = await request(app).get("/api/skills/paperclip-create-plugin");

    expect(res.status).toBe(200);
    expect(res.text).toContain("name: paperclip-create-plugin");
    expect(res.text).toContain("# Create a Paperclip Plugin");
  });
});
