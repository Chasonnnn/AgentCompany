import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  companySkills,
  createDb,
  documents,
  documentRevisions,
  issueDocuments,
  issues,
  projects,
} from "@paperclipai/db";
import { skillReliabilityService } from "../services/skill-reliability.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("skill reliability repair service", { timeout: 20_000 }, () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-skill-reliability-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issues);
    await db.delete(companySkills);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "AI Workforce",
      issuePrefix: "AIWA",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: randomUUID(),
      companyId,
      name: "Paperclip Platform",
      status: "in_progress",
    });
    return companyId;
  }

  async function seedSkill(companyId: string, slug: string) {
    const skillId = randomUUID();
    await db.insert(companySkills).values({
      id: skillId,
      companyId,
      key: `global/codex/${slug}`,
      slug,
      name: slug,
      markdown: `---\nname: ${slug}\n---\n\n# ${slug}\n`,
      sourceType: "local_path",
      sourceLocator: `/tmp/${slug}`,
      metadata: { sourceKind: "managed_local" },
    });
    return skillId;
  }

  it("creates one triage issue by default for multiple repairable skill gaps", async () => {
    const companyId = await seedCompany();
    await seedSkill(companyId, "alpha");
    await seedSkill(companyId, "beta");

    const svc = skillReliabilityService(db);
    const preview = await svc.previewRepair(companyId);
    expect(preview.changedSkillCount).toBeGreaterThanOrEqual(2);

    const result = await svc.applyRepair(companyId, {
      selectionFingerprint: preview.selectionFingerprint,
    });

    expect(result.changedSkillCount).toBe(preview.changedSkillCount);
    expect(result.createdIssueIds).toHaveLength(1);
    const [issue] = await db.select().from(issues);
    expect(issue?.title).toBe("Skill reliability triage");
    expect(issue?.originId).toBe("__skill_reliability_triage__");
  });

  it("preserves per-skill issue creation when explicitly requested", async () => {
    const companyId = await seedCompany();
    await seedSkill(companyId, "alpha");
    await seedSkill(companyId, "beta");

    const svc = skillReliabilityService(db);
    const preview = await svc.previewRepair(companyId);
    const result = await svc.applyRepair(companyId, {
      selectionFingerprint: preview.selectionFingerprint,
      issueMode: "per_skill",
    });

    expect(result.changedSkillCount).toBe(preview.changedSkillCount);
    expect(result.createdIssueIds).toHaveLength(preview.changedSkillCount);
    const issueRows = await db.select().from(issues);
    expect(issueRows).toHaveLength(preview.changedSkillCount);
    expect(issueRows.every((issue) => issue.title.startsWith("Skill reliability: "))).toBe(true);
    expect(issueRows.some((issue) => issue.originId === "__skill_reliability_triage__")).toBe(false);
  });
});
