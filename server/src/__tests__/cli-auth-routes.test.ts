import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function createApp(actor: any) {
  vi.doUnmock("../routes/access.js");
  vi.doUnmock("../middleware/index.js");
  vi.doUnmock("../services/index.js");
  vi.doUnmock("../board-claim.js");
  vi.doUnmock("../home-paths.js");
  vi.doUnmock("../config-file.js");
  vi.doUnmock("node:fs");

  const state = {
    createChallengeResult: {
      challenge: {
        id: "challenge-1",
        expiresAt: new Date("2026-03-23T13:00:00.000Z"),
      },
      challengeSecret: "pcp_cli_auth_secret",
      pendingBoardToken: "pcp_board_token",
    },
    describeChallengeResult: {
      id: "challenge-1",
      status: "pending",
      command: "paperclipai company import",
      clientName: "paperclipai cli",
      requestedAccess: "board",
      requestedCompanyId: null,
      requestedCompanyName: null,
      approvedAt: null,
      cancelledAt: null,
      expiresAt: "2026-03-23T13:00:00.000Z",
      approvedByUser: null,
    },
    approveChallengeResult: {
      status: "approved",
      challenge: {
        id: "challenge-1",
        boardApiKeyId: "board-key-1",
        requestedAccess: "board",
        requestedCompanyId: "company-1",
        expiresAt: new Date("2026-03-23T13:00:00.000Z"),
      },
    },
    resolvedBoardAccess: {
      user: { id: "user-1", name: "User One", email: "user@example.com" },
      companyIds: ["company-1"],
      isInstanceAdmin: false,
    },
    resolvedActivityCompanyIds: ["company-1"],
    currentBoardKey: {
      id: "board-key-3",
      userId: "admin-2",
    },
  };

  const calls = {
    isInstanceAdmin: [] as unknown[][],
    createCliAuthChallenge: [] as unknown[][],
    describeCliAuthChallenge: [] as unknown[][],
    approveCliAuthChallenge: [] as unknown[][],
    cancelCliAuthChallenge: [] as unknown[][],
    resolveBoardAccess: [] as unknown[][],
    resolveBoardActivityCompanyIds: [] as unknown[][],
    assertCurrentBoardKey: [] as unknown[][],
    revokeBoardApiKey: [] as unknown[][],
    logActivity: [] as unknown[][],
  };

  const [{ accessRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/access.js")>("../routes/access.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use(
    "/api",
    accessRoutes({} as any, {
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
      services: {
        accessService: {
          isInstanceAdmin: async (...args: unknown[]) => {
            calls.isInstanceAdmin.push(args);
            return false;
          },
          hasPermission: async () => false,
          canUser: async () => false,
        } as any,
        agentService: {
          getById: async () => null,
        } as any,
        boardAuthService: {
          createCliAuthChallenge: async (...args: unknown[]) => {
            calls.createCliAuthChallenge.push(args);
            return state.createChallengeResult;
          },
          describeCliAuthChallenge: async (...args: unknown[]) => {
            calls.describeCliAuthChallenge.push(args);
            return state.describeChallengeResult;
          },
          approveCliAuthChallenge: async (...args: unknown[]) => {
            calls.approveCliAuthChallenge.push(args);
            return state.approveChallengeResult;
          },
          cancelCliAuthChallenge: async (...args: unknown[]) => {
            calls.cancelCliAuthChallenge.push(args);
            return { status: "cancelled" };
          },
          resolveBoardAccess: async (...args: unknown[]) => {
            calls.resolveBoardAccess.push(args);
            return state.resolvedBoardAccess;
          },
          resolveBoardActivityCompanyIds: async (...args: unknown[]) => {
            calls.resolveBoardActivityCompanyIds.push(args);
            return state.resolvedActivityCompanyIds;
          },
          assertCurrentBoardKey: async (...args: unknown[]) => {
            calls.assertCurrentBoardKey.push(args);
            return state.currentBoardKey;
          },
          revokeBoardApiKey: async (...args: unknown[]) => {
            calls.revokeBoardApiKey.push(args);
          },
        } as any,
        logActivity: async (...args: unknown[]) => {
          calls.logActivity.push(args);
        },
      },
    }),
  );
  app.use(errorHandler);

  return { app, state, calls };
}

describe("cli auth routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/access.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../board-claim.js");
    vi.doUnmock("../home-paths.js");
    vi.doUnmock("../config-file.js");
    vi.doUnmock("node:fs");
  });

  afterEach(() => {
    vi.doUnmock("../routes/access.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../board-claim.js");
    vi.doUnmock("../home-paths.js");
    vi.doUnmock("../config-file.js");
    vi.doUnmock("node:fs");
  });

  it("creates a CLI auth challenge with approval metadata", async () => {
    const { app, calls } = await createApp({ type: "none", source: "none" });
    const res = await request(app)
      .post("/api/cli-auth/challenges")
      .send({
        command: "paperclipai company import",
        clientName: "paperclipai cli",
        requestedAccess: "board",
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: "challenge-1",
      token: "pcp_cli_auth_secret",
      boardApiToken: "pcp_board_token",
      approvalPath: "/cli-auth/challenge-1?token=pcp_cli_auth_secret",
      pollPath: "/cli-auth/challenges/challenge-1",
      expiresAt: "2026-03-23T13:00:00.000Z",
    });
    expect(res.body.approvalUrl).toContain("/cli-auth/challenge-1?token=pcp_cli_auth_secret");
    expect(calls.createCliAuthChallenge).toHaveLength(1);
  });

  it("marks challenge status as requiring sign-in for anonymous viewers", async () => {
    const { app } = await createApp({ type: "none", source: "none" });
    const res = await request(app).get("/api/cli-auth/challenges/challenge-1?token=pcp_cli_auth_secret");

    expect(res.status).toBe(200);
    expect(res.body.requiresSignIn).toBe(true);
    expect(res.body.canApprove).toBe(false);
  });

  it("approves a CLI auth challenge for a signed-in board user", async () => {
    const { app, state, calls } = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });
    state.approveChallengeResult = {
      status: "approved",
      challenge: {
        id: "challenge-1",
        boardApiKeyId: "board-key-1",
        requestedAccess: "board",
        requestedCompanyId: "company-1",
        expiresAt: new Date("2026-03-23T13:00:00.000Z"),
      },
    };
    state.resolvedActivityCompanyIds = ["company-1"];

    const res = await request(app)
      .post("/api/cli-auth/challenges/challenge-1/approve")
      .send({ token: "pcp_cli_auth_secret" });

    expect(res.status).toBe(200);
    expect(calls.approveCliAuthChallenge).toEqual([["challenge-1", "pcp_cli_auth_secret", "user-1"]]);
    expect(calls.logActivity).toHaveLength(1);
    expect(calls.logActivity[0]?.[1]).toEqual(expect.objectContaining({
      companyId: "company-1",
      action: "board_api_key.created",
    }));
  });

  it("logs approve activity for instance admins without company memberships", async () => {
    const { app, state, calls } = await createApp({
      type: "board",
      userId: "admin-1",
      source: "session",
      isInstanceAdmin: true,
      companyIds: [],
    });
    state.approveChallengeResult = {
      status: "approved",
      challenge: {
        id: "challenge-2",
        boardApiKeyId: "board-key-2",
        requestedAccess: "instance_admin_required",
        requestedCompanyId: null,
        expiresAt: new Date("2026-03-23T13:00:00.000Z"),
      },
    };
    state.resolvedActivityCompanyIds = ["company-a", "company-b"];

    const res = await request(app)
      .post("/api/cli-auth/challenges/challenge-2/approve")
      .send({ token: "pcp_cli_auth_secret" });

    expect(res.status).toBe(200);
    expect(calls.resolveBoardActivityCompanyIds).toEqual([[
      {
        userId: "admin-1",
        requestedCompanyId: null,
        boardApiKeyId: "board-key-2",
      },
    ]]);
    expect(calls.logActivity).toHaveLength(2);
  });

  it("logs revoke activity with resolved audit company ids", async () => {
    const { app, state, calls } = await createApp({
      type: "board",
      userId: "admin-2",
      keyId: "board-key-3",
      source: "board_key",
      isInstanceAdmin: true,
      companyIds: [],
    });
    state.currentBoardKey = {
      id: "board-key-3",
      userId: "admin-2",
    };
    state.resolvedActivityCompanyIds = ["company-z"];

    const res = await request(app).post("/api/cli-auth/revoke-current").send({});

    expect(res.status).toBe(200);
    expect(calls.resolveBoardActivityCompanyIds).toEqual([[
      {
        userId: "admin-2",
        boardApiKeyId: "board-key-3",
      },
    ]]);
    expect(calls.logActivity[0]?.[1]).toEqual(expect.objectContaining({
      companyId: "company-z",
      action: "board_api_key.revoked",
    }));
  });
});
