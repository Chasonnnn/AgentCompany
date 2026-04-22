import { createHash } from "node:crypto";
import {
  buildIssueDocumentTemplate,
  skillReliabilityMetadataSchema,
  type CompanySkillHardeningState,
  type CompanySkillFileInventoryEntry,
  type CompanySkillLinkedProposalSummary,
  type CompanySkillReliabilityStatus,
  type SkillReliabilityMetadata,
} from "@paperclipai/shared";
import { parseFrontmatterMarkdown } from "./frontmatter.js";

export const MANAGED_LOCAL_ADAPTER_TYPES = new Set([
  "claude_local",
  "codex_local",
  "cursor",
  "gemini_local",
  "opencode_local",
  "pi_local",
]);

export const SKILL_HARDENING_FINDING_ORIGIN_KIND = "skill_hardening_finding";
export const SKILL_RELIABILITY_AUDIT_ORIGIN_KIND = "skill_reliability_audit";
const HARDENING_DOC_KEYS = ["spec", "plan", "test-plan"] as const;

function normalizePortablePath(value: string) {
  return value.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "");
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function stringifyList(items: string[]) {
  return items.map((item) => `- ${item}`).join("\n");
}

export function stableDigest(parts: unknown[]) {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function normalizeSkillReliabilityMetadata(
  markdown: string,
): { metadata: SkillReliabilityMetadata | null; warnings: string[] } {
  const { frontmatter } = parseFrontmatterMarkdown(markdown);
  const parsed = skillReliabilityMetadataSchema.safeParse({
    activationHints: frontmatter.activationHints,
    deterministicEntrypoints: frontmatter.deterministicEntrypoints,
    verification: frontmatter.verification,
    overlapDomains: frontmatter.overlapDomains,
    disambiguationHints: frontmatter.disambiguationHints,
  });
  if (!parsed.success) {
    return {
      metadata: null,
      warnings: parsed.error.issues.map((issue) => issue.message),
    };
  }
  return {
    metadata: parsed.data,
    warnings: [],
  };
}

export function buildSkillHardeningScaffolds(input: {
  title: string;
  skillName: string;
  skillKey: string;
  sourceIssueIdentifier?: string | null;
  sourceFindingTitle?: string | null;
  failureFingerprint: string;
  reproductionSummary?: string | null;
  reliabilityFindingCodes?: string[];
}) {
  const specTemplate = buildIssueDocumentTemplate("spec", {
    title: input.title,
    description: input.reproductionSummary ?? `Failure-promoted skill hardening for ${input.skillName}.`,
    tier: "normal",
  }) ?? "# Spec";
  const planTemplate = buildIssueDocumentTemplate("plan", {
    title: input.title,
    description: input.reproductionSummary ?? `Failure-promoted skill hardening for ${input.skillName}.`,
    tier: "normal",
  }) ?? "# Plan";
  const testPlanTemplate = buildIssueDocumentTemplate("test-plan", {
    title: input.title,
    description: input.reproductionSummary ?? `Failure-promoted skill hardening for ${input.skillName}.`,
    tier: "normal",
  }) ?? "# Test Plan";
  const sourceLines = [
    `- Skill: \`${input.skillName}\``,
    `- Skill key: \`${input.skillKey}\``,
    input.sourceIssueIdentifier ? `- Source issue: \`${input.sourceIssueIdentifier}\`` : null,
    input.sourceFindingTitle ? `- Source finding: ${input.sourceFindingTitle}` : null,
    `- Failure fingerprint: \`${input.failureFingerprint}\``,
  ].filter(isNonEmptyString);
  const reliabilityLines = (input.reliabilityFindingCodes ?? []).map((code) => `- \`${code}\``);
  const reproductionLines = input.reproductionSummary?.trim()
    ? [input.reproductionSummary.trim()]
    : ["Document the concrete repro, the wrong behavior, and the desired structural fix."];

  const spec = [
    specTemplate,
    "",
    "## Failure Source",
    "",
    stringifyList(sourceLines),
    "",
    "## Reproduction",
    "",
    ...reproductionLines,
    "",
    "## Structural Fix",
    "",
    "- Describe the durable change the skill, deterministic helper, or routing contract needs.",
    "- Keep this focused on preventing recurrence, not just patching one answer.",
  ].join("\n");

  const plan = [
    planTemplate,
    "",
    "## Skill Hardening Steps",
    "",
    "1. Update or add the skill reliability metadata in `SKILL.md`.",
    "2. Add or repair deterministic entrypoints before relying on latent reasoning.",
    "3. Add or update the required verification coverage.",
    "4. Draft any shared-skill proposal only after the local hardening docs are real.",
    "",
    "## Reliability Findings",
    "",
    reliabilityLines.length > 0 ? stringifyList(reliabilityLines) : "- Add the audit or review findings that this hardening issue must clear.",
  ].join("\n");

  const testPlan = [
    testPlanTemplate,
    "",
    "## Unit",
    "",
    "- Add the exact unit checks or note why none apply.",
    "",
    "## Integration",
    "",
    "- Add the exact integration checks or note why none apply.",
    "",
    "## Promptfoo",
    "",
    "- List required promptfoo case IDs.",
    "",
    "## Architecture",
    "",
    "- List required architecture scenario IDs.",
    "",
    "## Smoke",
    "",
    "- List the final smoke checklist items.",
  ].join("\n");

  return { spec, plan, testPlan };
}

export function summarizeHardeningDocumentProgress(input: {
  documentsByKey: Partial<Record<typeof HARDENING_DOC_KEYS[number], string | null>>;
  issueTitle: string;
  issueDescription?: string | null;
}) {
  const statuses = HARDENING_DOC_KEYS.map((key) => {
    const body = input.documentsByKey[key];
    if (!body) return "missing" as const;
    const template = buildIssueDocumentTemplate(key, {
      title: input.issueTitle,
      description: input.issueDescription ?? null,
      tier: "normal",
    });
    return template && template.trim() === body.trim() ? "scaffolded" as const : "started" as const;
  });
  return {
    missingCount: statuses.filter((status) => status === "missing").length,
    scaffoldedCount: statuses.filter((status) => status === "scaffolded").length,
    startedCount: statuses.filter((status) => status === "started").length,
  };
}

export function computeHardeningState(input: {
  documentsByKey: Partial<Record<typeof HARDENING_DOC_KEYS[number], string | null>>;
  issueTitle: string;
  issueDescription?: string | null;
  proposal: CompanySkillLinkedProposalSummary | null;
  proposalStatus: CompanySkillReliabilityStatus;
  proposalVerificationReady: boolean;
  proposalVerificationStarted: boolean;
}): CompanySkillHardeningState | null {
  if (input.proposal?.status === "approved") {
    return "complete";
  }
  if (input.proposal) {
    if (input.proposalVerificationReady) return "ready_for_approval";
    if (input.proposalVerificationStarted) return "verification_pending";
    return "proposal_open";
  }

  const progress = summarizeHardeningDocumentProgress({
    documentsByKey: input.documentsByKey,
    issueTitle: input.issueTitle,
    issueDescription: input.issueDescription ?? null,
  });
  if (progress.startedCount > 0) return "drafted";
  if (progress.scaffoldedCount > 0 || progress.missingCount < HARDENING_DOC_KEYS.length) return "scaffolded";
  return input.proposalStatus === "healthy" ? "complete" : null;
}

export function inventoryContainsPath(
  inventory: CompanySkillFileInventoryEntry[],
  relativePath: string,
) {
  const normalized = normalizePortablePath(relativePath);
  return inventory.some((entry) => normalizePortablePath(entry.path) === normalized);
}

export function commandMentionsInventoryPath(
  inventory: CompanySkillFileInventoryEntry[],
  command: string,
) {
  const normalizedCommand = normalizePortablePath(command);
  return inventory.some((entry) => normalizedCommand.includes(normalizePortablePath(entry.path)));
}

