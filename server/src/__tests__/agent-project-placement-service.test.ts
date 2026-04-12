import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentProjectScopes,
  agents,
  companies,
  createDb,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentProjectPlacementService } from "../services/agent-project-placements.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent project placement tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agentProjectPlacementService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let svc!: ReturnType<typeof agentProjectPlacementService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-project-placement-");
    db = createDb(tempDb.connectionString);
    svc = agentProjectPlacementService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agentProjectScopes);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndProject() {
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
      name: "Onboarding",
      status: "active",
      color: "blue",
    });

    return { companyId, projectId };
  }

  async function seedAgent(
    companyId: string,
    overrides: Partial<typeof agents.$inferInsert> = {},
  ) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: overrides.name ?? "Agent",
      role: overrides.role ?? "engineer",
      status: overrides.status ?? "active",
      adapterType: overrides.adapterType ?? "codex_local",
      adapterConfig: overrides.adapterConfig ?? {},
      runtimeConfig: overrides.runtimeConfig ?? {},
      permissions: overrides.permissions ?? {},
      orgLevel: overrides.orgLevel ?? "staff",
      operatingClass: overrides.operatingClass ?? "worker",
      capabilityProfileKey: overrides.capabilityProfileKey ?? "worker",
      archetypeKey: overrides.archetypeKey ?? "general",
      departmentKey: overrides.departmentKey ?? "engineering",
      departmentName: overrides.departmentName ?? null,
      requestedForProjectId: overrides.requestedForProjectId ?? null,
      requestedReason: overrides.requestedReason ?? null,
    });
    return agentId;
  }

  it("infers project director placement defaults", async () => {
    const { companyId, projectId } = await seedCompanyAndProject();

    const resolved = await svc.previewForInput(
      companyId,
      {
        companyId,
        operatingClass: "project_leadership",
        archetypeKey: "project_director",
      },
      { projectId },
    );

    expect(resolved.scopeMode).toBe("leadership_raw");
    expect(resolved.projectRole).toBe("director");
  });

  it("infers project tech lead placement defaults", async () => {
    const { companyId, projectId } = await seedCompanyAndProject();

    const resolved = await svc.previewForInput(
      companyId,
      {
        companyId,
        operatingClass: "project_leadership",
        archetypeKey: "project_tech_lead",
      },
      { projectId },
    );

    expect(resolved.scopeMode).toBe("leadership_raw");
    expect(resolved.projectRole).toBe("engineering_manager");
  });

  it("infers team lead placement defaults", async () => {
    const { companyId, projectId } = await seedCompanyAndProject();

    const resolved = await svc.previewForInput(
      companyId,
      {
        companyId,
        operatingClass: "project_leadership",
        archetypeKey: "backend_team_lead",
      },
      { projectId },
    );

    expect(resolved.scopeMode).toBe("leadership_raw");
    expect(resolved.projectRole).toBe("functional_lead");
  });

  it("infers worker placement defaults", async () => {
    const { companyId, projectId } = await seedCompanyAndProject();

    const resolved = await svc.previewForInput(
      companyId,
      {
        companyId,
        operatingClass: "worker",
        archetypeKey: "frontend_engineer",
      },
      { projectId },
    );

    expect(resolved.scopeMode).toBe("execution");
    expect(resolved.projectRole).toBe("worker");
  });

  it("rejects ambiguous project leadership placement without explicit overrides", async () => {
    const { companyId, projectId } = await seedCompanyAndProject();

    await expect(
      svc.previewForInput(
        companyId,
        {
          companyId,
          operatingClass: "project_leadership",
          archetypeKey: "portfolio_director",
        },
        { projectId },
      ),
    ).rejects.toThrow(/ambiguous/i);
  });

  it("rejects direct executive placement", async () => {
    const { companyId, projectId } = await seedCompanyAndProject();

    await expect(
      svc.previewForInput(
        companyId,
        {
          companyId,
          operatingClass: "executive",
          archetypeKey: "chief_technology_officer",
        },
        { projectId },
      ),
    ).rejects.toThrow(/Executives/);
  });

  it("replaces the active primary scope and updates requested project fields", async () => {
    const { companyId, projectId } = await seedCompanyAndProject();
    const replacementProjectId = randomUUID();
    await db.insert(projects).values({
      id: replacementProjectId,
      companyId,
      name: "Growth",
      status: "active",
      color: "green",
    });
    const agentId = await seedAgent(companyId, {
      name: "Frontend Engineer",
      operatingClass: "worker",
      archetypeKey: "frontend_engineer",
      requestedForProjectId: projectId,
    });

    await db.insert(agentProjectScopes).values({
      companyId,
      agentId,
      projectId,
      scopeMode: "execution",
      projectRole: "worker",
      isPrimary: true,
      teamFunctionKey: "frontend",
      teamFunctionLabel: "Frontend",
      workstreamKey: null,
      workstreamLabel: null,
      grantedByPrincipalType: "human_operator",
      grantedByPrincipalId: "board-user",
      activeFrom: new Date("2026-04-12T00:00:00.000Z"),
      activeTo: null,
    });

    const result = await svc.applyPrimaryPlacement({
      companyId,
      agentId,
      placement: {
        projectId: replacementProjectId,
        teamFunctionKey: "frontend",
        teamFunctionLabel: "Frontend",
        requestedReason: "Move to growth",
      },
      actor: {
        principalType: "human_operator",
        principalId: "board-user",
      },
    });

    expect(result.scope.projectId).toBe(replacementProjectId);
    const activeScopes = await db
      .select()
      .from(agentProjectScopes)
      .where(
        and(
          eq(agentProjectScopes.agentId, agentId),
          eq(agentProjectScopes.isPrimary, true),
          isNull(agentProjectScopes.activeTo),
        ),
      );
    expect(activeScopes).toHaveLength(1);
    expect(activeScopes[0]?.projectId).toBe(replacementProjectId);

    const priorScopes = await db
      .select()
      .from(agentProjectScopes)
      .where(eq(agentProjectScopes.agentId, agentId));
    expect(priorScopes.some((scope) => scope.projectId === projectId && scope.activeTo !== null)).toBe(true);

    const updatedAgent = await db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0]!);
    expect(updatedAgent.requestedForProjectId).toBe(replacementProjectId);
    expect(updatedAgent.requestedReason).toBe("Move to growth");
  });

  it("rejects project placement across company boundaries", async () => {
    const { companyId } = await seedCompanyAndProject();
    const otherCompanyId = randomUUID();
    const otherProjectId = randomUUID();

    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other",
      issuePrefix: `T${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: otherProjectId,
      companyId: otherCompanyId,
      name: "Other Project",
      status: "active",
      color: "red",
    });

    const agentId = await seedAgent(companyId, {
      operatingClass: "worker",
      archetypeKey: "backend_engineer",
    });

    await expect(
      svc.applyPrimaryPlacement({
        companyId,
        agentId,
        placement: {
          projectId: otherProjectId,
        },
        actor: {
          principalType: "human_operator",
          principalId: "board-user",
        },
      }),
    ).rejects.toThrow(/same company/);
  });
});
