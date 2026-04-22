import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentProjectScopes,
  agents,
  companies,
  createDb,
  projects,
  sharedServiceEngagementAssignments,
  sharedServiceEngagements,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { sharedServiceEngagementService } from "../services/shared-service-engagements.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres shared-service engagement tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("sharedServiceEngagementService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-shared-service-engagements-");
    db = createDb(tempDb.connectionString);
    await db.execute(sql.raw(`ALTER TABLE shared_service_engagements ADD COLUMN IF NOT EXISTS advisor_kind text`));
    await db.execute(
      sql.raw(`ALTER TABLE shared_service_engagements ADD COLUMN IF NOT EXISTS advisor_enabled boolean NOT NULL DEFAULT false`),
    );
  }, 20_000);

  afterEach(async () => {
    await db.delete(agentProjectScopes);
    await db.delete(sharedServiceEngagementAssignments);
    await db.delete(sharedServiceEngagements);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture() {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const advisorAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Advisor Lane",
      status: "in_progress",
    });

    await db.insert(agents).values({
      id: advisorAgentId,
      companyId,
      name: "Advisor",
      role: "general",
      status: "active",
      operatingClass: "consultant",
      capabilityProfileKey: "consultant",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    return {
      advisorAgentId,
      companyId,
      projectId,
      svc: sharedServiceEngagementService(db),
    };
  }

  it("persists advisor metadata on create and update", async () => {
    const { advisorAgentId, companyId, projectId, svc } = await seedFixture();

    const created = await svc.create(
      companyId,
      {
        targetProjectId: projectId,
        serviceAreaKey: "security",
        serviceAreaLabel: "Security",
        title: "Security audit",
        summary: "Review the release candidate",
        advisorKind: "security_audit",
        advisorEnabled: true,
        assignedAgentIds: [advisorAgentId],
      },
      { actorType: "user", actorId: "board-user", agentId: null },
    );

    expect(created.advisorKind).toBe("security_audit");
    expect(created.advisorEnabled).toBe(true);
    expect(created.assignments.map((assignment) => assignment.agentId)).toEqual([advisorAgentId]);

    const updated = await svc.update(created.id, {
      advisorKind: "workspace_janitor",
      advisorEnabled: false,
    });

    expect(updated?.advisorKind).toBe("workspace_janitor");
    expect(updated?.advisorEnabled).toBe(false);

    const reloaded = await svc.getById(created.id);
    expect(reloaded?.advisorKind).toBe("workspace_janitor");
    expect(reloaded?.advisorEnabled).toBe(false);
  });

  it("lists built-in advisor engagement templates disabled by default", async () => {
    const { svc } = await seedFixture();

    const templates = svc.listAdvisorTemplates();

    expect(templates.length).toBeGreaterThan(0);
    expect(templates.every((template) => template.disabledByDefault)).toBe(true);
    expect(templates.map((template) => template.advisorKind)).toContain("security_audit");
    expect(templates.map((template) => template.advisorKind)).toContain("budget_analyst");
  });

  it("recommends the right collaboration surface for common draft shapes", async () => {
    const { svc } = await seedFixture();

    expect(
      svc.recommendSurface({
        title: "Need approval for a release exception",
        requiresGovernance: true,
      }).recommendedSurface,
    ).toBe("approval");

    expect(
      svc.recommendSurface({
        title: "Need the board to decide which option we should pick",
        blocksExecution: true,
      }).recommendedSurface,
    ).toBe("decision_question");

    expect(
      svc.recommendSurface({
        title: "Kickoff sync for the cross-functional audit",
        needsCrossFunctionalCoordination: true,
        participantAgentIds: ["agent-a", "agent-b"],
      }).recommendedSurface,
    ).toBe("conference_room");

    expect(
      svc.recommendSurface({
        title: "Quick implementation note",
        summary: "Posting a narrow follow-up on the active issue.",
      }).recommendedSurface,
    ).toBe("comment");
  });
});
