import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyDocuments,
  createDb,
  documentRevisions,
  documents,
  executionWorkspaces,
  heartbeatRuns,
  issueDocuments,
  issueInboxArchives,
  issueRelations,
  issueComments,
  issues,
  projectDocuments,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import { parseIssueProgressMarkdown } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";
import { issueContinuityService } from "../services/issue-continuity.ts";
import { documentService } from "../services/documents.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres continuity scaffold tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issueContinuityService.prepare scaffolds continuity docs for subtasks", () => {
  let db!: ReturnType<typeof createDb>;
  let issues$: ReturnType<typeof issueService>;
  let continuity$: ReturnType<typeof issueContinuityService>;
  let docs$: ReturnType<typeof documentService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-continuity-scaffold-");
    db = createDb(tempDb.connectionString);
    issues$ = issueService(db);
    continuity$ = issueContinuityService(db);
    docs$ = documentService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueDocuments);
    await db.delete(projectDocuments);
    await db.delete(companyDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issueInboxArchives);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndParentIssue() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const parent = await issues$.create(companyId, {
      title: "Parent issue",
      status: "todo",
      priority: "medium",
      createdByAgentId: agentId,
    });
    return { companyId, agentId, parentId: parent.id };
  }

  async function createSubtask(companyId: string, parentId: string, assigneeAgentId: string) {
    return issues$.create(companyId, {
      title: "Child audit",
      parentId,
      assigneeAgentId,
      status: "todo",
      priority: "medium",
      createdByAgentId: assigneeAgentId,
    });
  }

  it("T1+T3: default tier 'normal' scaffolds all 4 required docs with valid progress frontmatter", async () => {
    const { companyId, agentId, parentId } = await seedCompanyAndParentIssue();
    const child = await createSubtask(companyId, parentId, agentId);

    const prepared = await continuity$.prepare(child.id, { tier: "normal" }, { agentId });

    expect(prepared.continuityState.missingDocumentKeys).toEqual([]);
    expect(prepared.continuityState.health).toBe("healthy");
    expect(prepared.scaffoldedKeys.sort()).toEqual(["plan", "progress", "spec", "test-plan"]);
    expect(prepared.overriddenKeys).toEqual([]);

    const specDoc = await docs$.getIssueDocumentByKey(child.id, "spec");
    expect(specDoc?.body).toContain("## Goal");

    const planDoc = await docs$.getIssueDocumentByKey(child.id, "plan");
    expect(planDoc?.body).toContain("## Steps");

    const progressDoc = await docs$.getIssueDocumentByKey(child.id, "progress");
    expect(progressDoc?.body).toMatch(/^---\n/);
    expect(parseIssueProgressMarkdown(progressDoc?.body ?? "")).not.toBeNull();

    const testPlanDoc = await docs$.getIssueDocumentByKey(child.id, "test-plan");
    expect(testPlanDoc?.body).toContain("## Coverage");
  });

  it("T3: docs override seeds caller content; missing keys still fall back to templates", async () => {
    const { companyId, agentId, parentId } = await seedCompanyAndParentIssue();
    const child = await createSubtask(companyId, parentId, agentId);

    const customSpec = "## Goal\n\nCaller-supplied spec body.\n";
    const customProgress = [
      "---",
      "kind: paperclip/issue-progress.v1",
      'currentState: "Caller authored"',
      'nextAction: "Do the caller-specified first move"',
      "knownPitfalls: []",
      "openQuestions: []",
      "evidence: []",
      "---",
      "",
      "Caller progress narrative.",
    ].join("\n");

    const prepared = await continuity$.prepare(
      child.id,
      {
        tier: "normal",
        docs: {
          spec: { body: customSpec },
          progress: { body: customProgress },
        },
      },
      { agentId },
    );

    expect(prepared.continuityState.missingDocumentKeys).toEqual([]);
    expect(prepared.overriddenKeys.sort()).toEqual(["progress", "spec"]);
    expect(prepared.scaffoldedKeys.sort()).toEqual(["plan", "test-plan"]);

    const specDoc = await docs$.getIssueDocumentByKey(child.id, "spec");
    expect(specDoc?.body).toBe(customSpec);

    const progressDoc = await docs$.getIssueDocumentByKey(child.id, "progress");
    expect(progressDoc?.body).toBe(customProgress);
    expect(parseIssueProgressMarkdown(progressDoc?.body ?? "")).not.toBeNull();

    const planDoc = await docs$.getIssueDocumentByKey(child.id, "plan");
    expect(planDoc?.body).toContain("## Steps");
    const testPlanDoc = await docs$.getIssueDocumentByKey(child.id, "test-plan");
    expect(testPlanDoc?.body).toContain("## Coverage");
  });

  it("T6: 'long_running' tier scaffolds all 6 required docs", async () => {
    const { companyId, agentId, parentId } = await seedCompanyAndParentIssue();
    const child = await createSubtask(companyId, parentId, agentId);

    const prepared = await continuity$.prepare(child.id, { tier: "long_running" }, { agentId });

    expect(prepared.continuityState.missingDocumentKeys).toEqual([]);
    expect(prepared.scaffoldedKeys.sort()).toEqual([
      "handoff",
      "plan",
      "progress",
      "runbook",
      "spec",
      "test-plan",
    ]);

    for (const key of ["spec", "plan", "runbook", "progress", "test-plan", "handoff"]) {
      const doc = await docs$.getIssueDocumentByKey(child.id, key);
      expect(doc, `doc ${key} should exist`).not.toBeNull();
      expect(doc!.body.length).toBeGreaterThan(0);
    }
  });

  it("T7: second prepare() call is idempotent — no new scaffolding when docs already exist", async () => {
    const { companyId, agentId, parentId } = await seedCompanyAndParentIssue();
    const child = await createSubtask(companyId, parentId, agentId);

    const first = await continuity$.prepare(child.id, { tier: "normal" }, { agentId });
    expect(first.scaffoldedKeys.length).toBe(4);

    const second = await continuity$.prepare(child.id, { tier: "normal" }, { agentId });
    expect(second.scaffoldedKeys).toEqual([]);
    expect(second.overriddenKeys).toEqual([]);
    expect(second.continuityState.missingDocumentKeys).toEqual([]);
  });
});
