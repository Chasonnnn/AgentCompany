import fs from "node:fs/promises";
import path from "node:path";
import { and, asc, desc, eq, inArray, isNull, notInArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  companySkills,
  documents,
  issueDocuments,
  issues,
  sharedSkillProposals,
  sharedSkills,
} from "@paperclipai/db";
import type {
  CompanySkillDetail,
  CompanySkillFileInventoryEntry,
  CompanySkillLinkedProposalSummary,
  CompanySkillReliabilityAudit,
  CompanySkillReliabilityAuditSkill,
  CompanySkillReliabilityFinding,
  CompanySkillReliabilityRepairApplyRequest,
  CompanySkillReliabilityRepairPreview,
  CompanySkillReliabilityRepairResult,
  CompanySkillReliabilityStatus,
  CompanySkillReliabilitySweepRequest,
  CompanySkillReliabilitySweepResult,
  SharedSkillProposalPayload,
  SkillReliabilityMetadata,
} from "@paperclipai/shared";
import { buildIssueDocumentTemplate } from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";
import { companySkillService } from "./company-skills.js";
import { documentService } from "./documents.js";
import { issueService } from "./issues.js";
import {
  buildSkillHardeningScaffolds,
  commandMentionsInventoryPath,
  computeHardeningState,
  inventoryContainsPath,
  MANAGED_LOCAL_ADAPTER_TYPES,
  normalizeSkillReliabilityMetadata,
  SKILL_RELIABILITY_AUDIT_ORIGIN_KIND,
  stableDigest,
  summarizeHardeningDocumentProgress,
} from "./skill-reliability-lib.js";

const OPEN_PROPOSAL_STATUSES = new Set(["pending", "revision_requested"]);
const REPAIRABLE_AUDIT_STATUSES = new Set<CompanySkillReliabilityStatus>(["repairable_gap", "proposal_stale"]);
const STALE_PROPOSAL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const HARDENING_DOC_KEYS = ["spec", "plan", "test-plan"] as const;

type ReliabilityActor = {
  agentId?: string | null;
  userId?: string | null;
  runId?: string | null;
};

type HardeningIssueRow = {
  id: string;
  identifier: string | null;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  originKind: string;
  originId: string | null;
  updatedAt: Date;
};

type HardeningIssueWithDocs = HardeningIssueRow & {
  docs: Partial<Record<(typeof HARDENING_DOC_KEYS)[number], string | null>>;
};

function normalize(value: string) {
  return value.trim().toLowerCase();
}

function asPayload(value: unknown): SharedSkillProposalPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as SharedSkillProposalPayload;
}

function verificationSatisfied(
  required: SkillReliabilityMetadata["verification"],
  payload: SharedSkillProposalPayload | null,
) {
  if (!required) {
    return { ready: true, started: false };
  }
  const results = payload?.verificationResults ?? null;
  if (!results) return { ready: false, started: false };

  const containsAll = (requiredItems: string[], actualItems: string[]) =>
    requiredItems.every((item) => actualItems.includes(item));

  const ready =
    containsAll(required.unitCommands, results.passedUnitCommands ?? [])
    && containsAll(required.integrationCommands, results.passedIntegrationCommands ?? [])
    && containsAll(required.promptfooCaseIds, results.passedPromptfooCaseIds ?? [])
    && containsAll(required.architectureScenarioIds, results.passedArchitectureScenarioIds ?? [])
    && containsAll(required.smokeChecklist, results.completedSmokeChecklist ?? []);
  const started =
    (results.passedUnitCommands?.length ?? 0) > 0
    || (results.passedIntegrationCommands?.length ?? 0) > 0
    || (results.passedPromptfooCaseIds?.length ?? 0) > 0
    || (results.passedArchitectureScenarioIds?.length ?? 0) > 0
    || (results.completedSmokeChecklist?.length ?? 0) > 0;
  return { ready, started };
}

