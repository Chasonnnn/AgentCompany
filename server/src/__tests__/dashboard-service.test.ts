import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueRelations,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { dashboardService } from "../services/dashboard.ts";
import { issueService } from "../services/issues.ts";

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

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres dashboard service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function utcDay(offsetDays: number): Date {
  const now = new Date();
  const day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offsetDays, 12);
  return new Date(day);
}

function utcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

describeEmbeddedPostgres("dashboard service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-dashboard-service-");
    db = createDb(tempDb.connectionString);
    await ensureIssueRelationsTable(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("aggregates the full 14-day run activity window without recent-run truncation", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    const today = utcDay(0);
    const weekAgo = utcDay(-7);

    await db.insert(companies).values([
      {
        id: companyId,
        name: "Paperclip",
        issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherCompanyId,
        name: "Other",
        issuePrefix: `T${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);

    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: "CodexCoder",
        role: "engineer",
        status: "running",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId: otherCompanyId,
        name: "OtherAgent",
        role: "engineer",
        status: "running",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(heartbeatRuns).values([
      ...Array.from({ length: 105 }, () => ({
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "succeeded" as const,
        createdAt: today,
      })),
      {
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "failed" as const,
        createdAt: weekAgo,
      },
      {
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "timed_out" as const,
        createdAt: weekAgo,
      },
      {
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "cancelled" as const,
        createdAt: weekAgo,
      },
      {
        id: randomUUID(),
        companyId: otherCompanyId,
        agentId: otherAgentId,
        invocationSource: "assignment",
        status: "succeeded" as const,
        createdAt: weekAgo,
      },
    ]);

    const summary = await dashboardService(db).summary(companyId);

    expect(summary.runActivity).toHaveLength(14);
    const todayBucket = summary.runActivity.find((bucket) => bucket.date === utcDateKey(today));
    const weekAgoBucket = summary.runActivity.find((bucket) => bucket.date === utcDateKey(weekAgo));

    expect(todayBucket).toMatchObject({
      succeeded: 105,
      failed: 0,
      other: 0,
      total: 105,
    });
    expect(weekAgoBucket).toMatchObject({
      succeeded: 0,
      failed: 2,
      other: 1,
      total: 3,
    });
  });

  it("sorts dependency-blocked waitingOn by dependentCount, then openChildCount, then identifier", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "WaitingOn sort",
      status: "in_progress",
    });
    const assigneeAgentId = randomUUID();
    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    // Three blockers with identifiers in alphabetical order so the primary-blocker
    // selection is deterministic regardless of insertion order.
    const blockerAlpha = randomUUID();
    const blockerBravo = randomUUID();
    const blockerCharlie = randomUUID();
    await db.insert(issues).values([
      {
        id: blockerAlpha,
        companyId,
        projectId,
        identifier: "T-B-01",
        title: "Blocker Alpha",
        status: "todo",
        priority: "medium",
      },
      {
        id: blockerBravo,
        companyId,
        projectId,
        identifier: "T-B-02",
        title: "Blocker Bravo",
        status: "todo",
        priority: "medium",
      },
      {
        id: blockerCharlie,
        companyId,
        projectId,
        identifier: "T-B-03",
        title: "Blocker Charlie",
        status: "todo",
        priority: "medium",
      },
    ]);

    // Give blockerAlpha 3 open children and blockerBravo / blockerCharlie 1 each.
    // This lets the second sort level (openChildCount desc) kick in between Bravo/Charlie
    // only if they tie on dependentCount.
    await db.insert(issues).values([
      { id: randomUUID(), companyId, projectId, parentId: blockerAlpha, title: "Alpha child 1", status: "todo", priority: "medium" },
      { id: randomUUID(), companyId, projectId, parentId: blockerAlpha, title: "Alpha child 2", status: "todo", priority: "medium" },
      { id: randomUUID(), companyId, projectId, parentId: blockerAlpha, title: "Alpha child 3", status: "todo", priority: "medium" },
      { id: randomUUID(), companyId, projectId, parentId: blockerBravo, title: "Bravo child 1", status: "todo", priority: "medium" },
      { id: randomUUID(), companyId, projectId, parentId: blockerCharlie, title: "Charlie child 1", status: "todo", priority: "medium" },
    ]);

    // Two dependents on Alpha, one each on Bravo and Charlie. Bravo and Charlie tie
    // on dependentCount=1 and openChildCount=1, so identifier asc breaks the tie.
    const dep1 = randomUUID();
    const dep2 = randomUUID();
    const dep3 = randomUUID();
    const dep4 = randomUUID();
    await db.insert(issues).values([
      { id: dep1, companyId, projectId, assigneeAgentId, identifier: "T-D-01", title: "Dep 1", status: "blocked", priority: "medium" },
      { id: dep2, companyId, projectId, assigneeAgentId, identifier: "T-D-02", title: "Dep 2", status: "blocked", priority: "medium" },
      { id: dep3, companyId, projectId, assigneeAgentId, identifier: "T-D-03", title: "Dep 3", status: "blocked", priority: "medium" },
      { id: dep4, companyId, projectId, assigneeAgentId, identifier: "T-D-04", title: "Dep 4", status: "blocked", priority: "medium" },
    ]);
    const svc = issueService(db);
    await svc.update(dep1, { blockedByIssueIds: [blockerAlpha] });
    await svc.update(dep2, { blockedByIssueIds: [blockerAlpha] });
    await svc.update(dep3, { blockedByIssueIds: [blockerBravo] });
    await svc.update(dep4, { blockedByIssueIds: [blockerCharlie] });

    const summary = await dashboardService(db).summary(companyId);
    const dependencyBlocked = summary.tasks.computedAgentStates.find((entry) => entry.state === "dependency_blocked");
    expect(dependencyBlocked?.count).toBe(4);
    expect(dependencyBlocked?.waitingOn).toEqual([
      {
        issueId: blockerAlpha,
        identifier: "T-B-01",
        openChildCount: 3,
        dependentCount: 2,
      },
      {
        issueId: blockerBravo,
        identifier: "T-B-02",
        openChildCount: 1,
        dependentCount: 1,
      },
      {
        issueId: blockerCharlie,
        identifier: "T-B-03",
        openChildCount: 1,
        dependentCount: 1,
      },
    ]);
  });

  it("caps dependency-blocked waitingOn at 5 entries and drops the lowest-sort blocker", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "WaitingOn cap",
      status: "in_progress",
    });
    const assigneeAgentId = randomUUID();
    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    // Six blockers, each with exactly one dependent and no children. All tie on
    // dependentCount=1 and openChildCount=0, so identifier asc is the only sort
    // level that matters — the cap must drop identifier "T-C-06".
    const blockerIds = Array.from({ length: 6 }, () => randomUUID());
    await db.insert(issues).values(
      blockerIds.map((id, index) => ({
        id,
        companyId,
        projectId,
        identifier: `T-C-${String(index + 1).padStart(2, "0")}`,
        title: `Blocker ${index + 1}`,
        status: "todo" as const,
        priority: "medium" as const,
      })),
    );

    const dependentIds = Array.from({ length: 6 }, () => randomUUID());
    await db.insert(issues).values(
      dependentIds.map((id, index) => ({
        id,
        companyId,
        projectId,
        assigneeAgentId,
        identifier: `T-E-${String(index + 1).padStart(2, "0")}`,
        title: `Dep ${index + 1}`,
        status: "blocked" as const,
        priority: "medium" as const,
      })),
    );
    const svc = issueService(db);
    for (let index = 0; index < dependentIds.length; index += 1) {
      await svc.update(dependentIds[index]!, { blockedByIssueIds: [blockerIds[index]!] });
    }

    const summary = await dashboardService(db).summary(companyId);
    const dependencyBlocked = summary.tasks.computedAgentStates.find((entry) => entry.state === "dependency_blocked");
    expect(dependencyBlocked?.count).toBe(6);
    expect(dependencyBlocked?.waitingOn).toHaveLength(5);
    expect(dependencyBlocked?.waitingOn.map((entry) => entry.identifier)).toEqual([
      "T-C-01",
      "T-C-02",
      "T-C-03",
      "T-C-04",
      "T-C-05",
    ]);
    // The omitted blocker is the highest-sort loser (T-C-06), not present in the capped list.
    expect(dependencyBlocked?.waitingOn.map((entry) => entry.identifier)).not.toContain("T-C-06");
  });

  it("counts assigned active issues without active runs as idle_active", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Dashboard idle work",
      status: "in_progress",
    });
    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      projectId,
      title: "Assigned but idle",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const summary = await dashboardService(db).summary(companyId);

    expect(summary.tasks.operatorStates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: "idle_active", count: 1 }),
      ]),
    );
    expect(summary.tasks.computedAgentStates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          state: "idle",
          count: 1,
          detailedStates: expect.arrayContaining([
            expect.objectContaining({ state: "idle_active", count: 1 }),
          ]),
        }),
      ]),
    );
  });
});
