import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
const mockTrackAgentFirstHeartbeat = vi.hoisted(() => vi.fn());

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentFirstHeartbeat: mockTrackAgentFirstHeartbeat,
  };
});

import {
  BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS,
  heartbeatService,
} from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat retry tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat scheduled retry scheduling", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-retry-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.clearAllMocks();
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedRetryFixture(input?: { scheduledRetryAttempt?: number }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const projectId = randomUUID();
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    const now = new Date("2026-04-22T12:00:00.000Z");
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Retry scheduling",
      status: "in_progress",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "RetryAgent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Retry issue",
      description: "Needs another attempt",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "failed",
      requestedByActorType: "system",
      requestedByActorId: null,
      claimedAt: now,
      finishedAt: now,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      wakeupRequestId,
      error: "process lost",
      errorCode: "process_lost",
      finishedAt: now,
      retryOfRunId: null,
      scheduledRetryAttempt: input?.scheduledRetryAttempt ?? 0,
      contextSnapshot: { issueId, taskId: issueId },
    });

    await db
      .update(agentWakeupRequests)
      .set({ runId, updatedAt: now })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));

    await db
      .update(issues)
      .set({
        executionRunId: runId,
        executionLockedAt: now,
        updatedAt: now,
      })
      .where(eq(issues.id, issueId));

    return { companyId, agentId, issueId, runId, now };
  }

  it("creates a durable scheduled retry and promotes it when due", async () => {
    const { issueId, runId, now } = await seedRetryFixture();
    const svc = heartbeatService(db);

    const scheduled = await svc.scheduleBoundedRetry(runId, {
      now,
      random: () => 0.5,
      retryReason: "process_lost",
      wakeReason: "process_lost",
    });

    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;

    expect(scheduled.attempt).toBe(1);
    expect(scheduled.maxAttempts).toBe(BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS.length);
    expect(scheduled.dueAt.toISOString()).toBe(
      new Date(now.getTime() + BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS[0]).toISOString(),
    );

    const scheduledRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);

    expect(scheduledRun).toEqual(expect.objectContaining({
      status: "scheduled_retry",
      retryOfRunId: runId,
      scheduledRetryAttempt: 1,
      scheduledRetryReason: "process_lost",
    }));

    const scheduledWake = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, scheduled.run.wakeupRequestId!))
      .then((rows) => rows[0] ?? null);

    expect(scheduledWake).toEqual(expect.objectContaining({
      source: "automation",
      reason: "process_lost",
      status: "queued",
      runId: scheduled.run.id,
    }));
    expect(scheduledWake?.payload).toEqual(expect.objectContaining({
      issueId,
      retryOfRunId: runId,
      retryReason: "process_lost",
      scheduledRetryAttempt: 1,
      scheduledRetryAt: scheduled.dueAt.toISOString(),
    }));

    const issueAfterSchedule = await db
      .select({
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issueAfterSchedule?.executionRunId).toBe(scheduled.run.id);

    const beforeDue = await svc.promoteDueScheduledRetries(new Date(scheduled.dueAt.getTime() - 1_000));
    expect(beforeDue).toEqual({ promoted: 0, runIds: [] });

    const promoted = await svc.promoteDueScheduledRetries(scheduled.dueAt);
    expect(promoted).toEqual({ promoted: 1, runIds: [scheduled.run.id] });

    const promotedRun = await db
      .select({
        status: heartbeatRuns.status,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);
    expect(promotedRun?.status).toBe("queued");
  });

  it("records retry exhaustion without queuing another automatic run", async () => {
    const { runId } = await seedRetryFixture({
      scheduledRetryAttempt: BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS.length,
    });
    const svc = heartbeatService(db);

    const exhausted = await svc.scheduleBoundedRetry(runId, {
      now: new Date("2026-04-22T12:00:00.000Z"),
      random: () => 0.5,
    });

    expect(exhausted).toEqual({
      outcome: "retry_exhausted",
      attempt: BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS.length + 1,
      maxAttempts: BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS.length,
    });

    const retryRuns = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.retryOfRunId, runId), eq(heartbeatRuns.status, "scheduled_retry")));
    expect(retryRuns).toHaveLength(0);

    const exhaustionEvent = await db
      .select({
        message: heartbeatRunEvents.message,
      })
      .from(heartbeatRunEvents)
      .where(and(eq(heartbeatRunEvents.runId, runId), eq(heartbeatRunEvents.eventType, "lifecycle")))
      .orderBy(desc(heartbeatRunEvents.id))
      .then((rows) => rows.find((row) => row.message?.startsWith("Bounded retry exhausted")) ?? null);

    expect(exhaustionEvent?.message).toContain("Bounded retry exhausted");
  });
});
