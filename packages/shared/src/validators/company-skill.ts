import { z } from "zod";

export const companySkillSourceTypeSchema = z.enum(["local_path", "github", "url", "catalog", "skills_sh", "shared_mirror"]);
export const companySkillTrustLevelSchema = z.enum(["markdown_only", "assets", "scripts_executables"]);
export const companySkillCompatibilitySchema = z.enum(["compatible", "unknown", "invalid"]);
export const companySkillVerificationStateSchema = z.enum(["pending", "verified", "failed"]);
export const companySkillSourceBadgeSchema = z.enum(["paperclip", "github", "local", "url", "catalog", "skills_sh", "shared_mirror"]);
export const globalSkillCatalogSourceRootSchema = z.enum(["codex", "claude", "agents"]);
export const companySkillCoverageStatusSchema = z.enum([
  "covered",
  "repairable_gap",
  "nonrepairable_gap",
  "customized",
]);
export const companySkillHardeningStateSchema = z.enum([
  "scaffolded",
  "drafted",
  "proposal_open",
  "verification_pending",
  "ready_for_approval",
  "complete",
]);
export const companySkillReliabilityStatusSchema = z.enum([
  "healthy",
  "repairable_gap",
  "needs_review",
  "proposal_stale",
]);

export const companySkillFileInventoryEntrySchema = z.object({
  path: z.string().min(1),
  kind: z.enum(["skill", "markdown", "reference", "script", "asset", "other"]),
  sha256: z.string().nullable().optional(),
});

export const companySkillCompatibilityMetadataSchema = z.object({
  paperclipApiRange: z.string().nullable(),
  minAdapterVersion: z.string().nullable(),
  requiredTools: z.array(z.string().min(1)).default([]),
  requiredCapabilities: z.array(z.string().min(1)).default([]),
});

export const skillVerificationMetadataSchema = z.object({
  unitCommands: z.array(z.string().min(1)).default([]),
  integrationCommands: z.array(z.string().min(1)).default([]),
  promptfooCaseIds: z.array(z.string().min(1)).default([]),
  architectureScenarioIds: z.array(z.string().min(1)).default([]),
  smokeChecklist: z.array(z.string().min(1)).default([]),
});

export const skillReliabilityMetadataSchema = z.object({
  activationHints: z.array(z.string().min(1)).default([]),
  deterministicEntrypoints: z.array(z.string().min(1)).default([]),
  verification: skillVerificationMetadataSchema.nullable().optional().default(null),
  overlapDomains: z.array(z.string().min(1)).default([]),
  disambiguationHints: z.array(z.string().min(1)).default([]),
});

export const companySkillLinkedIssueSummarySchema = z.object({
  id: z.string().uuid(),
  identifier: z.string().nullable(),
  title: z.string().min(1),
  status: z.string().min(1),
  priority: z.string().min(1),
});

export const companySkillLinkedProposalSummarySchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(["self_improvement", "upstream_adoption", "merge_review"]),
  status: z.enum(["pending", "revision_requested", "approved", "rejected", "superseded"]),
  summary: z.string().min(1),
  createdAt: z.string().min(1),
});

export const companySkillSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  sharedSkillId: z.string().uuid().nullable(),
  key: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable(),
  markdown: z.string(),
  sourceType: companySkillSourceTypeSchema,
  sourceLocator: z.string().nullable(),
  sourceRef: z.string().nullable(),
  trustLevel: companySkillTrustLevelSchema,
  compatibility: companySkillCompatibilitySchema,
  manifestVersion: z.number().int().positive(),
  identityDigest: z.string().min(1),
  contentDigest: z.string().min(1),
  sourceVerifiedAt: z.coerce.date().nullable(),
  verificationState: companySkillVerificationStateSchema,
  compatibilityMetadata: companySkillCompatibilityMetadataSchema.nullable(),
  fileInventory: z.array(companySkillFileInventoryEntrySchema).default([]),
  metadata: z.record(z.unknown()).nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export const companySkillListItemSchema = companySkillSchema.extend({
  attachedAgentCount: z.number().int().nonnegative(),
  editable: z.boolean(),
  editableReason: z.string().nullable(),
  sourceLabel: z.string().nullable(),
  sourceBadge: companySkillSourceBadgeSchema,
  sourcePath: z.string().nullable(),
});

export const globalSkillCatalogItemSchema = z.object({
  catalogKey: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable(),
  sourceRoot: globalSkillCatalogSourceRootSchema,
  sourcePath: z.string().min(1),
  trustLevel: companySkillTrustLevelSchema,
  compatibility: companySkillCompatibilitySchema,
  manifestVersion: z.number().int().positive(),
  identityDigest: z.string().min(1),
  contentDigest: z.string().min(1),
  verificationState: companySkillVerificationStateSchema,
  compatibilityMetadata: companySkillCompatibilityMetadataSchema.nullable(),
  fileInventory: z.array(companySkillFileInventoryEntrySchema).default([]),
  installedSkillId: z.string().uuid().nullable(),
  installedSkillKey: z.string().nullable(),
});

