import { describe, expect, it, vi } from "vitest";
import { createHostClientHandlers } from "./host-client-factory.js";
import { PLUGIN_RPC_ERROR_CODES } from "./protocol.js";

function createServices() {
  const requestBoardApproval = vi.fn(async () => ({ id: "approval-1" }));
  return {
    config: { get: async () => ({}) },
    state: {
      get: async () => null,
      set: async () => undefined,
      delete: async () => undefined,
    },
    entities: {
      upsert: async () => ({ id: "entity-1" }),
      list: async () => [],
    },
    events: {
      emit: async () => undefined,
      subscribe: async () => undefined,
    },
    http: {
      fetch: async () => ({ status: 200, headers: {}, body: "" }),
    },
    secrets: {
      resolve: async () => "secret",
    },
    activity: {
      log: async () => undefined,
    },
    metrics: {
      write: async () => undefined,
    },
    telemetry: {
      track: async () => undefined,
    },
    logger: {
      log: async () => undefined,
    },
    companies: {
      list: async () => [],
      get: async () => null,
    },
    projects: {
      list: async () => [],
      get: async () => null,
      listWorkspaces: async () => [],
      getPrimaryWorkspace: async () => null,
      getWorkspaceForIssue: async () => null,
    },
    issues: {
      list: async () => [],
      get: async () => null,
      create: async () => ({ id: "issue-1" }),
      update: async () => ({ id: "issue-1" }),
      listComments: async () => [],
      createComment: async () => ({ id: "comment-1" }),
      requestBoardApproval,
    },
    issueDocuments: {
      list: async () => [],
      get: async () => null,
      upsert: async () => ({ id: "doc-1" }),
      delete: async () => undefined,
    },
    agents: {
      list: async () => [],
      get: async () => null,
      pause: async () => ({ id: "agent-1" }),
      resume: async () => ({ id: "agent-1" }),
      invoke: async () => ({ runId: "run-1" }),
    },
    agentSessions: {
      create: async () => ({
        sessionId: "session-1",
        agentId: "agent-1",
        companyId: "company-1",
        status: "active",
        createdAt: new Date().toISOString(),
      }),
      list: async () => [],
      sendMessage: async () => ({ runId: "run-1" }),
      close: async () => undefined,
    },
    goals: {
      list: async () => [],
      get: async () => null,
      create: async () => ({ id: "goal-1" }),
      update: async () => ({ id: "goal-1" }),
    },
  } as any;
}

describe("createHostClientHandlers", () => {
  it("gates issues.requestBoardApproval behind issue.approvals.create", async () => {
    const handlers = createHostClientHandlers({
      pluginId: "acme.test",
      capabilities: [],
      services: createServices(),
    });

    await expect(
      handlers["issues.requestBoardApproval"]({
        issueId: "issue-1",
        companyId: "company-1",
        requestedByAgentId: "agent-1",
        payload: {
          title: "Approve spend",
          summary: "Need board signoff",
          decisionTier: "board",
          roomKind: "issue_board_room",
        },
      }),
    ).rejects.toMatchObject({
      code: PLUGIN_RPC_ERROR_CODES.CAPABILITY_DENIED,
    });
  });

  it("delegates issues.requestBoardApproval to the host services adapter", async () => {
    const services = createServices();
    const handlers = createHostClientHandlers({
      pluginId: "acme.test",
      capabilities: ["issue.approvals.create"],
      services,
    });

    await handlers["issues.requestBoardApproval"]({
      issueId: "issue-1",
      companyId: "company-1",
      requestedByAgentId: "agent-1",
      payload: {
        title: "Approve spend",
        summary: "Need board signoff",
        decisionTier: "board",
        roomKind: "issue_board_room",
      },
    });

    expect(services.issues.requestBoardApproval).toHaveBeenCalledWith({
      issueId: "issue-1",
      companyId: "company-1",
      requestedByAgentId: "agent-1",
      payload: {
        title: "Approve spend",
        summary: "Need board signoff",
        decisionTier: "board",
        roomKind: "issue_board_room",
      },
    });
  });
});
