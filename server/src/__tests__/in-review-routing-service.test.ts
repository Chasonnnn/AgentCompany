import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { buildAutoRouteComment, selectLeastLoadedQaReviewer } from "../services/in-review-routing.js";

// AIW-151: lock the reviewer close-out guidance line into the auto-route
// comment contract. The line is what prevents QA heartbeats from falling
// back to the comment-only reviewer-no-checkout rule when the auto-route has
// already made them the assignee.
describe("buildAutoRouteComment", () => {
  it("includes reviewer close-out guidance for auto-routed comments", () => {
    const body = buildAutoRouteComment({
      executor: { id: "exec-1", name: "Executor" },
      reviewer: { id: "rev-1", name: "QA-A" },
      routedBy: "auto",
    });
    expect(body).toContain("[@Executor](agent://exec-1)");
    expect(body).toContain("[@QA-A](agent://rev-1)");
    expect(body).toContain("PATCH status=done");
    expect(body).toContain("PATCH status=in_progress");
    expect(body).toContain("reassigning to the executor");
    expect(body).toContain("Do NOT /checkout");
    expect(body).toContain("/release");
  });

  it("includes reviewer close-out guidance for explicit-reviewer comments", () => {
    const body = buildAutoRouteComment({
      executor: null,
      reviewer: { id: "rev-1", name: "QA-A" },
      routedBy: "explicit",
    });
    expect(body).toContain("[@QA-A](agent://rev-1)");
    expect(body).toContain("PATCH status=done");
    expect(body).toContain("PATCH status=in_progress");
  });

  it("falls back to a placeholder executor mention when the executor is null", () => {
    const body = buildAutoRouteComment({
      executor: null,
      reviewer: { id: "rev-1", name: "QA-A" },
      routedBy: "auto",
    });
    expect(body).toContain("unknown executor");
    expect(body).toContain("PATCH status=done");
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres in_review routing helper tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("selectLeastLoadedQaReviewer", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-in-review-routing-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedProject(companyId: string) {
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "QA Project",
      status: "in_progress",
    });
    return projectId;
  }

  async function seedAgent(
    companyId: string,
    overrides: Partial<typeof agents.$inferInsert> & { archetypeKey?: string },
  ) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: overrides.name ?? "Agent",
      role: overrides.role ?? "qa",
      status: overrides.status ?? "active",
      adapterType: overrides.adapterType ?? "codex_local",
      adapterConfig: overrides.adapterConfig ?? {},
      runtimeConfig: overrides.runtimeConfig ?? {},
      permissions: overrides.permissions ?? {},
      orgLevel: overrides.orgLevel ?? "staff",
      operatingClass: overrides.operatingClass ?? "worker",
      capabilityProfileKey: overrides.capabilityProfileKey ?? "worker",
      archetypeKey: overrides.archetypeKey ?? "qa_evals_continuity_owner",
      departmentKey: overrides.departmentKey ?? "engineering",
      createdAt: overrides.createdAt ?? new Date(),
    });
    return agentId;
  }

  async function seedOpenIssues(
    companyId: string,
    projectId: string,
    assigneeAgentId: string,
    count: number,
  ) {
    if (count === 0) return;
    const rows = Array.from({ length: count }, () => ({
      id: randomUUID(),
      companyId,
      projectId,
      title: "Open issue",
      status: "in_progress" as const,
      priority: "medium" as const,
      assigneeAgentId,
    }));
    await db.insert(issues).values(rows);
  }

  it("picks the least-loaded QA with createdAt tiebreak", async () => {
    const companyId = await seedCompany();
    const projectId = await seedProject(companyId);

    const qaA = await seedAgent(companyId, { name: "QA-A", createdAt: new Date("2026-01-01") });
    const qaB = await seedAgent(companyId, { name: "QA-B", createdAt: new Date("2026-02-01") });
    const qaC = await seedAgent(companyId, { name: "QA-C", createdAt: new Date("2026-01-15") });

    await seedOpenIssues(companyId, projectId, qaA, 5);
    await seedOpenIssues(companyId, projectId, qaB, 3);
    await seedOpenIssues(companyId, projectId, qaC, 3);

    const { reviewer, candidateCount } = await selectLeastLoadedQaReviewer(db, { companyId });
    expect(candidateCount).toBe(3);
    expect(reviewer?.id).toBe(qaC);
    expect(reviewer?.openIssueCount).toBe(3);
  });

  it("excludes the executor from the candidate pool", async () => {
    const companyId = await seedCompany();
    const projectId = await seedProject(companyId);

    const executorQa = await seedAgent(companyId, { name: "Executor-QA", createdAt: new Date("2026-01-01") });
    const otherQa = await seedAgent(companyId, { name: "Other-QA", createdAt: new Date("2026-02-01") });
    await seedOpenIssues(companyId, projectId, executorQa, 0);
    await seedOpenIssues(companyId, projectId, otherQa, 4);

    const { reviewer, candidateCount } = await selectLeastLoadedQaReviewer(db, {
      companyId,
      excludeAgentId: executorQa,
    });
    expect(candidateCount).toBe(1);
    expect(reviewer?.id).toBe(otherQa);
  });

  it("returns null when no QA agent is eligible", async () => {
    const companyId = await seedCompany();
    const result = await selectLeastLoadedQaReviewer(db, { companyId });
    expect(result).toEqual({ reviewer: null, candidateCount: 0 });
  });

  it("skips terminated QA agents", async () => {
    const companyId = await seedCompany();
    await seedAgent(companyId, { name: "Terminated-QA", status: "terminated" });
    const liveQa = await seedAgent(companyId, { name: "Live-QA" });
    const { reviewer, candidateCount } = await selectLeastLoadedQaReviewer(db, { companyId });
    expect(candidateCount).toBe(1);
    expect(reviewer?.id).toBe(liveQa);
  });

  // AIW-137 review finding F-PM2: pending_approval agents were previously
  // eligible for auto-routing. `assertAssignableAgent()` would then reject the
  // transition with 409, failing the whole `status: in_review` move even when
  // active QA reviewers were available with higher load.
  it("skips pending_approval QA agents even when they have the lowest load", async () => {
    const companyId = await seedCompany();
    const projectId = await seedProject(companyId);

    const pending = await seedAgent(companyId, {
      name: "Pending-QA",
      status: "pending_approval",
      createdAt: new Date("2026-01-01"),
    });
    const active = await seedAgent(companyId, {
      name: "Active-QA",
      status: "active",
      createdAt: new Date("2026-02-01"),
    });
    const terminated = await seedAgent(companyId, {
      name: "Terminated-QA",
      status: "terminated",
      createdAt: new Date("2026-01-15"),
    });

    // Lowest-load candidate is the pending_approval one; the active one is
    // loaded. The filter must still return the active reviewer.
    await seedOpenIssues(companyId, projectId, pending, 2);
    await seedOpenIssues(companyId, projectId, active, 5);
    await seedOpenIssues(companyId, projectId, terminated, 0);

    const { reviewer, candidateCount } = await selectLeastLoadedQaReviewer(db, { companyId });
    expect(candidateCount).toBe(1);
    expect(reviewer?.id).toBe(active);
    expect(reviewer?.openIssueCount).toBe(5);
  });

  it("ignores non-open statuses when counting load", async () => {
    const companyId = await seedCompany();
    const projectId = await seedProject(companyId);

    const qaLoaded = await seedAgent(companyId, { name: "Loaded-QA", createdAt: new Date("2026-01-01") });
    const qaIdle = await seedAgent(companyId, { name: "Idle-QA", createdAt: new Date("2026-02-01") });
    await seedOpenIssues(companyId, projectId, qaLoaded, 2);
    await db.insert(issues).values([
      { id: randomUUID(), companyId, projectId, title: "done", status: "done", priority: "low", assigneeAgentId: qaIdle },
      { id: randomUUID(), companyId, projectId, title: "cancelled", status: "cancelled", priority: "low", assigneeAgentId: qaIdle },
      { id: randomUUID(), companyId, projectId, title: "backlog", status: "backlog", priority: "low", assigneeAgentId: qaIdle },
    ]);

    const { reviewer } = await selectLeastLoadedQaReviewer(db, { companyId });
    expect(reviewer?.id).toBe(qaIdle);
    expect(reviewer?.openIssueCount).toBe(0);
  });

  it("excludes non-QA archetypes", async () => {
    const companyId = await seedCompany();
    await seedAgent(companyId, { name: "Engineer", archetypeKey: "general", role: "engineer" });
    const qa = await seedAgent(companyId, { name: "QA" });
    const { reviewer, candidateCount } = await selectLeastLoadedQaReviewer(db, { companyId });
    expect(candidateCount).toBe(1);
    expect(reviewer?.id).toBe(qa);
  });
});
