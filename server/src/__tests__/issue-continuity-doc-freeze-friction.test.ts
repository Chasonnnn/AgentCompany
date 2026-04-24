import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildIssueDocumentTemplate } from "@paperclipai/shared";

const issueId = "33333333-3333-4333-8333-333333333333";
const companyId = "44444444-4444-4444-8444-444444444444";
const projectId = "55555555-5555-4555-8555-555555555555";
const portfolioClusterId = "66666666-6666-4666-8666-666666666666";
const executiveAgentId = "77777777-7777-4777-8777-777777777777";
const staffAgentId = "88888888-8888-4888-8888-888888888888";
const ownerAgentId = "99999999-9999-4999-8999-999999999999";
const aaaaAgentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const scaffoldSpec = buildIssueDocumentTemplate("spec", {
  title: "Friction",
  description: "Reduce first-write friction",
  tier: "normal",
})!;

function resetIssueRouteModules() {
  vi.doUnmock("../routes/issues.js");
  vi.doUnmock("../routes/authz.js");
  vi.doUnmock("../middleware/index.js");
  vi.doUnmock("../middleware/validate.js");
  vi.doUnmock("../services/index.js");
  vi.doUnmock("../services/portfolio-clusters.js");
  vi.doUnmock("../telemetry.js");
  vi.doUnmock("@paperclipai/shared/telemetry");
}

type MutableIssue = {
  id: string;
  companyId: string;
  projectId: string;
  title: string;
  description: string;
  status: string;
  startedAt: string | null;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  parentId: string | null;
  executionState: unknown;
  executionPolicy: unknown;
  continuityState: {
    tier: "normal";
    specState: "frozen";
    docFreezeExceptions?: Array<{ key: string; reason: string; decisionNote: string; grantedByAgentId: string | null; grantedByUserId: string | null; grantedAt: string }>;
  };
};

