import { z } from "zod";

export const companySkillSourceTypeSchema = z.enum(["local_path", "github", "url", "catalog", "skills_sh"]);
export const companySkillTrustLevelSchema = z.enum(["markdown_only", "assets", "scripts_executables"]);
export const companySkillCompatibilitySchema = z.enum(["compatible", "unknown", "invalid"]);
export const companySkillSourceBadgeSchema = z.enum(["paperclip", "github", "local", "url", "catalog", "skills_sh"]);
export const globalSkillCatalogSourceRootSchema = z.enum(["codex", "claude", "agents"]);

export const companySkillFileInventoryEntrySchema = z.object({
  path: z.string().min(1),
  kind: z.enum(["skill", "markdown", "reference", "script", "asset", "other"]),
});

export const companySkillSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
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
export type CompanySkillProjectScan = z.infer<typeof companySkillProjectScanRequestSchema>;
export type CompanySkillCreate = z.infer<typeof companySkillCreateSchema>;
export type CompanySkillFileUpdate = z.infer<typeof companySkillFileUpdateSchema>;
