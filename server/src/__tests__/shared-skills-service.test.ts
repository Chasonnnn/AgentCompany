import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  companies,
  agents,
  createDb,
  heartbeatRuns,
  issues,
  projects,
  sharedSkillProposalComments,
  sharedSkillProposals,
  sharedSkills,
} from "@paperclipai/db";
import type { SharedSkillProposalCreateRequest } from "@paperclipai/shared";
import { sharedSkillService } from "../services/shared-skills.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("shared skill proposal service", { timeout: 20_000 }, () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-shared-skill-proposals-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(sharedSkillProposalComments);
    await db.delete(sharedSkillProposals);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(sharedSkills);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const projectId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "AI Workforce",
      issuePrefix: "AIWA",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Paperclip Platform",
      status: "in_progress",
    });
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "QA",
      role: "qa",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, projectId, agentId };
  }

  async function seedSharedSkill() {
    const sharedSkillId = randomUUID();
    await db.insert(sharedSkills).values({
      id: sharedSkillId,
      key: "global/codex/find-skills",
      slug: "find-skills",
      name: "Find Skills",
      markdown: "# Find Skills\n",
      fileInventory: [{ path: "SKILL.md", kind: "skill" }],
      trustLevel: "markdown_only",
      compatibility: "compatible",
      sourceRoot: "codex",
      sourcePath: "/tmp/find-skills",
      sourceDigest: "source-digest",
      lastMirroredSourceDigest: "source-digest",
      mirrorDigest: "mirror-digest",
      lastAppliedMirrorDigest: "mirror-digest",
      mirrorState: "pristine",
      sourceDriftState: "in_sync",
    });
    return sharedSkillId;
  }

  function verifiedSelfImprovement(overrides: Partial<SharedSkillProposalCreateRequest> = {}): SharedSkillProposalCreateRequest {
    return {
      kind: "self_improvement" as const,
      summary: "Improve find-skills metadata",
      rationale: "Audit found missing activation hints.",
      baseMirrorDigest: "mirror-digest",
      baseSourceDigest: "source-digest",
      changes: [{ path: "SKILL.md", op: "replace_file" as const, content: "# Updated\n" }],
      evidence: {
        issueId: overrides.evidence?.issueId ?? randomUUID(),
        runId: randomUUID(),
      },
      requiredVerification: {
        unitCommands: ["pnpm test:run -- reliability"],
        integrationCommands: [],
        promptfooCaseIds: [],
        architectureScenarioIds: [],
        smokeChecklist: [],
      },
      verificationResults: {
        passedUnitCommands: ["pnpm test:run -- reliability"],
        passedIntegrationCommands: [],
        passedPromptfooCaseIds: [],
        passedArchitectureScenarioIds: [],
        completedSmokeChecklist: [],
      },
      ...overrides,
    };
  }

  async function seedRun(companyId: string, agentId: string) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "succeeded",
      invocationSource: "on_demand",
    });
    return runId;
  }

  it("rejects self-improvement proposals before board review when verification is incomplete", async () => {
    const { companyId } = await seedCompany();
    const sharedSkillId = await seedSharedSkill();

    await expect(sharedSkillService(db).createProposal(
      companyId,
      sharedSkillId,
      verifiedSelfImprovement({
        evidence: { runId: randomUUID() },
        verificationResults: {
          passedUnitCommands: [],
          passedIntegrationCommands: [],
          passedPromptfooCaseIds: [],
          passedArchitectureScenarioIds: [],
          completedSmokeChecklist: [],
        },
      }),
      { actorType: "agent", actorId: randomUUID(), companyId, runId: randomUUID() },
    )).rejects.toMatchObject({
      status: 422,
    });
  });

  it("blocks duplicate open proposals unless the new proposal explicitly supersedes the prior one", async () => {
    const { companyId, projectId, agentId } = await seedCompany();
    const sharedSkillId = await seedSharedSkill();
    const svc = sharedSkillService(db);
    const firstRunId = await seedRun(companyId, agentId);
    const secondRunId = await seedRun(companyId, agentId);
    const thirdRunId = await seedRun(companyId, agentId);
    const actor = { actorType: "agent" as const, actorId: agentId, companyId, runId: firstRunId };
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Skill hardening",
      status: "in_progress",
      priority: "medium",
    });

    const first = await svc.createProposal(companyId, sharedSkillId, verifiedSelfImprovement({ evidence: { issueId, runId: firstRunId } }), actor);

    await expect(svc.createProposal(
      companyId,
      sharedSkillId,
      verifiedSelfImprovement({
        summary: "Improve find-skills metadata again",
        changes: [{ path: "SKILL.md", op: "replace_file", content: "# Updated again\n" }],
        evidence: { issueId, runId: secondRunId },
      }),
      actor,
    )).rejects.toMatchObject({
      status: 409,
    });

    const superseding = await svc.createProposal(
      companyId,
      sharedSkillId,
      verifiedSelfImprovement({
        summary: "Supersede find-skills metadata proposal",
        changes: [{ path: "SKILL.md", op: "replace_file", content: "# Superseding\n" }],
        evidence: { issueId, runId: thirdRunId },
        supersedesProposalId: first.id,
      }),
      actor,
    );

    expect(superseding.payload.supersedesProposalId).toBe(first.id);
  });

  it("requires proposal creation to rebase when the shared skill mirror changed", async () => {
    const { companyId } = await seedCompany();
    const sharedSkillId = await seedSharedSkill();

    await expect(sharedSkillService(db).createProposal(
      companyId,
      sharedSkillId,
      verifiedSelfImprovement({ baseMirrorDigest: "old-mirror-digest" }),
      { actorType: "agent", actorId: randomUUID(), companyId, runId: randomUUID() },
    )).rejects.toMatchObject({
      status: 409,
    });
  });
});