export const companySkillUsageAgentSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  urlKey: z.string().min(1),
  adapterType: z.string().min(1),
  desired: z.boolean(),
  actualState: z.string().nullable(),
});

export const companySkillDetailSchema = companySkillSchema.extend({
  attachedAgentCount: z.number().int().nonnegative(),
  usedByAgents: z.array(companySkillUsageAgentSchema).default([]),
  editable: z.boolean(),
  editableReason: z.string().nullable(),
  sourceLabel: z.string().nullable(),
  sourceBadge: companySkillSourceBadgeSchema,
  sourcePath: z.string().nullable(),
  reliabilityMetadata: skillReliabilityMetadataSchema.nullable(),
  reliabilityParseWarnings: z.array(z.string()).default([]),
  linkedHardeningIssue: companySkillLinkedIssueSummarySchema.nullable(),
  linkedProposal: companySkillLinkedProposalSummarySchema.nullable(),
  hardeningState: companySkillHardeningStateSchema.nullable(),
});

export const companySkillUpdateStatusSchema = z.object({
  supported: z.boolean(),
  reason: z.string().nullable(),
  trackingRef: z.string().nullable(),
  currentRef: z.string().nullable(),
  latestRef: z.string().nullable(),
  hasUpdate: z.boolean(),
});

export const companySkillImportSchema = z.object({
  source: z.string().min(1),
});

export const companySkillInstallGlobalSchema = z.object({
  catalogKey: z.string().min(1),
});

export const companySkillInstallGlobalAllSkippedSchema = z.object({
  catalogKey: z.string().min(1),
  name: z.string().min(1),
  sourceRoot: globalSkillCatalogSourceRootSchema,
  reason: z.string().min(1),
  conflictingSkillId: z.string().uuid().nullable(),
  conflictingSkillKey: z.string().nullable(),
});

export const companySkillInstallGlobalAllResultSchema = z.object({
  discoverableCount: z.number().int().nonnegative(),
  installedCount: z.number().int().nonnegative(),
  alreadyInstalledCount: z.number().int().nonnegative(),
  skipped: z.array(companySkillInstallGlobalAllSkippedSchema),
  installed: z.array(companySkillSchema),
});

export const bulkSkillGrantTierSchema = z.enum(["all", "leaders", "workers"]);
export const bulkSkillGrantModeSchema = z.enum(["add", "remove", "replace"]);
export const bulkSkillGrantTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("department"),
    departmentKey: z.string().min(1),
  }),
  z.object({
    kind: z.literal("project"),
    projectId: z.string().uuid(),
  }),
]);

export const bulkSkillGrantTargetSummarySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("department"),
    departmentKey: z.string().min(1),
    label: z.string().min(1),
  }),
  z.object({
    kind: z.literal("project"),
    projectId: z.string().uuid(),
    label: z.string().min(1),
  }),
]);

export const bulkSkillGrantRequestSchema = z.object({
  target: bulkSkillGrantTargetSchema,
  tier: bulkSkillGrantTierSchema,
  mode: bulkSkillGrantModeSchema,
});

export const bulkSkillGrantApplyRequestSchema = bulkSkillGrantRequestSchema.extend({
  selectionFingerprint: z.string().min(1),
});

export const bulkSkillGrantSkippedAgentSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  reason: z.string().min(1),
});

export const bulkSkillGrantPreviewAgentSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  urlKey: z.string().min(1),
  role: z.string().min(1),
  title: z.string().nullable(),
  currentDesiredSkills: z.array(z.string().min(1)),
  nextDesiredSkills: z.array(z.string().min(1)),
  change: z.enum(["unchanged", "add", "remove", "replace"]),
});

export const bulkSkillGrantPreviewSchema = z.object({
  skillId: z.string().uuid(),
  skillKey: z.string().min(1),
  skillName: z.string().min(1),
  target: bulkSkillGrantTargetSummarySchema,
  tier: bulkSkillGrantTierSchema,
  mode: bulkSkillGrantModeSchema,
  matchedAgentCount: z.number().int().nonnegative(),
  changedAgentCount: z.number().int().nonnegative(),
  addCount: z.number().int().nonnegative(),
  removeCount: z.number().int().nonnegative(),
  unchangedCount: z.number().int().nonnegative(),
  agents: z.array(bulkSkillGrantPreviewAgentSchema),
  skippedAgents: z.array(bulkSkillGrantSkippedAgentSchema),
  selectionFingerprint: z.string().min(1),
});

