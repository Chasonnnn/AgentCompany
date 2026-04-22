import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function createDefaultSharedSkill() {
  return {
    id: "shared-skill-1",
    key: "global/codex/abc123/find-skills",
    slug: "find-skills",
    name: "Find Skills",
    description: null,
    markdown: "# Find Skills",
    fileInventory: [{ path: "SKILL.md", kind: "skill" }],
    trustLevel: "markdown_only",
    compatibility: "compatible",
    sourceRoot: "codex",
    sourcePath: "/Users/chason/.codex/skills/find-skills",
    sourceDigest: "source-digest",
    lastMirroredSourceDigest: "source-digest",
    mirrorDigest: "mirror-digest",
    lastAppliedMirrorDigest: "mirror-digest",
    mirrorState: "pristine",
    sourceDriftState: "in_sync",
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function createDefaultProposal() {
  return {
    id: "proposal-1",
    sharedSkillId: "shared-skill-1",
    companyId: "company-1",
    issueId: null,
    runId: "run-1",
    proposedByAgentId: "agent-1",
    proposedByUserId: null,
    kind: "self_improvement",
    status: "pending",
    summary: "Improve find-skills",
    rationale: "Reusable recovery step was missing.",
    baseMirrorDigest: "mirror-digest",
    baseSourceDigest: "source-digest",
    proposalFingerprint: "fingerprint-1",
    payload: {
      changes: [{ path: "SKILL.md", op: "replace_file", content: "# New" }],
      evidence: { runId: "run-1" },
      requiredVerification: {
        unitCommands: ["pnpm -r typecheck"],
        integrationCommands: ["pnpm test:run"],
        promptfooCaseIds: ["reliability.skill_disambiguation"],
        architectureScenarioIds: ["failure-promoted-hardening-scaffold"],
        smokeChecklist: ["promote finding"],
      },
      verificationResults: {
        passedUnitCommands: [],
        passedIntegrationCommands: [],
        passedPromptfooCaseIds: [],
        passedArchitectureScenarioIds: [],
        completedSmokeChecklist: [],
      },
    },
    decisionNote: null,
    decidedByUserId: null,
    decidedAt: null,
    appliedMirrorDigest: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

async function createApp(actor: Record<string, unknown>) {
  vi.doUnmock("../routes/shared-skills.js");
  vi.doUnmock("../middleware/index.js");
  vi.doUnmock("../middleware/validate.js");
  vi.doUnmock("../routes/authz.js");
  vi.doUnmock("../services/index.js");
  vi.doUnmock("../services/office-coordination-wakeup.js");

  const state = {
    listResult: [createDefaultSharedSkill()],
    syncMirrorsResult: {
      mode: "refresh",
      totalCount: 1,
      bootstrappedCount: 0,
      updatedCount: 1,
      unchangedCount: 0,
      classifiedCount: 0,
      items: [],
    },
    proposalListResult: [],
    proposalDetailResult: null,
    linkedCompanyIds: ["company-1"],
    isSkillVisibleToCompany: true,
    isSkillAvailableForRun: true,
    officeOperator: {
      id: "office-1",
      companyId: "company-1",
      role: "coo",
      archetypeKey: "chief_of_staff",
      status: "idle",
    },
    officeWakeSnapshot: {
      companyId: "company-1",
      officeAgentId: "office-1",
      trigger: { reason: "shared_skill_proposal_created" },
      queueCounts: {
        untriagedIntake: 0,
        unassignedIssues: 0,
        blockedIssues: 0,
        staleIssues: 0,
        staffingGaps: 0,
        engagementsNeedingAttention: 0,
        sharedSkillItems: 1,
      },
      untriagedIntake: [],
      unassignedIssues: [],
      blockedIssues: [],
      staleIssues: [],
      staffingGaps: [],
      engagementsNeedingAttention: [],
      sharedSkillItems: [],
      recentActions: [],
    },
    isOfficeOperatorActor: false,
    createProposalResult: createDefaultProposal(),
    approveProposalResult: {
      id: "proposal-1",
      sharedSkillId: "shared-skill-1",
      companyId: "company-1",
      kind: "self_improvement",
      status: "approved",
      summary: "Improve find-skills",
    },
    approveProposalError: null as Error | null,
    rejectProposalResult: {
      id: "proposal-1",
      sharedSkillId: "shared-skill-1",
      companyId: "company-1",
      kind: "self_improvement",
      status: "rejected",
      summary: "Improve find-skills",
    },
    addCommentResult: {
      id: "comment-1",
      proposalId: "proposal-1",
      authorAgentId: null,
      authorUserId: "user-1",
      body: "Needs revision",
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    updateProposalVerificationResult: {
      ...createDefaultProposal(),
      payload: {
        ...createDefaultProposal().payload,
        verificationResults: {
          passedUnitCommands: ["pnpm -r typecheck"],
          passedIntegrationCommands: ["pnpm test:run"],
          passedPromptfooCaseIds: ["reliability.skill_disambiguation"],
          passedArchitectureScenarioIds: ["failure-promoted-hardening-scaffold"],
          completedSmokeChecklist: ["promote finding"],
        },
      },
    },
  };

  const calls = {
    list: [] as unknown[][],
    detail: [] as unknown[][],
    drift: [] as unknown[][],
    syncMirrors: [] as unknown[][],
    listProposals: [] as unknown[][],
    proposalDetail: [] as unknown[][],
    createProposal: [] as unknown[][],
    approveProposal: [] as unknown[][],
    rejectProposal: [] as unknown[][],
    addComment: [] as unknown[][],
    updateProposalVerification: [] as unknown[][],
    listLinkedCompanyIds: [] as unknown[][],
    isSkillVisibleToCompany: [] as unknown[][],
    isSkillAvailableForRun: [] as unknown[][],
    findOfficeOperator: [] as unknown[][],
    buildWakeSnapshot: [] as unknown[][],
    isOfficeOperatorAgent: [] as unknown[][],
    wakeup: [] as unknown[][],
    logActivity: [] as unknown[][],
  };

  const sharedSkillService = {
    list: async () => {
      calls.list.push([]);
      return state.listResult;
    },
    detail: async (...args: unknown[]) => {
      calls.detail.push(args);
      return null;
    },
    drift: async (...args: unknown[]) => {
      calls.drift.push(args);
      return null;
    },
    syncMirrors: async (...args: unknown[]) => {
      calls.syncMirrors.push(args);
      return state.syncMirrorsResult;
    },
    listCatalogEntries: async () => [],
    attachMirrorToCompany: async () => createDefaultSharedSkill(),
    listProposals: async (...args: unknown[]) => {
      calls.listProposals.push(args);
      return state.proposalListResult;
    },
    proposalDetail: async (...args: unknown[]) => {
      calls.proposalDetail.push(args);
      return state.proposalDetailResult;
    },
    createProposal: async (...args: unknown[]) => {
      calls.createProposal.push(args);
      return state.createProposalResult;
    },
    approveProposal: async (...args: unknown[]) => {
      calls.approveProposal.push(args);
      if (state.approveProposalError) {
        throw state.approveProposalError;
      }
      return state.approveProposalResult;
    },
    rejectProposal: async (...args: unknown[]) => {
      calls.rejectProposal.push(args);
      return state.rejectProposalResult;
    },
    addComment: async (...args: unknown[]) => {
      calls.addComment.push(args);
      return state.addCommentResult;
    },
    updateProposalVerification: async (...args: unknown[]) => {
      calls.updateProposalVerification.push(args);
      return state.updateProposalVerificationResult;
    },
    buildRuntimeContext: async () => [],
    listLinkedCompanyIds: async (...args: unknown[]) => {
      calls.listLinkedCompanyIds.push(args);
      return state.linkedCompanyIds;
    },
    listOpenProposalSummaries: async () => [],
    isSkillVisibleToCompany: async (...args: unknown[]) => {
      calls.isSkillVisibleToCompany.push(args);
      return state.isSkillVisibleToCompany;
    },
    isSkillAvailableForRun: async (...args: unknown[]) => {
      calls.isSkillAvailableForRun.push(args);
      return state.isSkillAvailableForRun;
    },
    shouldEnqueueFallbackReview: async () => false,
  };

  const heartbeatService = {
    wakeup: async (...args: unknown[]) => {
      calls.wakeup.push(args);
    },
  };

  const officeCoordinationService = {
    findOfficeOperator: async (...args: unknown[]) => {
      calls.findOfficeOperator.push(args);
      return state.officeOperator;
    },
    buildWakeSnapshot: async (...args: unknown[]) => {
      calls.buildWakeSnapshot.push(args);
      return state.officeWakeSnapshot;
    },
    isOfficeOperatorAgent: async (...args: unknown[]) => {
      calls.isOfficeOperatorAgent.push(args);
      return state.isOfficeOperatorActor;
    },
  };

  const logActivity = async (...args: unknown[]) => {
    calls.logActivity.push(args);
  };

  const [{ errorHandler }, { sharedSkillRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/shared-skills.js")>("../routes/shared-skills.js"),
  ]);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", sharedSkillRoutes({} as any, {
    heartbeatService: heartbeatService as any,
    sharedSkillService: sharedSkillService as any,
    logActivity: logActivity as any,
    officeCoordinationService: officeCoordinationService as any,
  }));
  app.use(errorHandler);

  return { app, state, calls };
}

describe("shared skill routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/shared-skills.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../middleware/validate.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/office-coordination-wakeup.js");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("../routes/shared-skills.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../middleware/validate.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/office-coordination-wakeup.js");
  });

  it("allows instance admins to list shared skills", async () => {
    const { app, calls } = await createApp({
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await request(app).get("/api/instance/shared-skills");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(calls.list).toHaveLength(1);
  });

  it("blocks non-instance-admin board users from instance shared skill routes", async () => {
    const { app, calls } = await createApp({
      type: "board",
      userId: "user-2",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post("/api/instance/shared-skills/mirror-sync")
      .send({ mode: "refresh" });

    expect(res.status).toBe(403);
    expect(calls.syncMirrors).toHaveLength(0);
  });

  it("requires run evidence for company shared skill proposals", async () => {
    const { app, calls } = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: null,
    });

    const res = await request(app)
      .post("/api/companies/company-1/shared-skills/shared-skill-1/proposals")
      .send({
        kind: "self_improvement",
        summary: "Improve find-skills",
        rationale: "Reusable recovery step was missing.",
        baseMirrorDigest: "mirror-digest",
        baseSourceDigest: "source-digest",
        changes: [{ path: "SKILL.md", op: "replace_file", content: "# New" }],
        evidence: {},
      });

    expect(res.status).toBe(422);
    expect(calls.createProposal).toHaveLength(0);
  });

  it("creates a company shared skill proposal when the skill was present in the run", async () => {
    const { app, calls } = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-1",
    });

    const res = await request(app)
      .post("/api/companies/company-1/shared-skills/shared-skill-1/proposals")
      .send({
        kind: "self_improvement",
        summary: "Improve find-skills",
        rationale: "Reusable recovery step was missing.",
        baseMirrorDigest: "mirror-digest",
        baseSourceDigest: "source-digest",
        changes: [{ path: "SKILL.md", op: "replace_file", content: "# New" }],
        evidence: {},
      });

    expect(res.status).toBe(201);
    expect(calls.isSkillAvailableForRun).toEqual([["run-1", "shared-skill-1", "company-1"]]);
    expect(calls.createProposal).toHaveLength(1);
    expect(calls.logActivity).toHaveLength(1);
    expect(calls.wakeup).toEqual([[
      "office-1",
      expect.objectContaining({ reason: "office_coordination_requested" }),
    ]]);
  });

  it("allows the office operator to draft a proposal for a company-visible shared skill without run evidence", async () => {
    const { app, state, calls } = await createApp({
      type: "agent",
      agentId: "office-1",
      companyId: "company-1",
      runId: null,
    });
    state.isOfficeOperatorActor = true;

    const res = await request(app)
      .post("/api/companies/company-1/shared-skills/shared-skill-1/proposals")
      .send({
        kind: "merge_review",
        summary: "Review upstream drift",
        rationale: "Paperclip mirror diverged from the company-visible source.",
        baseMirrorDigest: "mirror-digest",
        baseSourceDigest: "source-digest",
        changes: [{ path: "SKILL.md", op: "replace_file", content: "# New" }],
        evidence: {},
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(calls.isSkillAvailableForRun).toHaveLength(0);
    expect(calls.isSkillVisibleToCompany).toEqual([["shared-skill-1", "company-1"]]);
    expect(calls.createProposal).toHaveLength(1);
  });

  it("updates proposal verification evidence for instance admins", async () => {
    const { app, calls } = await createApp({
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const payload = {
      passedUnitCommands: ["pnpm -r typecheck"],
      passedIntegrationCommands: ["pnpm test:run"],
      passedPromptfooCaseIds: ["reliability.skill_disambiguation"],
      passedArchitectureScenarioIds: ["failure-promoted-hardening-scaffold"],
      completedSmokeChecklist: ["promote finding"],
    };

    const res = await request(app)
      .patch("/api/instance/shared-skills/proposals/proposal-1/verification")
      .send(payload);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(calls.updateProposalVerification).toEqual([["proposal-1", payload]]);
    expect(calls.logActivity).toHaveLength(1);
  });

  it("surfaces proposal approval gating failures from the service", async () => {
    const { app, state, calls } = await createApp({
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const { unprocessable } = await import("../errors.js");
    state.approveProposalError = unprocessable("Required verification is incomplete for this proposal.");

    const res = await request(app)
      .post("/api/instance/shared-skills/proposals/proposal-1/approve")
      .send({ decisionNote: "needs full verification" });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toBe("Required verification is incomplete for this proposal.");
    expect(calls.approveProposal).toEqual([["proposal-1", "user-1", "needs full verification"]]);
    expect(calls.logActivity).toHaveLength(0);
  });
});
