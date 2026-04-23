import { createHash } from "node:crypto";
import {
  buildIssueDocumentTemplate,
  parseIssueProgressMarkdown,
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
export const HARDENING_DOC_KEYS = ["spec", "plan", "progress", "test-plan"] as const;
export type HardeningDocumentKey = typeof HARDENING_DOC_KEYS[number];

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
  const progressTemplate = buildIssueDocumentTemplate("progress", {
    title: input.title,
    description: input.reproductionSummary ?? `Failure-promoted skill hardening for ${input.skillName}.`,
    tier: "normal",
  }) ?? "";
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
    "- Describe the durable change the Paperclip-managed skill mirror, deterministic helper, or routing contract needs.",
    "- Treat upstream/global skill source directories as read-only unless the board explicitly overrides this issue.",
    "- Keep this focused on preventing recurrence, not just patching one answer.",
  ].join("\n");

  const plan = [
    planTemplate,
    "",
    "## Skill Hardening Steps",
    "",
    "1. Work in Paperclip-managed skill mirrors and shared-skill proposals; do not edit global source catalog files directly.",
    "2. Update or add the skill reliability metadata in the mirrored/proposed `SKILL.md`.",
    "3. Add or repair deterministic entrypoints before relying on latent reasoning.",
    "4. Add or update the required verification coverage.",
    "5. Trigger a company catalog refresh or shared-skill proposal review, then re-audit.",
    "",
    "## Source Edit Policy",
    "",
    "- Do not edit `~/.agents/skills`, `~/.codex/skills`, `~/.claude/skills`, or other global source catalogs for this work.",
    "- If a global skill needs a durable fix, mirror it into Paperclip first and drive the change through the shared-skill proposal path.",
    "- Only use an upstream/global source edit when the board explicitly asks for a machine-wide source change.",
    "",
    "## Reliability Findings",
    "",
    reliabilityLines.length > 0 ? stringifyList(reliabilityLines) : "- Add the audit or review findings that this hardening issue must clear.",
  ].join("\n");

  const progress = progressTemplate;

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

  return { spec, plan, progress, testPlan };
}

export function shouldUpsertHardeningDocument(key: HardeningDocumentKey, hasExistingDocument: boolean) {
  return key !== "progress" || !hasExistingDocument;
}

export function summarizeHardeningDocumentProgress(input: {
  documentsByKey: Partial<Record<HardeningDocumentKey, string | null>>;
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
    if (key === "progress") {
      if (template && template.trim() === body.trim()) return "scaffolded" as const;
      return parseIssueProgressMarkdown(body) ? "started" as const : "scaffolded" as const;
    }
    return template && template.trim() === body.trim() ? "scaffolded" as const : "started" as const;
  });
  return {
    missingCount: statuses.filter((status) => status === "missing").length,
    scaffoldedCount: statuses.filter((status) => status === "scaffolded").length,
    startedCount: statuses.filter((status) => status === "started").length,
  };
}

export function computeHardeningState(input: {
  documentsByKey: Partial<Record<HardeningDocumentKey, string | null>>;
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