export const bulkSkillGrantResultSchema = z.object({
  skillId: z.string().uuid(),
  skillKey: z.string().min(1),
  skillName: z.string().min(1),
  target: bulkSkillGrantTargetSummarySchema,
  tier: bulkSkillGrantTierSchema,
  mode: bulkSkillGrantModeSchema,
  matchedAgentCount: z.number().int().nonnegative(),
  changedAgentCount: z.number().int().nonnegative(),
  addCount: z.number().int().nonnegative(),
  removeCount: z.number().int().nonnegative(),
  unchangedCount: z.number().int().nonnegative(),
  appliedAgentIds: z.array(z.string().uuid()),
  rollbackPerformed: z.boolean(),
  rollbackErrors: z.array(z.string()),
});

export const companySkillCoverageResolvedSkillSchema = z.object({
  slug: z.string().min(1),
  key: z.string().min(1).nullable(),
  name: z.string().min(1).nullable(),
  source: z.enum(["installed", "planned_import", "missing"]),
});

export const companySkillCoveragePlannedImportSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  sourcePath: z.string().min(1),
  expectedKey: z.string().min(1),
});

export const companySkillCoverageAuditAgentSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  urlKey: z.string().min(1),
  role: z.string().min(1),
  title: z.string().nullable(),
  operatingClass: z.string().min(1),
  archetypeKey: z.string().min(1),
  status: companySkillCoverageStatusSchema,
  repairable: z.boolean(),
  expectedSkillSlugs: z.array(z.string().min(1)),
  resolvedExpectedSkills: z.array(companySkillCoverageResolvedSkillSchema),
  requiredSkillKeys: z.array(z.string().min(1)),
  currentDesiredSkills: z.array(z.string().min(1)),
  nextDesiredSkills: z.array(z.string().min(1)),
  missingSkillSlugs: z.array(z.string().min(1)),
  ambiguousSkillSlugs: z.array(z.string().min(1)),
  preservedCustomSkillKeys: z.array(z.string().min(1)),
  note: z.string().nullable(),
});

export const companySkillCoverageAuditSchema = z.object({
  companyId: z.string().uuid(),
  auditedAgentCount: z.number().int().nonnegative(),
  coveredCount: z.number().int().nonnegative(),
  repairableGapCount: z.number().int().nonnegative(),
  nonrepairableGapCount: z.number().int().nonnegative(),
  customizedCount: z.number().int().nonnegative(),
  plannedImports: z.array(companySkillCoveragePlannedImportSchema),
  agents: z.array(companySkillCoverageAuditAgentSchema),
});

export const companySkillCoverageRepairPreviewSchema = companySkillCoverageAuditSchema.extend({
  changedAgentCount: z.number().int().nonnegative(),
  selectionFingerprint: z.string().min(1),
});

export const companySkillCoverageRepairApplyRequestSchema = z.object({
  selectionFingerprint: z.string().min(1),
});

export const companySkillCoverageRepairResultSchema = z.object({
  companyId: z.string().uuid(),
  changedAgentCount: z.number().int().nonnegative(),
  appliedAgentIds: z.array(z.string().uuid()),
  importedSkills: z.array(companySkillSchema),
  rollbackPerformed: z.boolean(),
  rollbackErrors: z.array(z.string()),
  selectionFingerprint: z.string().min(1),
  audit: companySkillCoverageAuditSchema,
});

export const companySkillReliabilityFindingSchema = z.object({
  code: z.string().min(1),
  severity: z.enum(["critical", "high", "medium", "low"]),
  message: z.string().min(1),
  repairable: z.boolean(),
  references: z.array(z.string().min(1)).default([]),
});

export const companySkillReliabilityAuditSkillSchema = z.object({
  skillId: z.string().uuid(),
  sharedSkillId: z.string().uuid().nullable(),
  key: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
  sourceType: companySkillSourceTypeSchema,
  attachedAgentCount: z.number().int().nonnegative(),
  managedLocalAgentCount: z.number().int().nonnegative(),
  externalOnlyUsage: z.boolean(),
  reliabilityMetadata: skillReliabilityMetadataSchema.nullable(),
  reliabilityParseWarnings: z.array(z.string()).default([]),
  status: companySkillReliabilityStatusSchema,
  findings: z.array(companySkillReliabilityFindingSchema).default([]),
  linkedHardeningIssue: companySkillLinkedIssueSummarySchema.nullable(),
  linkedProposal: companySkillLinkedProposalSummarySchema.nullable(),
  hardeningState: companySkillHardeningStateSchema.nullable(),
});

export const companySkillReliabilityAuditSchema = z.object({
  companyId: z.string().uuid(),
  auditedSkillCount: z.number().int().nonnegative(),
  healthyCount: z.number().int().nonnegative(),
  repairableGapCount: z.number().int().nonnegative(),
  needsReviewCount: z.number().int().nonnegative(),
  proposalStaleCount: z.number().int().nonnegative(),
  managedAdapterTypes: z.array(z.string().min(1)).default([]),
  skills: z.array(companySkillReliabilityAuditSkillSchema).default([]),
});