function normalizeSkillSummary(skill: CompanySkillDetail) {
  return {
    skillId: skill.id,
    sharedSkillId: skill.sharedSkillId,
    key: skill.key,
    slug: skill.slug,
    name: skill.name,
    sourceType: skill.sourceType,
    attachedAgentCount: skill.attachedAgentCount,
    managedLocalAgentCount: skill.usedByAgents.filter((agent) => MANAGED_LOCAL_ADAPTER_TYPES.has(agent.adapterType)).length,
    externalOnlyUsage:
      skill.usedByAgents.length > 0
      && skill.usedByAgents.every((agent) => !MANAGED_LOCAL_ADAPTER_TYPES.has(agent.adapterType)),
  };
}

async function loadPromptfooCaseIds() {
  const testsDir = path.resolve(process.cwd(), "evals/promptfoo/tests");
  const entries = await fs.readdir(testsDir, { withFileTypes: true }).catch(() => []);
  const ids = new Set<string>();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".yaml")) continue;
    const content = await fs.readFile(path.join(testsDir, entry.name), "utf8").catch(() => "");
    const matches = content.matchAll(/description:\s*["']([^"']+?)\s+-/g);
    for (const match of matches) {
      if (match[1]) ids.add(match[1].trim());
    }
  }
  return ids;
}

async function loadArchitectureScenarioIds() {
  const scenariosPath = path.resolve(process.cwd(), "evals/architecture/scenarios.ts");
  const content = await fs.readFile(scenariosPath, "utf8").catch(() => "");
  const ids = new Set<string>();
  const matches = content.matchAll(/id:\s*"([^"]+)"/g);
  for (const match of matches) {
    if (match[1]) ids.add(match[1].trim());
  }
  return ids;
}

async function readLinkedHardeningIssues(
  db: Db,
  companyId: string,
  skillKeys: string[],
): Promise<Map<string, HardeningIssueWithDocs[]>> {
  if (skillKeys.length === 0) return new Map();
  const rows = await db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
      description: issues.description,
      status: issues.status,
      priority: issues.priority,
      originKind: issues.originKind,
      originId: issues.originId,
      updatedAt: issues.updatedAt,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        inArray(issues.originKind, [SKILL_RELIABILITY_AUDIT_ORIGIN_KIND, "skill_hardening_finding"]),
        inArray(issues.originId, skillKeys),
        isNull(issues.hiddenAt),
      ),
    )
    .orderBy(desc(issues.updatedAt));

  const issueIds = rows.map((row) => row.id);
  const docsByIssue = new Map<string, Partial<Record<(typeof HARDENING_DOC_KEYS)[number], string | null>>>();
  if (issueIds.length > 0) {
    const docRows = await db
      .select({
        issueId: issueDocuments.issueId,
        key: issueDocuments.key,
        body: documents.latestBody,
      })
      .from(issueDocuments)
      .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
      .where(and(inArray(issueDocuments.issueId, issueIds), inArray(issueDocuments.key, [...HARDENING_DOC_KEYS])));
    for (const row of docRows) {
      const current = docsByIssue.get(row.issueId) ?? {};
      current[row.key as (typeof HARDENING_DOC_KEYS)[number]] = row.body;
      docsByIssue.set(row.issueId, current);
    }
  }

  const bySkillKey = new Map<string, HardeningIssueWithDocs[]>();
  for (const row of rows) {
    const originId = row.originId ?? null;
    if (!originId) continue;
    const current = bySkillKey.get(originId) ?? [];
    current.push({
      ...row,
      docs: docsByIssue.get(row.id) ?? {},
    });
    bySkillKey.set(originId, current);
  }
  return bySkillKey;
}

