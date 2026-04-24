import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentProjectScopes,
  agents,
  companies,
  createDb,
  issueComments,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";
import {
  __resetStalledReviewSweepState,
  runStalledReviewSweep,
} from "../services/stalled-review-sweep.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres stalled-review-sweep tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

interface WakeCall {
  agentId: string;
  reason: string | null | undefined;
  payload: Record<string, unknown> | null | undefined;
  requestedByActorType: "user" | "agent" | "system" | undefined;
  contextSnapshot: Record<string, unknown> | undefined;
}

function createFakeHeartbeat() {
  const calls: WakeCall[] = [];
  return {
    calls,
    wakeup: async (
      agentId: string,
      opts: {
        source?: string;
        triggerDetail?: string;
        reason?: string | null;
        payload?: Record<string, unknown> | null;
        requestedByActorType?: "user" | "agent" | "system";
        requestedByActorId?: string | null;
        contextSnapshot?: Record<string, unknown>;
      },
    ) => {
      calls.push({
        agentId,
        reason: opts.reason,
        payload: opts.payload,
        requestedByActorType: opts.requestedByActorType,
        contextSnapshot: opts.contextSnapshot,
      });
      return null;
    },
  };
}

describeEmbeddedPostgres("runStalledReviewSweep", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stalled-review-sweep-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    __resetStalledReviewSweepState();
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(agentProjectScopes);
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
      name: "Project",
      status: "in_progress",
    });
    return projectId;
  }

  async function seedAgent(
    companyId: string,
    overrides: Partial<typeof agents.$inferInsert> & { archetypeKey?: string } = {},
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
      reportsTo: overrides.reportsTo ?? null,
      createdAt: overrides.createdAt ?? new Date(),
    });
    return agentId;
  }

  async function seedProjectLead(companyId: string, projectId: string, archetype = "project_lead") {
    const leadId = await seedAgent(companyId, {
      name: "Project Lead",
      role: "project_manager",
      archetypeKey: archetype,
    });
    await db.insert(agentProjectScopes).values({
      companyId,
      agentId: leadId,
      projectId,
      scopeMode: "leadership_raw",
      projectRole: "project_lead",
      isPrimary: true,
    });
    return leadId;
  }

  async function seedStaleInReviewIssue(input: {
    companyId: string;
    projectId: string;
    assigneeAgentId: string | null;
    now: Date;
    idleHours: number;
    executionState?: Record<string, unknown> | null;
    checkoutRunId?: string | null;
  }) {
    const issueId = randomUUID();
    const staleAt = new Date(input.now.getTime() - input.idleHours * 3_600_000);
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      projectId: input.projectId,
      title: "Stale issue",
      status: "in_review",
      priority: "high",
      assigneeAgentId: input.assigneeAgentId,
      executionState: input.executionState ?? null,
    });
    // Backdate updatedAt so the sweep sees the issue as stale.
    await db.update(issues).set({ updatedAt: staleAt }).where(eq(issues.id, issueId));
    return issueId;
  }

  function buildDeps(heartbeat: ReturnType<typeof createFakeHeartbeat>) {
    return {
      heartbeat,
      issueService: issueService(db),
    };
  }

  it("Action B — re-wakes the existing assignee on the primary path", async () => {
    const companyId = await seedCompany();
    const projectId = await seedProject(companyId);
    const reviewerId = await seedAgent(companyId, { name: "QA-Reviewer" });
    await seedProjectLead(companyId, projectId);

    const now = new Date("2026-05-01T12:00:00Z");
    const issueId = await seedStaleInReviewIssue({
      companyId,
      projectId,
      assigneeAgentId: reviewerId,
      now,
      idleHours: 25,
    });

    const heartbeat = createFakeHeartbeat();
    const result = await runStalledReviewSweep(db, buildDeps(heartbeat), {
      now,
      force: true,
    });

    expect(result.scanned).toBe(1);
    expect(result.acted).toBe(1);
    expect(result.rewokenAssignee).toBe(1);
    expect(result.escalated).toBe(0);

    expect(heartbeat.calls).toHaveLength(1);
    expect(heartbeat.calls[0]).toMatchObject({
      agentId: reviewerId,
      reason: "review_stalled",
      requestedByActorType: "system",
    });

    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0].authorAgentId).toBeNull();
    expect(comments[0].authorUserId).toBeNull();
    expect(comments[0].body).toContain("Stalled-review sweep");
    expect(comments[0].body).toContain("re-woke");

    const logs = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, "issue.stalled_review_swept")));
    expect(logs).toHaveLength(1);
    expect(logs[0].actorType).toBe("system");
    expect(logs[0].actorId).toBe("stalled-review-sweep");
    expect((logs[0].details as Record<string, unknown>).decision).toBe("rewake_assignee");
    expect((logs[0].details as Record<string, unknown>).reviewerAgentId).toBe(reviewerId);

    const refetched = await db.select().from(issues).where(eq(issues.id, issueId));
    // Post-comment status stays in_review (PL nit 4 — defends against implicit-reopen).
    expect(refetched[0].status).toBe("in_review");
    expect(refetched[0].assigneeAgentId).toBe(reviewerId);
  });

  it("Action A — re-wakes execution-policy participant when distinct from assignee", async () => {
    const companyId = await seedCompany();
    const projectId = await seedProject(companyId);
    const assigneeId = await seedAgent(companyId, { name: "Assignee-QA" });
    const participantId = await seedAgent(companyId, { name: "Participant-QA" });
    await seedProjectLead(companyId, projectId);

    const now = new Date("2026-05-01T12:00:00Z");
    const issueId = await seedStaleInReviewIssue({
      companyId,
      projectId,
      assigneeAgentId: null, // simulate policy-only routing (no row-level assignee)
      now,
      idleHours: 30,
      executionState: {
        status: "pending",
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: participantId },
      },
    });

    const heartbeat = createFakeHeartbeat();
    const result = await runStalledReviewSweep(db, buildDeps(heartbeat), {
      now,
      force: true,
    });

    expect(result.rewokenParticipant).toBe(1);
    expect(result.rewokenAssignee).toBe(0);
    expect(heartbeat.calls).toHaveLength(1);
    expect(heartbeat.calls[0].agentId).toBe(participantId);

    const logs = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId));
    expect((logs[0].details as Record<string, unknown>).decision).toBe("rewake_participant");

    // participant rewake does not reassign.
    const refetched = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(refetched[0].assigneeAgentId).toBeNull();
    // Prevent regression: unused variable lint for participantId.
    expect(assigneeId).not.toBe(participantId);
  });

  it("Action C — escalates to the project lead and clears lock columns on reassignment", async () => {
    const companyId = await seedCompany();
    const projectId = await seedProject(companyId);
    const projectLeadId = await seedProjectLead(companyId, projectId);
    // Assignee is terminated — no eligible reviewer, no currentParticipant, so sweep escalates.
    const originalAssigneeId = await seedAgent(companyId, {
      name: "Terminated-QA",
      status: "terminated",
    });

    const now = new Date("2026-05-01T12:00:00Z");
    const issueId = await seedStaleInReviewIssue({
      companyId,
      projectId,
      assigneeAgentId: originalAssigneeId,
      now,
      idleHours: 40,
    });

    // Populate the execution lock columns so we can assert they clear on reassignment.
    await db
      .update(issues)
      .set({
        executionAgentNameKey: "terminated-qa",
        executionLockedAt: new Date(now.getTime() - 36 * 3_600_000),
      })
      .where(eq(issues.id, issueId));

    const heartbeat = createFakeHeartbeat();
    const result = await runStalledReviewSweep(db, buildDeps(heartbeat), {
      now,
      force: true,
    });

    expect(result.escalated).toBe(1);
    expect(heartbeat.calls).toHaveLength(1);
    expect(heartbeat.calls[0].agentId).toBe(projectLeadId);

    const refetched = await db.select().from(issues).where(eq(issues.id, issueId));
    const row = refetched[0];
    expect(row.status).toBe("in_review");
    expect(row.assigneeAgentId).toBe(projectLeadId);
    // State hygiene on reassignment — PL material item 2.
    expect(row.checkoutRunId).toBeNull();
    expect(row.executionRunId).toBeNull();
    expect(row.executionAgentNameKey).toBeNull();
    expect(row.executionLockedAt).toBeNull();

    const logs = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId));
    expect(logs).toHaveLength(1);
    const details = logs[0].details as Record<string, unknown>;
    expect(details.decision).toBe("escalate");
    expect(details.escalationTargetAgentId).toBe(projectLeadId);
    expect(details.escalationSource).toBe("project_lead");
    expect(details.previousAssigneeAgentId).toBe(originalAssigneeId);
  });

  it("falls back to reports_to when the project has no project lead", async () => {
    const companyId = await seedCompany();
    const projectId = await seedProject(companyId);
    const managerId = await seedAgent(companyId, {
      name: "Manager",
      role: "engineering_manager",
      archetypeKey: "general",
    });
    const assigneeId = await seedAgent(companyId, {
      name: "Terminated-Reviewer",
      status: "terminated",
      reportsTo: managerId,
    });

    const now = new Date("2026-05-01T12:00:00Z");
    const issueId = await seedStaleInReviewIssue({
      companyId,
      projectId,
      assigneeAgentId: assigneeId,
      now,
      idleHours: 48,
    });

    const heartbeat = createFakeHeartbeat();
    const result = await runStalledReviewSweep(db, buildDeps(heartbeat), {
      now,
      force: true,
    });

    expect(result.escalated).toBe(1);
    expect(heartbeat.calls[0].agentId).toBe(managerId);
    const logs = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId));
    expect((logs[0].details as Record<string, unknown>).escalationSource).toBe("reports_to");
  });

  it("falls back to office operator when no project lead and no reports_to", async () => {
    const companyId = await seedCompany();
    const projectId = await seedProject(companyId);
    const officeOperatorId = await seedAgent(companyId, {
      name: "Chief of Staff",
      role: "coo",
      archetypeKey: "chief_of_staff",
    });
    // Assignee is terminated with no manager set.
    const assigneeId = await seedAgent(companyId, {
      name: "Stranded-QA",
      status: "terminated",
    });

    const now = new Date("2026-05-01T12:00:00Z");
    const issueId = await seedStaleInReviewIssue({
      companyId,
      projectId,
      assigneeAgentId: assigneeId,
      now,
      idleHours: 50,
    });

    const heartbeat = createFakeHeartbeat();
    const result = await runStalledReviewSweep(db, buildDeps(heartbeat), {
      now,
      force: true,
    });

    expect(result.escalated).toBe(1);
    expect(heartbeat.calls[0].agentId).toBe(officeOperatorId);
    const logs = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId));
    expect((logs[0].details as Record<string, unknown>).escalationSource).toBe("office_operator");
  });

  it("rate caps subsequent sweeps within the 24h window", async () => {
    const companyId = await seedCompany();
    const projectId = await seedProject(companyId);
    const reviewerId = await seedAgent(companyId, { name: "Reviewer" });
    await seedProjectLead(companyId, projectId);

    const now = new Date("2026-05-01T12:00:00Z");
    const issueId = await seedStaleInReviewIssue({
      companyId,
      projectId,
      assigneeAgentId: reviewerId,
      now,
      idleHours: 25,
    });

    // Pre-insert two prior sweep rows within the 24h window relative to `now`.
    for (let i = 0; i < 2; i += 1) {
      await db.insert(activityLog).values({
        companyId,
        actorType: "system",
        actorId: "stalled-review-sweep",
        action: "issue.stalled_review_swept",
        entityType: "issue",
        entityId: issueId,
        details: { decision: "rewake_assignee", previous: i },
        createdAt: new Date(now.getTime() - (i + 1) * 3_600_000),
      });
    }

    const heartbeat = createFakeHeartbeat();
    const result = await runStalledReviewSweep(db, buildDeps(heartbeat), {
      now,
      force: true,
      maxWakesPerDay: 2,
    });

    expect(result.scanned).toBe(1);
    expect(result.acted).toBe(0);
    expect(result.skippedRateCap).toBe(1);
    expect(heartbeat.calls).toHaveLength(0);
    // No new comment should have been posted.
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);
    // But an audit row is written so the skip is observable.
    const logs = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId));
    const skipLog = logs.find(
      (row) => (row.details as Record<string, unknown>).decision === "skipped_rate_cap",
    );
    expect(skipLog).toBeDefined();
  });

  it("writes a no_target audit row when no reviewer and no escalation target exist", async () => {
    const companyId = await seedCompany();
    const projectId = await seedProject(companyId);

    const now = new Date("2026-05-01T12:00:00Z");
    const issueId = await seedStaleInReviewIssue({
      companyId,
      projectId,
      assigneeAgentId: null,
      now,
      idleHours: 30,
    });

    const heartbeat = createFakeHeartbeat();
    const result = await runStalledReviewSweep(db, buildDeps(heartbeat), {
      now,
      force: true,
    });

    expect(result.scanned).toBe(1);
    expect(result.acted).toBe(0);
    expect(result.skippedNoTarget).toBe(1);
    expect(heartbeat.calls).toHaveLength(0);
    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);
    const logs = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId));
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe("issue.stalled_review_sweep_no_target");
  });

  it("skips fresh in_review issues below the threshold", async () => {
    const companyId = await seedCompany();
    const projectId = await seedProject(companyId);
    const reviewerId = await seedAgent(companyId, { name: "Reviewer" });

    const now = new Date("2026-05-01T12:00:00Z");
    await seedStaleInReviewIssue({
      companyId,
      projectId,
      assigneeAgentId: reviewerId,
      now,
      idleHours: 5, // within threshold
    });

    const heartbeat = createFakeHeartbeat();
    const result = await runStalledReviewSweep(db, buildDeps(heartbeat), {
      now,
      force: true,
      thresholdHours: 24,
    });

    expect(result.scanned).toBe(0);
    expect(heartbeat.calls).toHaveLength(0);
  });

  it("respects the enabled flag and the intra-run throttle", async () => {
    const companyId = await seedCompany();
    const projectId = await seedProject(companyId);
    const reviewerId = await seedAgent(companyId, { name: "Reviewer" });
    await seedProjectLead(companyId, projectId);

    const now = new Date("2026-05-01T12:00:00Z");
    await seedStaleInReviewIssue({
      companyId,
      projectId,
      assigneeAgentId: reviewerId,
      now,
      idleHours: 30,
    });

    // enabled: false short-circuits entirely.
    const disabledResult = await runStalledReviewSweep(
      db,
      buildDeps(createFakeHeartbeat()),
      { now, enabled: false, force: true },
    );
    expect(disabledResult.scanned).toBe(0);

    // First real sweep executes.
    const firstHeartbeat = createFakeHeartbeat();
    const first = await runStalledReviewSweep(db, buildDeps(firstHeartbeat), {
      now,
      force: true,
      intervalMinutes: 60,
    });
    expect(first.acted).toBe(1);

    // Second sweep 5 minutes later is throttled.
    const secondHeartbeat = createFakeHeartbeat();
    const soonNow = new Date(now.getTime() + 5 * 60_000);
    const throttled = await runStalledReviewSweep(db, buildDeps(secondHeartbeat), {
      now: soonNow,
      intervalMinutes: 60,
    });
    expect(throttled.skippedThrottled).toBe(true);
    expect(throttled.scanned).toBe(0);
    expect(secondHeartbeat.calls).toHaveLength(0);
  });
});