export const companySkillReliabilityRepairPreviewSchema = companySkillReliabilityAuditSchema.extend({
  changedSkillCount: z.number().int().nonnegative(),
  selectionFingerprint: z.string().min(1),
});

export const companySkillReliabilityRepairApplyRequestSchema = z.object({
  selectionFingerprint: z.string().min(1),
});

export const companySkillReliabilityRepairResultSchema = z.object({
  companyId: z.string().uuid(),
  changedSkillCount: z.number().int().nonnegative(),
  createdIssueIds: z.array(z.string().uuid()).default([]),
  refreshedIssueIds: z.array(z.string().uuid()).default([]),
  selectionFingerprint: z.string().min(1),
  audit: companySkillReliabilityAuditSchema,
});

export const companySkillReliabilitySweepModeSchema = z.enum(["report", "report_and_refresh"]);

export const companySkillReliabilitySweepRequestSchema = z.object({
  mode: companySkillReliabilitySweepModeSchema.default("report"),
});

export const companySkillReliabilitySweepResultSchema = z.object({
  companyId: z.string().uuid(),
  mode: companySkillReliabilitySweepModeSchema,
  createdIssueIds: z.array(z.string().uuid()).default([]),
  refreshedIssueIds: z.array(z.string().uuid()).default([]),
  audit: companySkillReliabilityAuditSchema,
});

export const companySkillProjectScanRequestSchema = z.object({
  projectIds: z.array(z.string().uuid()).optional(),
  workspaceIds: z.array(z.string().uuid()).optional(),
});

export const companySkillProjectScanSkippedSchema = z.object({
  projectId: z.string().uuid(),
  projectName: z.string().min(1),
  workspaceId: z.string().uuid().nullable(),
  workspaceName: z.string().nullable(),
  path: z.string().nullable(),
  reason: z.string().min(1),
});

export const companySkillProjectScanConflictSchema = z.object({
  slug: z.string().min(1),
  key: z.string().min(1),
  projectId: z.string().uuid(),
  projectName: z.string().min(1),
  workspaceId: z.string().uuid(),
  workspaceName: z.string().min(1),
  path: z.string().min(1),
  existingSkillId: z.string().uuid(),
  existingSkillKey: z.string().min(1),
  existingSourceLocator: z.string().nullable(),
  reason: z.string().min(1),
});

export const companySkillProjectScanResultSchema = z.object({
  scannedProjects: z.number().int().nonnegative(),
  scannedWorkspaces: z.number().int().nonnegative(),
  discovered: z.number().int().nonnegative(),
  imported: z.array(companySkillSchema),
  updated: z.array(companySkillSchema),
  skipped: z.array(companySkillProjectScanSkippedSchema),
  conflicts: z.array(companySkillProjectScanConflictSchema),
  warnings: z.array(z.string()),
});

export const companySkillCreateSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).nullable().optional(),
  description: z.string().nullable().optional(),
  markdown: z.string().nullable().optional(),
});

export const companySkillFileDetailSchema = z.object({
  skillId: z.string().uuid(),
  path: z.string().min(1),
  kind: z.enum(["skill", "markdown", "reference", "script", "asset", "other"]),
  content: z.string(),
  language: z.string().nullable(),
  markdown: z.boolean(),
  editable: z.boolean(),
});

export const companySkillFileUpdateSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});

export type CompanySkillImport = z.infer<typeof companySkillImportSchema>;
export type CompanySkillInstallGlobal = z.infer<typeof companySkillInstallGlobalSchema>;
export type CompanySkillInstallGlobalAllResult = z.infer<typeof companySkillInstallGlobalAllResultSchema>;
export type BulkSkillGrantRequest = z.infer<typeof bulkSkillGrantRequestSchema>;
export type BulkSkillGrantApplyRequest = z.infer<typeof bulkSkillGrantApplyRequestSchema>;
export type CompanySkillCoverageRepairApplyRequest = z.infer<typeof companySkillCoverageRepairApplyRequestSchema>;
export type CompanySkillReliabilityRepairApplyRequest = z.infer<typeof companySkillReliabilityRepairApplyRequestSchema>;
export type CompanySkillProjectScan = z.infer<typeof companySkillProjectScanRequestSchema>;
export type CompanySkillCreate = z.infer<typeof companySkillCreateSchema>;
export type CompanySkillFileUpdate = z.infer<typeof companySkillFileUpdateSchema>;
export type CompanySkillReliabilitySweepRequest = z.infer<typeof companySkillReliabilitySweepRequestSchema>;