async function readLinkedProposals(
  db: Db,
  sharedSkillIds: string[],
): Promise<Map<string, { summary: CompanySkillLinkedProposalSummary; payload: SharedSkillProposalPayload | null; stale: boolean }>> {
  if (sharedSkillIds.length === 0) return new Map();
  const rows = await db
    .select({
      id: sharedSkillProposals.id,
      sharedSkillId: sharedSkillProposals.sharedSkillId,
      kind: sharedSkillProposals.kind,
      status: sharedSkillProposals.status,
      summary: sharedSkillProposals.summary,
      createdAt: sharedSkillProposals.createdAt,
      payload: sharedSkillProposals.payload,
      baseMirrorDigest: sharedSkillProposals.baseMirrorDigest,
      mirrorDigest: sharedSkills.mirrorDigest,
    })
    .from(sharedSkillProposals)
    .innerJoin(sharedSkills, eq(sharedSkillProposals.sharedSkillId, sharedSkills.id))
    .where(and(inArray(sharedSkillProposals.sharedSkillId, sharedSkillIds), inArray(sharedSkillProposals.status, ["pending", "revision_requested", "approved"])))
    .orderBy(desc(sharedSkillProposals.createdAt));

  const bySharedSkill = new Map<string, { summary: CompanySkillLinkedProposalSummary; payload: SharedSkillProposalPayload | null; stale: boolean }>();
  for (const row of rows) {
    if (bySharedSkill.has(row.sharedSkillId)) continue;
    const staleByAge =
      OPEN_PROPOSAL_STATUSES.has(row.status)
      && Date.now() - row.createdAt.getTime() > STALE_PROPOSAL_MAX_AGE_MS;
    const staleByDigest =
      OPEN_PROPOSAL_STATUSES.has(row.status)
      && Boolean(row.baseMirrorDigest && row.mirrorDigest && row.baseMirrorDigest !== row.mirrorDigest);
    bySharedSkill.set(row.sharedSkillId, {
      summary: {
        id: row.id,
        kind: row.kind as CompanySkillLinkedProposalSummary["kind"],
        status: row.status as CompanySkillLinkedProposalSummary["status"],
        summary: row.summary,
        createdAt: row.createdAt.toISOString(),
      },
      payload: asPayload(row.payload),
      stale: staleByAge || staleByDigest,
    });
  }
  return bySharedSkill;
}

function pickLinkedIssue(issuesForSkill: HardeningIssueWithDocs[]) {
  const open = issuesForSkill.find((issue) => !["done", "cancelled"].includes(issue.status));
  return open ?? issuesForSkill[0] ?? null;
}

function buildFinding(
  code: string,
  severity: CompanySkillReliabilityFinding["severity"],
  message: string,
  repairable: boolean,
  references: string[] = [],
): CompanySkillReliabilityFinding {
  return { code, severity, message, repairable, references };
}

function deriveStatus(findings: CompanySkillReliabilityFinding[]): CompanySkillReliabilityStatus {
  if (findings.length === 0) return "healthy";
  if (findings.some((finding) => finding.code === "stale_open_proposal")) return "proposal_stale";
  if (findings.every((finding) => finding.repairable)) return "repairable_gap";
  return "needs_review";
}

