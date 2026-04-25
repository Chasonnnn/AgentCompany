import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companySkills,
  companies,
  createDb,
  documentRevisions,
  documents,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueRelations,
  issueTreeHolds,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Dependency-aware heartbeat test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat dependency scheduling tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function ensureIssueRelationsTable(db: ReturnType<typeof createDb>) {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "issue_relations" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "company_id" uuid NOT NULL,
      "issue_id" uuid NOT NULL,
      "related_issue_id" uuid NOT NULL,
      "type" text NOT NULL,
      "created_by_agent_id" uuid,
      "created_by_user_id" text,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );
  `));
}

async function waitForCondition(fn: () => Promise<boolean>, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fn();
}

async function insertCompanyProjectAgent(
  db: ReturnType<typeof createDb>,
  input?: { agentStatus?: "active" | "paused"; maxConcurrentRuns?: number },
) {
  const companyId = randomUUID();
  const projectId = randomUUID();
  const agentId = randomUUID();
  await db.insert(companies).values({
    id: companyId,
    name: "Paperclip",
    issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    requireBoardApprovalForNewAgents: false,
  });
  await db.insert(projects).values({
    id: projectId,
    companyId,
    name: "Idle active reconcile",
    status: "in_progress",
  });
  await db.insert(agents).values({
    id: agentId,
    companyId,
    name: "CodexCoder",
    role: "engineer",
    status: input?.agentStatus ?? "active",
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {
      heartbeat: {
        wakeOnDemand: true,
        maxConcurrentRuns: input?.maxConcurrentRuns ?? 1,
      },
    },
    permissions: {},
  });
  return { companyId, projectId, agentId };
}

describeEmbeddedPostgres("heartbeat dependency-aware queued run selection", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-dependency-scheduling-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    await ensureIssueRelationsTable(db);
  }, 20_000);

  afterEach(async () => {
    vi.clearAllMocks();
    runningProcesses.clear();
    let idlePolls = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const runs = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns);
      const hasActiveRun = runs.some((run) => run.status === "queued" || run.status === "running");
      if (!hasActiveRun) {
        idlePolls += 1;
        if (idlePolls >= 3) break;
      } else {
        idlePolls = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    await db.delete(activityLog);
    await db.delete(companySkills);
    await db.delete(issueComments);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issueRelations);
    await db.delete(issueTreeHolds);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("keeps blocked descendants queued until their blockers resolve", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const blockerId = randomUUID();
    const blockedIssueId = randomUUID();
    const readyIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Dependency scheduling",
      status: "in_progress",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: blockerId,
        companyId,
        projectId,
        title: "Mission 0",
        status: "todo",
        priority: "high",
      },
      {
        id: blockedIssueId,
        companyId,
        projectId,
        title: "Mission 2",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
      },
      {
        id: readyIssueId,
        companyId,
        projectId,
        title: "Mission 1",
        status: "todo",
        priority: "critical",
        assigneeAgentId: agentId,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });

    const blockedWake = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: blockedIssueId },
      contextSnapshot: { issueId: blockedIssueId, wakeReason: "issue_assigned" },
    });
    expect(blockedWake).not.toBeNull();

    await waitForCondition(async () => {
      await heartbeat.resumeQueuedRuns();
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, blockedWake!.id))
        .then((rows) => rows[0] ?? null);
      return run?.status === "queued";
    });

    const readyWake = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: readyIssueId },
      contextSnapshot: { issueId: readyIssueId, wakeReason: "issue_assigned" },
    });
    expect(readyWake).not.toBeNull();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, readyWake!.id))
        .then((rows) => rows[0] ?? null);
      return run?.status === "succeeded";
    });

    const [blockedRun, readyRun] = await Promise.all([
      db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, blockedWake!.id)).then((rows) => rows[0] ?? null),
      db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, readyWake!.id)).then((rows) => rows[0] ?? null),
    ]);

    expect(blockedRun?.status).toBe("queued");
    expect(readyRun?.status).toBe("succeeded");

    await db
      .update(issues)
      .set({ status: "done", updatedAt: new Date() })
      .where(eq(issues.id, blockerId));

    await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: { issueId: blockedIssueId, resolvedBlockerIssueId: blockerId },
      contextSnapshot: {
        issueId: blockedIssueId,
        wakeReason: "issue_blockers_resolved",
        resolvedBlockerIssueId: blockerId,
      },
    });

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, blockedWake!.id))
        .then((rows) => rows[0] ?? null);
      return run?.status === "succeeded";
    }, 10_000);

    const promotedBlockedRun = await db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, blockedWake!.id))
      .then((rows) => rows[0] ?? null);
    const blockedWakeRequestCount = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, agentId),
          sql`${agentWakeupRequests.payload} ->> 'issueId' = ${blockedIssueId}`,
        ),
      )
      .then((rows) => rows[0]?.count ?? 0);

    expect(promotedBlockedRun?.status).toBe("succeeded");
    expect(blockedWakeRequestCount).toBeGreaterThanOrEqual(2);
  });

  it("suppresses normal wakeups while allowing comment interaction wakes under a pause hold", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const rootIssueId = randomUUID();
    const childIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Pause hold wakeups",
      status: "in_progress",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "SecurityEngineer",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: rootIssueId,
        companyId,
        projectId,
        title: "Paused root",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
      },
      {
        id: childIssueId,
        companyId,
        projectId,
        parentId: rootIssueId,
        title: "Paused child",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
      },
    ]);
    const [hold] = await db
      .insert(issueTreeHolds)
      .values({
        companyId,
        rootIssueId,
        mode: "pause",
        status: "active",
        reason: "security test hold",
        releasePolicy: { strategy: "manual" },
      })
      .returning();

    const blockedWake = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: { issueId: childIssueId },
      contextSnapshot: { issueId: childIssueId, wakeReason: "issue_blockers_resolved" },
    });

    expect(blockedWake).toBeNull();
    const skippedWake = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
      })
      .from(agentWakeupRequests)
      .where(sql`${agentWakeupRequests.payload} ->> 'issueId' = ${childIssueId}`)
      .then((rows) => rows[0] ?? null);
    expect(skippedWake).toMatchObject({ status: "skipped", reason: "issue_tree_hold_active" });

    const childCommentWake = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId: childIssueId, commentId: randomUUID() },
      contextSnapshot: { issueId: childIssueId, wakeReason: "issue_commented" },
    });

    expect(childCommentWake).not.toBeNull();
    const childRun = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, childCommentWake!.id))
      .then((rows) => rows[0] ?? null);
    expect(childRun?.contextSnapshot).toMatchObject({
      treeHoldInteraction: true,
      activeTreeHold: {
        holdId: hold.id,
        rootIssueId,
        mode: "pause",
        interaction: true,
      },
    });
  });

  it("allows comment interaction wakes when a legacy hold has a full_pause note", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const rootIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Legacy full pause hold",
      status: "in_progress",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "SecurityEngineer",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db.insert(issues).values({
      id: rootIssueId,
      companyId,
      projectId,
      title: "Paused root",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    await db.insert(issueTreeHolds).values({
      companyId,
      rootIssueId,
      mode: "pause",
      status: "active",
      reason: "full pause",
      releasePolicy: { strategy: "manual", note: "full_pause" },
    });

    const rootCommentWake = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId: rootIssueId, commentId: randomUUID() },
      contextSnapshot: { issueId: rootIssueId, wakeReason: "issue_commented" },
    });

    expect(rootCommentWake).not.toBeNull();
    const rootRun = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, rootCommentWake!.id))
      .then((rows) => rows[0] ?? null);
    expect(rootRun?.contextSnapshot).toMatchObject({
      treeHoldInteraction: true,
      activeTreeHold: {
        rootIssueId,
        mode: "pause",
        interaction: true,
      },
    });
  });

  it("reconciles assigned idle todo and in-progress issues after the idle threshold", async () => {
    const { companyId, projectId, agentId } = await insertCompanyProjectAgent(db, { maxConcurrentRuns: 2 });
    const todoIssueId = randomUUID();
    const inProgressIssueId = randomUUID();
    const oldUpdatedAt = new Date("2026-04-24T09:00:00.000Z");
    const now = new Date("2026-04-24T09:20:00.000Z");

    await db.insert(issues).values([
      {
        id: todoIssueId,
        companyId,
        projectId,
        title: "Idle todo",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        updatedAt: oldUpdatedAt,
      },
      {
        id: inProgressIssueId,
        companyId,
        projectId,
        title: "Idle in progress",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        updatedAt: oldUpdatedAt,
      },
    ]);

    const result = await heartbeat.reconcileIdleActiveIssues({
      now,
      idleThresholdMs: 10 * 60 * 1000,
      maxPerAgentPerTick: 2,
    });

    expect(result.enqueued).toBe(2);
    expect(result.issueIds.sort()).toEqual([inProgressIssueId, todoIssueId].sort());
    const wakeRows = await db
      .select({
        reason: agentWakeupRequests.reason,
        source: agentWakeupRequests.source,
        triggerDetail: agentWakeupRequests.triggerDetail,
        issueId: sql<string>`${agentWakeupRequests.payload} ->> 'issueId'`,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.reason, "idle_active_issue_reconcile"));
    expect(wakeRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          issueId: todoIssueId,
          source: "automation",
          triggerDetail: "system",
        }),
        expect.objectContaining({
          issueId: inProgressIssueId,
          source: "automation",
          triggerDetail: "system",
        }),
      ]),
    );
  });

  it("skips idle candidates that are unassigned, blocked, dependency-blocked, tree-held, recent, or already queued", async () => {
    const { companyId, projectId, agentId } = await insertCompanyProjectAgent(db);
    const blockerId = randomUUID();
    const dependencyBlockedId = randomUUID();
    const treeHeldRootId = randomUUID();
    const treeHeldChildId = randomUUID();
    const unassignedIssueId = randomUUID();
    const statusBlockedIssueId = randomUUID();
    const recentIssueId = randomUUID();
    const alreadyQueuedIssueId = randomUUID();
    const oldUpdatedAt = new Date("2026-04-24T09:00:00.000Z");
    const recentUpdatedAt = new Date("2026-04-24T09:18:00.000Z");
    const now = new Date("2026-04-24T09:20:00.000Z");

    await db.insert(issues).values([
      {
        id: blockerId,
        companyId,
        projectId,
        title: "Dependency blocker",
        status: "todo",
        priority: "medium",
        updatedAt: oldUpdatedAt,
      },
      {
        id: dependencyBlockedId,
        companyId,
        projectId,
        title: "Dependency blocked candidate",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        updatedAt: oldUpdatedAt,
      },
      {
        id: treeHeldRootId,
        companyId,
        projectId,
        title: "Tree held root",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        updatedAt: oldUpdatedAt,
      },
      {
        id: treeHeldChildId,
        companyId,
        projectId,
        parentId: treeHeldRootId,
        title: "Tree held child",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        updatedAt: oldUpdatedAt,
      },
      {
        id: unassignedIssueId,
        companyId,
        projectId,
        title: "Unassigned",
        status: "todo",
        priority: "medium",
        updatedAt: oldUpdatedAt,
      },
      {
        id: statusBlockedIssueId,
        companyId,
        projectId,
        title: "Blocked status",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: agentId,
        updatedAt: oldUpdatedAt,
      },
      {
        id: recentIssueId,
        companyId,
        projectId,
        title: "Too recent",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        updatedAt: recentUpdatedAt,
      },
      {
        id: alreadyQueuedIssueId,
        companyId,
        projectId,
        title: "Already queued",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        updatedAt: oldUpdatedAt,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: dependencyBlockedId,
      type: "blocks",
    });
    await db.insert(issueTreeHolds).values({
      companyId,
      rootIssueId: treeHeldRootId,
      mode: "pause",
      status: "active",
      reason: "pause",
      releasePolicy: { strategy: "manual" },
    });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      contextSnapshot: { issueId: alreadyQueuedIssueId },
    });

    const result = await heartbeat.reconcileIdleActiveIssues({
      now,
      idleThresholdMs: 10 * 60 * 1000,
      maxPerTick: 10,
    });

    expect(result.enqueued).toBe(0);
    const idleWakeCount = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.reason, "idle_active_issue_reconcile"))
      .then((rows) => rows[0]?.count ?? 0);
    expect(idleWakeCount).toBe(0);
  });

  it("enforces idle active reconciler caps", async () => {
    const { companyId, projectId, agentId } = await insertCompanyProjectAgent(db, { maxConcurrentRuns: 10 });
    const issueIds = Array.from({ length: 3 }, () => randomUUID());
    const oldUpdatedAt = new Date("2026-04-24T09:00:00.000Z");

    await db.insert(issues).values(
      issueIds.map((id, index) => ({
        id,
        companyId,
        projectId,
        title: `Idle issue ${index + 1}`,
        status: "todo" as const,
        priority: "medium" as const,
        assigneeAgentId: agentId,
        updatedAt: oldUpdatedAt,
      })),
    );

    const result = await heartbeat.reconcileIdleActiveIssues({
      now: new Date("2026-04-24T09:20:00.000Z"),
      idleThresholdMs: 10 * 60 * 1000,
      maxPerTick: 10,
      maxPerAgentPerTick: 1,
    });

    expect(result.enqueued).toBe(1);
    expect(result.issueIds).toHaveLength(1);
  });
});