function createRouteHarness() {
  const issue: MutableIssue = {
    id: issueId,
    companyId,
    projectId,
    title: "Friction",
    description: "Reduce first-write friction",
    status: "in_progress",
    startedAt: "2026-04-23T20:00:00.000Z",
    assigneeAgentId: ownerAgentId,
    assigneeUserId: null,
    parentId: null,
    executionState: null,
    executionPolicy: null,
    continuityState: {
      tier: "normal",
      specState: "frozen",
    },
  };

  let storedSpecBody = scaffoldSpec;

  return {
    issue,
    getStoredSpecBody: () => storedSpecBody,
    setStoredSpecBody: (body: string) => {
      storedSpecBody = body;
    },
    issueService: {
      getById: vi.fn(async () => issue),
      assertCheckoutOwner: vi.fn(async () => ({ adoptedFromRunId: null })),
    },
    documentsService: {
      getIssueDocumentByKey: vi.fn(async (_issueId: string, key: string) => {
        if (key === "spec") {
          return {
            id: "doc-spec",
            companyId,
            issueId: issue.id,
            key: "spec",
            title: null,
            format: "markdown",
            body: storedSpecBody,
            latestRevisionId: "rev-current",
            latestRevisionNumber: 1,
            createdByAgentId: null,
            createdByUserId: null,
            updatedByAgentId: null,
            updatedByUserId: null,
            createdAt: new Date("2026-04-23T20:00:00.000Z"),
            updatedAt: new Date("2026-04-23T20:00:00.000Z"),
          };
        }
        return null;
      }),
      upsertIssueDocument: vi.fn(async (input: { body: string }) => {
        storedSpecBody = input.body;
        return {
          created: false,
          document: {
            id: "doc-spec",
            companyId,
            issueId: issue.id,
            key: "spec",
            title: null,
            format: "markdown",
            body: input.body,
            latestRevisionId: "rev-next",
            latestRevisionNumber: 2,
            createdByAgentId: null,
            createdByUserId: null,
            updatedByAgentId: null,
            updatedByUserId: null,
            createdAt: new Date("2026-04-23T20:00:00.000Z"),
            updatedAt: new Date("2026-04-23T21:00:00.000Z"),
          },
        };
      }),
      listIssueDocumentRevisions: vi.fn(async () => [
        {
          id: "rev-prior",
          documentId: "doc-spec",
          revisionNumber: 1,
          title: null,
          format: "markdown",
          body: scaffoldSpec,
          changeSummary: null,
          baseRevisionId: null,
          createdByAgentId: null,
          createdByUserId: null,
          createdByRunId: null,
          createdAt: new Date("2026-04-23T19:00:00.000Z"),
        },
      ]),
      restoreIssueDocumentRevision: vi.fn(async (_input: { issueId: string; key: string; revisionId: string }) => ({
        document: {
          id: "doc-spec",
          companyId,
          issueId: issue.id,
          key: "spec",
          title: null,
          format: "markdown",
          body: scaffoldSpec,
          latestRevisionId: "rev-restored",
          latestRevisionNumber: 3,
          createdByAgentId: null,
          createdByUserId: null,
          updatedByAgentId: null,
          updatedByUserId: null,
          createdAt: new Date("2026-04-23T20:00:00.000Z"),
          updatedAt: new Date("2026-04-23T23:00:00.000Z"),
        },
        restoredFromRevisionId: "rev-prior",
        restoredFromRevisionNumber: 1,
      })),
      deleteIssueDocument: vi.fn(async () => ({
        id: "doc-spec",
        companyId,
        issueId: issue.id,
        key: "spec",
        title: null,
        format: "markdown",
        body: "",
        latestRevisionId: "rev-deleted",
        latestRevisionNumber: 3,
        createdByAgentId: null,
        createdByUserId: null,
        updatedByAgentId: null,
        updatedByUserId: null,
        createdAt: new Date("2026-04-23T20:00:00.000Z"),
        updatedAt: new Date("2026-04-23T23:00:00.000Z"),
      })),
    },
    accessService: {
      canUser: vi.fn(async () => true),
      hasPermission: vi.fn(async () => true),
    },
    agentService: {
      getById: vi.fn(async (id: string) => {
        if (id === executiveAgentId) {
          return { id: executiveAgentId, companyId, orgLevel: "executive", status: "active" };
        }
        if (id === staffAgentId) {
          return { id: staffAgentId, companyId, orgLevel: "staff", status: "active" };
        }
        if (id === ownerAgentId) {
          return { id: ownerAgentId, companyId, orgLevel: "staff", status: "active" };
        }
        if (id === aaaaAgentId) {
          return { id: aaaaAgentId, companyId, orgLevel: "executive", status: "active" };
        }
        return null;
      }),
    },
    issueApprovalsService: {
      listApprovalsForIssue: vi.fn(async () => [] as Array<{ status: string }>),
    },
    issueContinuityService: {
      recomputeIssueContinuityState: vi.fn(async () => issue.continuityState),
      grantDocFreezeExceptions: vi.fn(async (_issueId: string, input: { documentKeys?: string[]; decisionNote: string }, actor: { agentId?: string | null; userId?: string | null }) => {
        const now = "2026-04-23T22:00:00.000Z";
        const grantedKeys = input.documentKeys ?? ["spec", "plan", "test-plan", "handoff"];
        const exceptions = grantedKeys.map((key) => ({
          key,
          reason: "executive_thaw" as const,
          decisionNote: input.decisionNote,
          grantedByAgentId: actor.agentId ?? null,
          grantedByUserId: actor.userId ?? null,
          grantedAt: now,
        }));
        issue.continuityState = {
          ...issue.continuityState,
          docFreezeExceptions: [...(issue.continuityState.docFreezeExceptions ?? []), ...exceptions],
        };
        return { continuityState: issue.continuityState, grantedKeys };
      }),
      consumeDocFreezeException: vi.fn(async (_issueId: string, key: string) => {
        const remaining = (issue.continuityState.docFreezeExceptions ?? []).filter((exception) => exception.key !== key);
        const consumed = (issue.continuityState.docFreezeExceptions ?? []).find((exception) => exception.key === key) ?? null;
        issue.continuityState = { ...issue.continuityState, docFreezeExceptions: remaining };
        return consumed;
      }),
    },
    projectService: {
      getById: vi.fn(async () => ({ id: projectId, companyId, portfolioClusterId })),
    },
    portfolioClusterService: {
      getById: vi.fn(async () => ({
        id: portfolioClusterId,
        companyId,
        executiveSponsorAgentId: executiveAgentId,
      })),
    },
    logActivity: vi.fn(async () => undefined),
  };
}

