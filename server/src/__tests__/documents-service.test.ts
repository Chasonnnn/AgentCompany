import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  companyDocuments,
  createDb,
  documentRevisions,
  documents,
  issueDocuments,
  issues,
  projectDocuments,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { documentService } from "../services/documents.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres document service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("documentService concurrent upserts", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof documentService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-documents-service-");
    db = createDb(tempDb.connectionString);
    svc = documentService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueDocuments);
    await db.delete(projectDocuments);
    await db.delete(companyDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function expectSingleWinnerOnConcurrentUpdate(input: {
    createDocument: () => Promise<{
      document: {
        id: string;
        latestRevisionId: string | null;
      };
    }>;
    updateDocument: (baseRevisionId: string, body: string) => Promise<unknown>;
    revisionCount: () => Promise<number>;
  }) {
    const initial = await input.createDocument();
    const baseRevisionId = initial.document.latestRevisionId;
    expect(baseRevisionId).toBeTruthy();

    let releaseLock!: () => void;
    let lockReadyResolve!: () => void;
    const lockReady = new Promise<void>((resolve) => {
      lockReadyResolve = resolve;
    });
    const lockReleased = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    const lockTx = db.transaction(async (tx) => {
      await tx.execute(
        sql`select ${documents.id} from ${documents} where ${documents.id} = ${initial.document.id} for update`,
      );
      lockReadyResolve();
      await lockReleased;
    });

    await lockReady;
    const updateA = input.updateDocument(baseRevisionId as string, "# A");
    const updateB = input.updateDocument(baseRevisionId as string, "# B");
    await sleep(50);
    releaseLock();

    const results = await Promise.allSettled([updateA, updateB]);
    await lockTx;

    const fulfilled = results.filter((result): result is PromiseFulfilledResult<unknown> => result.status === "fulfilled");
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({
      status: 409,
      message: "Document was updated by someone else",
    });
    expect(await input.revisionCount()).toBe(2);
  }

  it("serializes concurrent issue document upserts on the same base revision", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Issue document target",
      status: "todo",
      priority: "medium",
    });

    await expectSingleWinnerOnConcurrentUpdate({
      createDocument: () =>
        svc.upsertIssueDocument({
          issueId,
          key: "plan",
          format: "markdown",
          body: "# Initial",
        }),
      updateDocument: (baseRevisionId, body) =>
        svc.upsertIssueDocument({
          issueId,
          key: "plan",
          format: "markdown",
          body,
          baseRevisionId,
        }),
      revisionCount: async () => svc.listIssueDocumentRevisions(issueId, "plan").then((rows) => rows.length),
    });
  });

  it("serializes concurrent project document upserts on the same base revision", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Project document target",
      status: "active",
    });

    await expectSingleWinnerOnConcurrentUpdate({
      createDocument: () =>
        svc.upsertProjectDocument({
          projectId,
          key: "runbook",
          format: "markdown",
          body: "# Initial",
        }),
      updateDocument: (baseRevisionId, body) =>
        svc.upsertProjectDocument({
          projectId,
          key: "runbook",
          format: "markdown",
          body,
          baseRevisionId,
        }),
      revisionCount: async () => svc.listProjectDocumentRevisions(projectId, "runbook").then((rows) => rows.length),
    });
  });

  it("serializes concurrent company document upserts on the same base revision", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await expectSingleWinnerOnConcurrentUpdate({
      createDocument: () =>
        svc.upsertCompanyDocument({
          companyId,
          key: "plan",
          format: "markdown",
          body: "# Initial",
        }),
      updateDocument: (baseRevisionId, body) =>
        svc.upsertCompanyDocument({
          companyId,
          key: "plan",
          format: "markdown",
          body,
          baseRevisionId,
        }),
      revisionCount: async () => svc.listCompanyDocumentRevisions(companyId, "plan").then((rows) => rows.length),
    });
  });
});