export function skillReliabilityService(db: Db) {
  const companySkillsSvc = companySkillService(db);
  const docsSvc = documentService(db);
  const issuesSvc = issueService(db);

  async function readBaseDetails(companyId: string, skillId?: string) {
    if (skillId) {
      const detail = await companySkillsSvc.detail(companyId, skillId);
      return detail ? [detail] : [];
    }
    const skills = await companySkillsSvc.listFull(companyId);
    const details = await Promise.all(skills.map(async (skill) => companySkillsSvc.detail(companyId, skill.id)));
    return details.filter((entry): entry is CompanySkillDetail => Boolean(entry));
  }

  async function buildAudit(companyId: string, skillId?: string): Promise<CompanySkillReliabilityAudit> {
    const details = await readBaseDetails(companyId, skillId);
    const promptfooIds = await loadPromptfooCaseIds();
    const architectureIds = await loadArchitectureScenarioIds();
    const hardeningIssues = await readLinkedHardeningIssues(db, companyId, details.map((skill) => skill.key));
    const proposalBySharedSkill = await readLinkedProposals(
      db,
      details.map((skill) => skill.sharedSkillId).filter((value): value is string => Boolean(value)),
    );

    const byActivationHint = new Map<string, string[]>();
    const byOverlapDomain = new Map<string, string[]>();
    const parsedBySkillId = new Map<string, { metadata: SkillReliabilityMetadata | null; warnings: string[] }>();
    for (const detail of details) {
      const parsed = normalizeSkillReliabilityMetadata(detail.markdown);
      parsedBySkillId.set(detail.id, parsed);
      for (const hint of parsed.metadata?.activationHints ?? []) {
        const normalized = normalize(hint);
        const current = byActivationHint.get(normalized) ?? [];
        current.push(detail.key);
        byActivationHint.set(normalized, current);
      }
      for (const overlap of parsed.metadata?.overlapDomains ?? []) {
        const normalized = normalize(overlap);
        const current = byOverlapDomain.get(normalized) ?? [];
        current.push(detail.key);
        byOverlapDomain.set(normalized, current);
      }
    }

    const auditSkills: CompanySkillReliabilityAuditSkill[] = details.map((detail) => {
      const parsed = parsedBySkillId.get(detail.id) ?? { metadata: null, warnings: [] };
      const metadata = parsed.metadata;
      const findings: CompanySkillReliabilityFinding[] = [];
      for (const warning of parsed.warnings) {
        findings.push(buildFinding("invalid_reliability_frontmatter", "medium", warning, true, ["SKILL.md"]));
      }

      if ((metadata?.activationHints.length ?? 0) === 0) {
        findings.push(buildFinding("missing_activation_hints", "medium", "Add activation hints so the skill is reachable.", true, ["SKILL.md"]));
      }
      if (!metadata?.verification) {
        findings.push(buildFinding("missing_verification_block", "medium", "Add verification metadata so the reliability loop can audit this skill.", true, ["SKILL.md"]));
      }

      for (const entrypoint of metadata?.deterministicEntrypoints ?? []) {
        if (!inventoryContainsPath(detail.fileInventory, entrypoint)) {
          findings.push(buildFinding("missing_deterministic_entrypoint", "high", `Deterministic entrypoint '${entrypoint}' is not present in the skill inventory.`, true, [entrypoint]));
        }
      }

      for (const command of metadata?.verification?.unitCommands ?? []) {
        if (!commandMentionsInventoryPath(detail.fileInventory, command)) {
          findings.push(buildFinding("unit_command_without_inventory_reference", "low", `Unit command '${command}' does not reference a known skill file.`, true, [command]));
        }
      }
      for (const command of metadata?.verification?.integrationCommands ?? []) {
        if (!commandMentionsInventoryPath(detail.fileInventory, command)) {
          findings.push(buildFinding("integration_command_without_inventory_reference", "low", `Integration command '${command}' does not reference a known skill file.`, true, [command]));
        }
      }

      for (const promptfooCaseId of metadata?.verification?.promptfooCaseIds ?? []) {
        if (!promptfooIds.has(promptfooCaseId)) {
          findings.push(buildFinding("unknown_promptfoo_case", "medium", `Promptfoo case '${promptfooCaseId}' is not registered.`, true, [promptfooCaseId]));
        }
      }
      for (const scenarioId of metadata?.verification?.architectureScenarioIds ?? []) {
        if (!architectureIds.has(scenarioId)) {
          findings.push(buildFinding("unknown_architecture_scenario", "medium", `Architecture scenario '${scenarioId}' is not registered.`, true, [scenarioId]));
        }
      }

      const managedLocalAgentCount = detail.usedByAgents.filter((agent) => MANAGED_LOCAL_ADAPTER_TYPES.has(agent.adapterType)).length;
      if (managedLocalAgentCount > 0 && (metadata?.verification?.promptfooCaseIds.length ?? 0) === 0) {
        findings.push(buildFinding("missing_semantic_promptfoo_coverage", "medium", "Managed local adapters require promptfoo route/process coverage for this skill.", true, ["verification.promptfooCaseIds"]));
      }

      for (const hint of metadata?.activationHints ?? []) {
        const normalizedHint = normalize(hint);
        const collisions = (byActivationHint.get(normalizedHint) ?? []).filter((key) => key !== detail.key);
        if (collisions.length > 0) {
          findings.push(buildFinding("activation_hint_collision", "high", `Activation hint '${hint}' collides with ${collisions.join(", ")}.`, false, collisions.map((key) => `skill:${key}`)));
        } else {
          const containment = Array.from(byActivationHint.keys()).find((other) => {
            if (other === normalizedHint) return false;
            return other.includes(normalizedHint) || normalizedHint.includes(other);
          });
          if (containment) {
            findings.push(buildFinding("activation_hint_containment", "medium", `Activation hint '${hint}' overlaps another routing phrase and needs review.`, false, [containment]));
          }
        }
      }

      for (const overlap of metadata?.overlapDomains ?? []) {
        const normalizedOverlap = normalize(overlap);
        const collisions = (byOverlapDomain.get(normalizedOverlap) ?? []).filter((key) => key !== detail.key);
        if (collisions.length > 0) {
          findings.push(buildFinding("overlap_domain_collision", "high", `Overlap domain '${overlap}' collides with ${collisions.join(", ")}.`, false, collisions.map((key) => `skill:${key}`)));
        }
      }

      if (
        (metadata?.activationHints.some((hint) => (byActivationHint.get(normalize(hint)) ?? []).some((key) => key !== detail.key))
          || metadata?.overlapDomains.some((value) => (byOverlapDomain.get(normalize(value)) ?? []).some((key) => key !== detail.key)))
        && (metadata?.disambiguationHints.length ?? 0) === 0
      ) {
        findings.push(buildFinding("missing_disambiguation_hints", "medium", "Routing overlap requires explicit disambiguation hints in SKILL.md.", true, ["disambiguationHints"]));
      }
      if (
        (metadata?.activationHints.some((hint) => (byActivationHint.get(normalize(hint)) ?? []).some((key) => key !== detail.key))
          || metadata?.overlapDomains.some((value) => (byOverlapDomain.get(normalize(value)) ?? []).some((key) => key !== detail.key)))
        && managedLocalAgentCount > 0
        && !(metadata?.verification?.promptfooCaseIds ?? []).includes("reliability.skill_disambiguation")
      ) {
        findings.push(buildFinding("missing_disambiguation_promptfoo", "medium", "Managed local adapters need the reliability.skill_disambiguation promptfoo case for overlapping skills.", true, ["reliability.skill_disambiguation"]));
      }

      const linkedIssue = pickLinkedIssue(hardeningIssues.get(detail.key) ?? []);
      const linkedProposal = detail.sharedSkillId ? proposalBySharedSkill.get(detail.sharedSkillId) ?? null : null;
      if (linkedProposal?.stale) {
        findings.push(buildFinding("stale_open_proposal", "high", "Open shared-skill proposal is stale and needs refresh.", true, [`proposal:${linkedProposal.summary.id}`]));
      }

      const proposalVerification = verificationSatisfied(metadata?.verification ?? null, linkedProposal?.payload ?? null);
      const status = deriveStatus(findings);
      const hardeningState = computeHardeningState({
        documentsByKey: linkedIssue?.docs ?? {},
        issueTitle: linkedIssue?.title ?? detail.name,
        issueDescription: linkedIssue?.description ?? detail.description ?? null,
        proposal: linkedProposal?.summary ?? null,
        proposalStatus: status,
        proposalVerificationReady: proposalVerification.ready,
        proposalVerificationStarted: proposalVerification.started,
      });

      return {
        ...normalizeSkillSummary(detail),
        reliabilityMetadata: metadata,
        reliabilityParseWarnings: parsed.warnings,
        status,
        findings,
        linkedHardeningIssue: linkedIssue
          ? {
            id: linkedIssue.id,
            identifier: linkedIssue.identifier,
            title: linkedIssue.title,
            status: linkedIssue.status,
            priority: linkedIssue.priority,
          }
          : null,
        linkedProposal: linkedProposal?.summary ?? null,
        hardeningState,
      };
    });

    return {
      companyId,
      auditedSkillCount: auditSkills.length,
      healthyCount: auditSkills.filter((skill) => skill.status === "healthy").length,
      repairableGapCount: auditSkills.filter((skill) => skill.status === "repairable_gap").length,
      needsReviewCount: auditSkills.filter((skill) => skill.status === "needs_review").length,
      proposalStaleCount: auditSkills.filter((skill) => skill.status === "proposal_stale").length,
      managedAdapterTypes: [...MANAGED_LOCAL_ADAPTER_TYPES],
      skills: auditSkills.sort((left, right) => left.name.localeCompare(right.name)),
    };
  }

  async function detail(companyId: string, skillId: string) {
    const baseDetail = await companySkillsSvc.detail(companyId, skillId);
    if (!baseDetail) return null;
    const audit = await buildAudit(companyId, skillId);
    const audited = audit.skills[0] ?? null;
    return audited
      ? {
        ...baseDetail,
        reliabilityMetadata: audited.reliabilityMetadata,
        reliabilityParseWarnings: audited.reliabilityParseWarnings,
        linkedHardeningIssue: audited.linkedHardeningIssue,
        linkedProposal: audited.linkedProposal,
        hardeningState: audited.hardeningState,
      }
      : {
        ...baseDetail,
        reliabilityMetadata: null,
        reliabilityParseWarnings: [],
        linkedHardeningIssue: null,
        linkedProposal: null,
        hardeningState: null,
      };
  }

  async function buildRepairPreview(companyId: string): Promise<CompanySkillReliabilityRepairPreview> {
    const audit = await buildAudit(companyId);
    const repairable = audit.skills.filter((skill) => REPAIRABLE_AUDIT_STATUSES.has(skill.status));
    const selectionFingerprint = stableDigest(repairable.map((skill) => [skill.skillId, skill.status, skill.findings.map((finding) => finding.code)]));
    return {
      ...audit,
      changedSkillCount: repairable.length,
      selectionFingerprint,
    };
  }

  async function findQaOwner(companyId: string) {
    return db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.archetypeKey, "qa_evals_continuity_owner"), notInArray(agents.status, ["terminated"])))
      .orderBy(asc(agents.createdAt))
      .then((rows) => rows[0]?.id ?? null);
  }

  async function upsertHardeningDocs(issueId: string, scaffolds: ReturnType<typeof buildSkillHardeningScaffolds>, actor: ReliabilityActor) {
    const docs = {
      spec: scaffolds.spec,
      plan: scaffolds.plan,
      "test-plan": scaffolds.testPlan,
    } as const;
    for (const [key, body] of Object.entries(docs)) {
      const existing = await docsSvc.getIssueDocumentByKey(issueId, key);
      await docsSvc.upsertIssueDocument({
        issueId,
        key,
        title: null,
        format: "markdown",
        body,
        changeSummary: existing ? "Refresh skill hardening scaffold" : "Create skill hardening scaffold",
        baseRevisionId: existing?.latestRevisionId ?? null,
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.userId ?? null,
        createdByRunId: actor.runId ?? null,
      });
    }
  }

  async function ensureAuditHardeningIssue(
    companyId: string,
    skill: CompanySkillReliabilityAudit["skills"][number],
    actor: ReliabilityActor,
  ) {
    const existing = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, SKILL_RELIABILITY_AUDIT_ORIGIN_KIND), eq(issues.originId, skill.key), isNull(issues.hiddenAt)))
      .orderBy(desc(issues.updatedAt))
      .then((rows) => rows[0] ?? null);

    const assigneeAgentId = await findQaOwner(companyId);
    const title = `Skill reliability: ${skill.name}`;
    const description = `Reliability audit follow-up for ${skill.name}.`;
    const scaffolds = buildSkillHardeningScaffolds({
      title,
      skillName: skill.name,
      skillKey: skill.key,
      failureFingerprint: stableDigest([companyId, skill.key, skill.findings.map((finding) => finding.code)]),
      reliabilityFindingCodes: skill.findings.map((finding) => finding.code),
    });

    if (existing) {
      if (["done", "cancelled"].includes(existing.status)) {
        await issuesSvc.update(existing.id, {
          status: "todo",
          assigneeAgentId,
          actorAgentId: actor.agentId ?? null,
          actorUserId: actor.userId ?? null,
        });
      }
      await upsertHardeningDocs(existing.id, scaffolds, actor);
      return { issueId: existing.id, created: false };
    }

    const created = await issuesSvc.create(companyId, {
      title,
      description,
      status: "todo",
      priority: "medium",
      assigneeAgentId,
      assigneeUserId: null,
      originKind: SKILL_RELIABILITY_AUDIT_ORIGIN_KIND,
      originId: skill.key,
      originFingerprint: "default",
      createdByAgentId: actor.agentId ?? null,
      createdByUserId: actor.userId ?? null,
    });
    await upsertHardeningDocs(created.id, scaffolds, actor);
    return { issueId: created.id, created: true };
  }

  async function applyRepair(
    companyId: string,
    input: CompanySkillReliabilityRepairApplyRequest,
    actor: ReliabilityActor = {},
  ): Promise<CompanySkillReliabilityRepairResult> {
    const preview = await buildRepairPreview(companyId);
    if (preview.selectionFingerprint !== input.selectionFingerprint) {
      throw conflict("Reliability repair preview is stale. Refresh the preview and try again.");
    }

    const targets = preview.skills.filter((skill) => REPAIRABLE_AUDIT_STATUSES.has(skill.status));
    const createdIssueIds: string[] = [];
    const refreshedIssueIds: string[] = [];
    for (const skill of targets) {
      const ensured = await ensureAuditHardeningIssue(companyId, skill, actor);
      if (ensured.created) createdIssueIds.push(ensured.issueId);
      else refreshedIssueIds.push(ensured.issueId);
    }

    return {
      companyId,
      changedSkillCount: targets.length,
      createdIssueIds,
      refreshedIssueIds,
      selectionFingerprint: preview.selectionFingerprint,
      audit: await buildAudit(companyId),
    };
  }

  async function sweep(
    companyId: string,
    input: CompanySkillReliabilitySweepRequest,
    actor: ReliabilityActor = {},
  ): Promise<CompanySkillReliabilitySweepResult> {
    const audit = await buildAudit(companyId);
    if (input.mode === "report") {
      return {
        companyId,
        mode: input.mode,
        createdIssueIds: [],
        refreshedIssueIds: [],
        audit,
      };
    }
    const preview = await buildRepairPreview(companyId);
    const result = await applyRepair(companyId, { selectionFingerprint: preview.selectionFingerprint }, actor);
    return {
      companyId,
      mode: input.mode,
      createdIssueIds: result.createdIssueIds,
      refreshedIssueIds: result.refreshedIssueIds,
      audit: result.audit,
    };
  }

  return {
    detail,
    audit: buildAudit,
    previewRepair: buildRepairPreview,
    applyRepair,
    sweep,
  };
}