function registerRouteMocks(harness: ReturnType<typeof createRouteHarness>) {
  vi.doMock("../services/index.js", () => ({
    accessService: () => harness.accessService,
    agentService: () => harness.agentService,
    documentService: () => harness.documentsService,
    executionWorkspaceService: () => ({}),
    feedbackService: () => ({}),
    goalService: () => ({}),
    heartbeatService: () => ({
      wakeup: vi.fn(async () => undefined),
      reportRunActivity: vi.fn(async () => undefined),
    }),
    instanceSettingsService: () => ({
      getExperimental: vi.fn(async () => ({})),
      getGeneral: vi.fn(async () => ({ feedbackDataSharingPreference: "prompt" })),
    }),
    issueApprovalService: () => harness.issueApprovalsService,
    issueContinuityService: () => harness.issueContinuityService,
    issueReferenceService: () => ({
      syncIssue: vi.fn(async () => undefined),
      syncComment: vi.fn(async () => undefined),
      syncDocument: vi.fn(async () => undefined),
      deleteDocumentSource: vi.fn(async () => undefined),
      listIssueReferenceSummary: vi.fn(async () => ({ outbound: [], inbound: [] })),
      diffIssueReferenceSummary: vi.fn(() => ({
        addedReferencedIssues: [],
        removedReferencedIssues: [],
        currentReferencedIssues: [],
      })),
      emptySummary: vi.fn(() => ({ outbound: [], inbound: [] })),
    }),
    issueService: () => harness.issueService,
    logActivity: harness.logActivity,
    officeCoordinationService: () => ({
      findOfficeOperator: vi.fn(async () => null),
      buildWakeSnapshot: vi.fn(async () => null),
      isOfficeOperatorAgent: vi.fn(async () => false),
    }),
    portfolioClusterService: () => harness.portfolioClusterService,
    projectService: () => harness.projectService,
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => ({}),
  }));
  vi.doMock("../services/portfolio-clusters.js", () => ({
    portfolioClusterService: () => harness.portfolioClusterService,
  }));
}

type ActorOverride = {
  type: "board" | "agent";
  agentId?: string;
  companyId?: string;
};

