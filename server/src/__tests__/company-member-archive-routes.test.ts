import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  instanceUserRoles,
  issues,
  projects,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres company member archive route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("company member archive routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let ownerUserId!: string;
  let ownerMemberId!: string;
  let adminUserId!: string;
  let adminMemberId!: string;
  let operatorUserId!: string;
  let operatorMemberId!: string;
  let archivedUserId!: string;
  let archivedMemberId!: string;
  let agentId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-member-archive-route-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(async () => {
    companyId = randomUUID();
    ownerUserId = randomUUID();
    ownerMemberId = randomUUID();
    adminUserId = randomUUID();
    adminMemberId = randomUUID();
    operatorUserId = randomUUID();
    operatorMemberId = randomUUID();
    archivedUserId = randomUUID();
    archivedMemberId = randomUUID();
    agentId = randomUUID();
    const now = new Date();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `A${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(authUsers).values([
      {
        id: ownerUserId,
        name: "Owner User",
        email: "owner@example.com",
        emailVerified: true,
        image: null,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: adminUserId,
        name: "Admin User",
        email: "admin@example.com",
        emailVerified: true,
        image: null,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: operatorUserId,
        name: "Operator User",
        email: "operator@example.com",
        emailVerified: true,
        image: null,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: archivedUserId,
        name: "Former User",
        email: "former@example.com",
        emailVerified: true,
        image: null,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.insert(companyMemberships).values([
      {
        id: ownerMemberId,
        companyId,
        principalType: "user",
        principalId: ownerUserId,
        status: "active",
        membershipRole: "owner",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: adminMemberId,
        companyId,
        principalType: "user",
        principalId: adminUserId,
        status: "active",
        membershipRole: "admin",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: operatorMemberId,
        companyId,
        principalType: "user",
        principalId: operatorUserId,
        status: "active",
        membershipRole: "operator",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: archivedMemberId,
        companyId,
        principalType: "user",
        principalId: archivedUserId,
        status: "archived",
        membershipRole: "viewer",
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Reassignment Agent",
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
      status: "idle",
    });
    await db.insert(principalPermissionGrants).values({
      companyId,
      principalType: "user",
      principalId: operatorUserId,
      permissionKey: "tasks:assign",
      scope: null,
      grantedByUserId: ownerUserId,
      createdAt: now,
      updatedAt: now,
    });
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(principalPermissionGrants);
    await db.delete(instanceUserRoles);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(authUsers);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createApp(actorUserId: string) {
    const [{ errorHandler }, { accessRoutes }] = await Promise.all([
      import("../middleware/index.js"),
      import("../routes/access.js"),
    ]);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        source: "local_implicit",
        userId: actorUserId,
        companyIds: [companyId],
        memberships: [{ companyId, status: "active", membershipRole: "owner" }],
      };
      next();
    });
    app.use(
      "/api",
      accessRoutes(db, {
        deploymentMode: "local_trusted",
        deploymentExposure: "private",
        bindHost: "127.0.0.1",
        allowedHostnames: [],
      }),
    );
    app.use(errorHandler);
    return app;
  }

  it("omits archived members from the default list and returns archive diagnostics", async () => {
    const response = await request(await createApp(ownerUserId)).get(`/api/companies/${companyId}/members`);

    expect(response.status).toBe(200);
    expect(response.body.members).toHaveLength(3);
    expect(response.body.members.find((member: { id: string }) => member.id === archivedMemberId)).toBeUndefined();
    expect(response.body.members.find((member: { id: string }) => member.id === ownerMemberId)?.removal).toEqual({
      canArchive: false,
      reason: "You cannot remove yourself.",
    });
    expect(response.body.members.find((member: { id: string }) => member.id === adminMemberId)?.removal).toEqual({
      canArchive: false,
      reason: "Company admins cannot be removed from company access.",
    });
    expect(response.body.members.find((member: { id: string }) => member.id === operatorMemberId)?.removal).toEqual({
      canArchive: true,
      reason: null,
    });
  });

  it("archives a member and reassigns open issues", async () => {
    const inProgressIssueId = randomUUID();
    const queuedIssueId = randomUUID();
    const projectId = randomUUID();
    const now = new Date();

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Archive routing",
      status: "in_progress",
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(issues).values([
      {
        id: inProgressIssueId,
        companyId,
        projectId,
        title: "In-progress work",
        status: "in_progress",
        priority: "high",
        assigneeUserId: operatorUserId,
        createdByUserId: ownerUserId,
        identifier: "ARC-1",
        startedAt: now,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: queuedIssueId,
        companyId,
        projectId,
        title: "Queued work",
        status: "todo",
        priority: "medium",
        assigneeUserId: operatorUserId,
        createdByUserId: ownerUserId,
        identifier: "ARC-2",
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const response = await request(await createApp(ownerUserId))
      .post(`/api/companies/${companyId}/members/${operatorMemberId}/archive`)
      .send({
        reassignment: { assigneeAgentId: agentId },
      });

    expect(response.status).toBe(200);
    expect(response.body.reassignedIssueCount).toBe(2);
    expect(response.body.member.id).toBe(operatorMemberId);
    expect(response.body.member.status).toBe("archived");

    const updatedIssues = await db
      .select({
        id: issues.id,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.companyId, companyId))
      .orderBy(issues.identifier);

    expect(updatedIssues).toEqual([
      {
        id: inProgressIssueId,
        status: "todo",
        assigneeAgentId: agentId,
        assigneeUserId: null,
        checkoutRunId: null,
        executionRunId: null,
        executionLockedAt: null,
      },
      {
        id: queuedIssueId,
        status: "todo",
        assigneeAgentId: agentId,
        assigneeUserId: null,
        checkoutRunId: null,
        executionRunId: null,
        executionLockedAt: null,
      },
    ]);

    const archivedMembership = await db
      .select({
        id: companyMemberships.id,
        status: companyMemberships.status,
      })
      .from(companyMemberships)
      .where(eq(companyMemberships.id, operatorMemberId));

    expect(archivedMembership).toEqual([
      {
        id: operatorMemberId,
        status: "archived",
      },
    ]);
  });

  it("blocks self-removal", async () => {
    const response = await request(await createApp(ownerUserId))
      .post(`/api/companies/${companyId}/members/${ownerMemberId}/archive`)
      .send({});

    expect(response.status).toBe(403);
    expect(response.body.error).toContain("You cannot remove yourself.");
  });

  it("blocks instance-admin removal and surfaces the reason", async () => {
    await db.insert(instanceUserRoles).values({
      userId: operatorUserId,
      role: "instance_admin",
    });

    const listResponse = await request(await createApp(ownerUserId)).get(`/api/companies/${companyId}/members`);
    expect(listResponse.status).toBe(200);
    expect(listResponse.body.members.find((member: { id: string }) => member.id === operatorMemberId)?.removal).toEqual({
      canArchive: false,
      reason: "Instance admins cannot be removed from company access.",
    });

    const archiveResponse = await request(await createApp(ownerUserId))
      .post(`/api/companies/${companyId}/members/${operatorMemberId}/archive`)
      .send({});
    expect(archiveResponse.status).toBe(403);
    expect(archiveResponse.body.error).toContain("Instance admins cannot be removed from company access.");
  });
});