async function createApp(
  harness: ReturnType<typeof createRouteHarness>,
  actor: ActorOverride = { type: "board" },
) {
  registerRouteMocks(harness);
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/issues.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor =
      actor.type === "board"
        ? {
          type: "board",
          userId: "board-user",
          companyIds: [companyId],
          source: "local_implicit",
          isInstanceAdmin: false,
        }
        : {
          type: "agent",
          agentId: actor.agentId!,
          runId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          companyId: actor.companyId ?? companyId,
          source: "agent_api_key",
          isInstanceAdmin: false,
        };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("issue continuity doc-freeze friction", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    resetIssueRouteModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    resetIssueRouteModules();
  });

  it("allows first-write when stored body matches the scaffold baseline and logs thawPath=scaffold_bypass", async () => {
    const harness = createRouteHarness();
    const app = await createApp(harness, { type: "agent", agentId: ownerAgentId });
    const firstRealBody = `${scaffoldSpec}\n\n## Notes\n\nFirst real content.`;

    const res = await request(app)
      .put(`/api/issues/${issueId}/documents/spec`)
      .send({ format: "markdown", body: firstRealBody });

    expect(res.status).toBe(200);
    expect(harness.documentsService.upsertIssueDocument).toHaveBeenCalledTimes(1);
    expect(harness.issueApprovalsService.listApprovalsForIssue).toHaveBeenCalledTimes(1);
    expect(harness.logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.document_updated",
        details: expect.objectContaining({ thawPath: "scaffold_bypass" }),
      }),
    );
  });

  it("blocks post-first-content edits without an approval, then allows them once an executive_thaw is granted, and re-engages the freeze after consumption", async () => {
    const harness = createRouteHarness();
    const editedBody = `${scaffoldSpec}\n\n## Edits by continuity owner`;
    harness.setStoredSpecBody(editedBody);

    const ownerApp = await createApp(harness, { type: "agent", agentId: ownerAgentId });

    const blockedRes = await request(ownerApp)
      .put(`/api/issues/${issueId}/documents/spec`)
      .send({ format: "markdown", body: `${editedBody}\n\n## Another revision` });
    expect(blockedRes.status).toBe(403);
    expect(blockedRes.body.error).toMatch(/frozen spec/);
    expect(harness.documentsService.upsertIssueDocument).not.toHaveBeenCalled();

    const execApp = await createApp(harness, { type: "agent", agentId: executiveAgentId });
    const unfreezeRes = await request(execApp)
      .post(`/api/issues/${issueId}/continuity/doc-unfreeze`)
      .send({ decisionNote: "CEO thaw for first-content edit", documentKeys: ["spec"] });
    expect(unfreezeRes.status).toBe(201);
    expect(unfreezeRes.body.grantedKeys).toEqual(["spec"]);
    expect(harness.logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.continuity_doc_unfreeze_granted",
        details: expect.objectContaining({
          thawPath: "executive_thaw",
          decisionNote: "CEO thaw for first-content edit",
          documentKeys: ["spec"],
        }),
      }),
    );

    const thawedBody = `${editedBody}\n\n## After exec thaw`;
    const thawedRes = await request(ownerApp)
      .put(`/api/issues/${issueId}/documents/spec`)
      .send({ format: "markdown", body: thawedBody });
    expect(thawedRes.status).toBe(200);
    expect(harness.documentsService.upsertIssueDocument).toHaveBeenCalledTimes(1);
    expect(harness.issueContinuityService.consumeDocFreezeException).toHaveBeenCalledWith(issueId, "spec");
    expect(harness.logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.document_updated",
        details: expect.objectContaining({
          thawPath: "executive_thaw",
          thawDecisionNote: "CEO thaw for first-content edit",
          thawGrantedByAgentId: executiveAgentId,
        }),
      }),
    );

    harness.documentsService.upsertIssueDocument.mockClear();

    const secondEditBody = `${thawedBody}\n\n## Second edit should be blocked`;
    const rerefrozenRes = await request(ownerApp)
      .put(`/api/issues/${issueId}/documents/spec`)
      .send({ format: "markdown", body: secondEditBody });
    expect(rerefrozenRes.status).toBe(403);
    expect(harness.documentsService.upsertIssueDocument).not.toHaveBeenCalled();
  });

  it("rejects doc-unfreeze from non-sponsoring executive when a different sponsor is set on the project's cluster", async () => {
    const harness = createRouteHarness();
    harness.portfolioClusterService.getById.mockResolvedValue({
      id: portfolioClusterId,
      companyId,
      executiveSponsorAgentId: aaaaAgentId,
    });

    const nonSponsorExecApp = await createApp(harness, { type: "agent", agentId: executiveAgentId });
    const res = await request(nonSponsorExecApp)
      .post(`/api/issues/${issueId}/continuity/doc-unfreeze`)
      .send({ decisionNote: "Non-sponsor trying to thaw", documentKeys: ["spec"] });
    expect(res.status).toBe(403);
    expect(harness.issueContinuityService.grantDocFreezeExceptions).not.toHaveBeenCalled();
  });

  it("rejects doc-unfreeze from a non-executive agent and requires a decisionNote", async () => {
    const harness = createRouteHarness();
    const staffApp = await createApp(harness, { type: "agent", agentId: staffAgentId });
    const forbiddenRes = await request(staffApp)
      .post(`/api/issues/${issueId}/continuity/doc-unfreeze`)
      .send({ decisionNote: "should not be allowed", documentKeys: ["spec"] });
    expect(forbiddenRes.status).toBe(403);

    const execApp = await createApp(harness, { type: "agent", agentId: executiveAgentId });
    const missingNoteRes = await request(execApp)
      .post(`/api/issues/${issueId}/continuity/doc-unfreeze`)
      .send({ documentKeys: ["spec"] });
    expect(missingNoteRes.status).toBe(400);
  });

  it("allows any company executive to grant doc-unfreeze when no portfolio sponsor is set", async () => {
    const harness = createRouteHarness();
    harness.portfolioClusterService.getById.mockResolvedValue({
      id: portfolioClusterId,
      companyId,
      executiveSponsorAgentId: null,
    });

    const execApp = await createApp(harness, { type: "agent", agentId: executiveAgentId });
    const firstRes = await request(execApp)
      .post(`/api/issues/${issueId}/continuity/doc-unfreeze`)
      .send({ decisionNote: "No sponsor set — exec may thaw", documentKeys: ["spec"] });
    expect(firstRes.status).toBe(201);
    expect(harness.issueContinuityService.grantDocFreezeExceptions).toHaveBeenCalledTimes(1);

    const otherExecApp = await createApp(harness, { type: "agent", agentId: aaaaAgentId });
    const secondRes = await request(otherExecApp)
      .post(`/api/issues/${issueId}/continuity/doc-unfreeze`)
      .send({ decisionNote: "Another exec may also thaw when no sponsor", documentKeys: ["plan"] });
    expect(secondRes.status).toBe(201);
  });

  it("fails closed on sponsor lookup errors: transient DB failure denies doc-unfreeze rather than authorizing every company executive", async () => {
    const harness = createRouteHarness();
    harness.projectService.getById.mockRejectedValue(new Error("transient db failure"));

    const execApp = await createApp(harness, { type: "agent", agentId: executiveAgentId });
    const res = await request(execApp)
      .post(`/api/issues/${issueId}/continuity/doc-unfreeze`)
      .send({ decisionNote: "should fail closed under lookup error", documentKeys: ["spec"] });
    expect(res.status).toBe(403);
    expect(harness.issueContinuityService.grantDocFreezeExceptions).not.toHaveBeenCalled();
  });

  it("restore consumes the executive_thaw exception so the next restore or PUT is re-frozen", async () => {
    const harness = createRouteHarness();
    const editedBody = `${scaffoldSpec}\n\n## Edits by continuity owner`;
    harness.setStoredSpecBody(editedBody);

    const execApp = await createApp(harness, { type: "agent", agentId: executiveAgentId });
    const grantRes = await request(execApp)
      .post(`/api/issues/${issueId}/continuity/doc-unfreeze`)
      .send({ decisionNote: "Exec thaw for restore", documentKeys: ["spec"] });
    expect(grantRes.status).toBe(201);

    const ownerApp = await createApp(harness, { type: "agent", agentId: ownerAgentId });
    const restoreRes = await request(ownerApp)
      .post(`/api/issues/${issueId}/documents/spec/revisions/rev-prior/restore`)
      .send({});
    expect(restoreRes.status).toBe(200);
    expect(harness.documentsService.restoreIssueDocumentRevision).toHaveBeenCalledTimes(1);
    expect(harness.issueContinuityService.consumeDocFreezeException).toHaveBeenCalledWith(issueId, "spec");
    expect(harness.logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.document_restored",
        details: expect.objectContaining({
          thawPath: "executive_thaw",
          thawDecisionNote: "Exec thaw for restore",
          thawGrantedByAgentId: executiveAgentId,
        }),
      }),
    );

    harness.documentsService.restoreIssueDocumentRevision.mockClear();
    const secondRestoreRes = await request(ownerApp)
      .post(`/api/issues/${issueId}/documents/spec/revisions/rev-prior/restore`)
      .send({});
    expect(secondRestoreRes.status).toBe(403);
    expect(harness.documentsService.restoreIssueDocumentRevision).not.toHaveBeenCalled();
  });

  it("delete consumes the executive_thaw exception so a subsequent PUT is re-frozen", async () => {
    const harness = createRouteHarness();
    const editedBody = `${scaffoldSpec}\n\n## Edits by continuity owner`;
    harness.setStoredSpecBody(editedBody);

    const execApp = await createApp(harness, { type: "agent", agentId: executiveAgentId });
    const grantRes = await request(execApp)
      .post(`/api/issues/${issueId}/continuity/doc-unfreeze`)
      .send({ decisionNote: "Exec thaw for delete", documentKeys: ["spec"] });
    expect(grantRes.status).toBe(201);

    const boardApp = await createApp(harness, { type: "board" });
    const deleteRes = await request(boardApp).delete(`/api/issues/${issueId}/documents/spec`);
    expect(deleteRes.status).toBe(200);
    expect(harness.documentsService.deleteIssueDocument).toHaveBeenCalledTimes(1);
    expect(harness.issueContinuityService.consumeDocFreezeException).toHaveBeenCalledWith(issueId, "spec");
    expect(harness.logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.document_deleted",
        details: expect.objectContaining({
          thawPath: "executive_thaw",
          thawDecisionNote: "Exec thaw for delete",
          thawGrantedByAgentId: executiveAgentId,
        }),
      }),
    );

    const ownerApp = await createApp(harness, { type: "agent", agentId: ownerAgentId });
    const postDeletePutRes = await request(ownerApp)
      .put(`/api/issues/${issueId}/documents/spec`)
      .send({ format: "markdown", body: `${editedBody}\n\n## Post-delete edit should be refrozen` });
    expect(postDeletePutRes.status).toBe(403);
  });

  it("keeps the board scope-change thaw path intact: an approved linked approval routes through thawPath=approved_linked_approval", async () => {
    const harness = createRouteHarness();
    const nonScaffoldBody = `${scaffoldSpec}\n\n## First real content`;
    harness.setStoredSpecBody(nonScaffoldBody);
    harness.issueApprovalsService.listApprovalsForIssue.mockResolvedValue([
      { status: "approved" },
    ]);

    const ownerApp = await createApp(harness, { type: "agent", agentId: ownerAgentId });
    const editedBody = `${nonScaffoldBody}\n\n## Board-gated revision`;
    const res = await request(ownerApp)
      .put(`/api/issues/${issueId}/documents/spec`)
      .send({ format: "markdown", body: editedBody });

    expect(res.status).toBe(200);
    expect(harness.documentsService.upsertIssueDocument).toHaveBeenCalledTimes(1);
    expect(harness.issueContinuityService.consumeDocFreezeException).not.toHaveBeenCalled();
    expect(harness.logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.document_updated",
        details: expect.objectContaining({ thawPath: "approved_linked_approval" }),
      }),
    );
  });
});
