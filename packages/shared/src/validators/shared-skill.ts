import { z } from "zod";
import {
  companySkillCompatibilitySchema,
  companySkillFileInventoryEntrySchema,
  skillVerificationMetadataSchema,
  companySkillTrustLevelSchema,
  globalSkillCatalogSourceRootSchema,
} from "./company-skill.js";

export const sharedSkillMirrorStateSchema = z.enum(["pristine", "paperclip_modified", "source_missing", "source_unreadable"]);
export const sharedSkillSourceDriftStateSchema = z.enum([
  "in_sync",
  "upstream_update_available",
  "diverged_needs_review",
  "source_missing",
  "source_unreadable",
]);
export const sharedSkillProposalKindSchema = z.enum(["self_improvement", "upstream_adoption", "merge_review"]);
export const sharedSkillProposalStatusSchema = z.enum(["pending", "revision_requested", "approved", "rejected", "superseded"]);
export const sharedSkillProposalChangeOpSchema = z.enum(["patch_text", "replace_file", "write_file", "remove_file"]);
export const sharedSkillMirrorSyncModeSchema = z.enum(["bootstrap", "refresh"]);

export const sharedSkillSchema = z.object({
  id: z.string().uuid(),
  key: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable(),
  markdown: z.string(),
  fileInventory: z.array(companySkillFileInventoryEntrySchema).default([]),
  trustLevel: companySkillTrustLevelSchema,
  compatibility: companySkillCompatibilitySchema,
  sourceRoot: globalSkillCatalogSourceRootSchema,
  sourcePath: z.string().min(1),
  sourceDigest: z.string().nullable(),
  lastMirroredSourceDigest: z.string().nullable(),
  mirrorDigest: z.string().nullable(),
  lastAppliedMirrorDigest: z.string().nullable(),
  mirrorState: sharedSkillMirrorStateSchema,
  sourceDriftState: sharedSkillSourceDriftStateSchema,
  metadata: z.record(z.unknown()).nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export const sharedSkillProposalChangeSchema = z.object({
  path: z.string().min(1),
  op: sharedSkillProposalChangeOpSchema,
  oldText: z.string().optional(),
  newText: z.string().optional(),
  content: z.string().optional(),
});

export const sharedSkillProposalEvidenceSchema = z.object({
  issueId: z.string().uuid().optional(),
  runId: z.string().uuid().optional(),
  note: z.string().optional(),
  failureFingerprint: z.string().min(1).optional(),
  reproductionSummary: z.string().min(1).optional(),
});

export const sharedSkillProposalVerificationResultsSchema = z.object({
  passedUnitCommands: z.array(z.string().min(1)).default([]),
  passedIntegrationCommands: z.array(z.string().min(1)).default([]),
  passedPromptfooCaseIds: z.array(z.string().min(1)).default([]),
  passedArchitectureScenarioIds: z.array(z.string().min(1)).default([]),
  completedSmokeChecklist: z.array(z.string().min(1)).default([]),
});

export const sharedSkillProposalPayloadSchema = z.object({
  changes: z.array(sharedSkillProposalChangeSchema),
  evidence: sharedSkillProposalEvidenceSchema,
  requiredVerification: skillVerificationMetadataSchema.nullable().optional(),
  verificationResults: sharedSkillProposalVerificationResultsSchema.nullable().optional(),
  upstreamDecision: z.enum(["adopt_source", "preserve_local", "merge_required"]).optional(),
});

export const sharedSkillProposalSchema = z.object({
  id: z.string().uuid(),
  sharedSkillId: z.string().uuid(),
  companyId: z.string().uuid().nullable(),
  issueId: z.string().uuid().nullable(),
  runId: z.string().uuid().nullable(),
  proposedByAgentId: z.string().uuid().nullable(),
  proposedByUserId: z.string().nullable(),
  kind: sharedSkillProposalKindSchema,
  status: sharedSkillProposalStatusSchema,
  summary: z.string().min(1),
  rationale: z.string().min(1),
  baseMirrorDigest: z.string().nullable(),
  baseSourceDigest: z.string().nullable(),
  proposalFingerprint: z.string().min(1),
  payload: sharedSkillProposalPayloadSchema,
  decisionNote: z.string().nullable(),
  decidedByUserId: z.string().nullable(),
  decidedAt: z.coerce.date().nullable(),
  appliedMirrorDigest: z.string().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export const sharedSkillProposalCommentSchema = z.object({
  id: z.string().uuid(),
  proposalId: z.string().uuid(),
  authorAgentId: z.string().uuid().nullable(),
  authorUserId: z.string().nullable(),
  body: z.string().min(1),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export const sharedSkillProposalSummarySchema = z.object({
  id: z.string().uuid(),
  kind: sharedSkillProposalKindSchema,
  status: sharedSkillProposalStatusSchema,
  summary: z.string().min(1),
  createdAt: z.string().min(1),
});

export const sharedSkillRuntimeContextSchema = z.object({
  sharedSkillId: z.string().uuid(),
  key: z.string().min(1),
  name: z.string().min(1),
  mirrorState: sharedSkillMirrorStateSchema,
  sourceDriftState: sharedSkillSourceDriftStateSchema,
  proposalAllowed: z.boolean(),
  applyAllowed: z.literal(false),
  openProposal: sharedSkillProposalSummarySchema.nullable(),
});

export const sharedSkillMirrorSyncRequestSchema = z.object({
  mode: sharedSkillMirrorSyncModeSchema,
  sourceRoots: z.array(globalSkillCatalogSourceRootSchema).optional(),
});

export const sharedSkillMirrorSyncItemSchema = z.object({
  sharedSkillId: z.string().uuid(),
  key: z.string().min(1),
  name: z.string().min(1),
  sourceRoot: globalSkillCatalogSourceRootSchema,
  sourcePath: z.string().min(1),
  action: z.enum(["bootstrapped", "updated_pristine_mirror", "classified_only", "unchanged"]),
  mirrorState: sharedSkillMirrorStateSchema,
  sourceDriftState: sharedSkillSourceDriftStateSchema,
});

export const sharedSkillMirrorSyncResultSchema = z.object({
  mode: sharedSkillMirrorSyncModeSchema,
  totalCount: z.number().int().nonnegative(),
  bootstrappedCount: z.number().int().nonnegative(),
  updatedCount: z.number().int().nonnegative(),
  unchangedCount: z.number().int().nonnegative(),
  classifiedCount: z.number().int().nonnegative(),
  items: z.array(sharedSkillMirrorSyncItemSchema),
});

export const sharedSkillProposalCreateSchema = z.object({
  kind: sharedSkillProposalKindSchema,
  summary: z.string().min(1),
  rationale: z.string().min(1),
  baseMirrorDigest: z.string().nullable(),
  baseSourceDigest: z.string().nullable(),
  changes: z.array(sharedSkillProposalChangeSchema),
  evidence: sharedSkillProposalEvidenceSchema,
  requiredVerification: skillVerificationMetadataSchema.nullable().optional(),
  verificationResults: sharedSkillProposalVerificationResultsSchema.nullable().optional(),
  upstreamDecision: z.enum(["adopt_source", "preserve_local", "merge_required"]).optional(),
});

export const sharedSkillProposalDecisionSchema = z.object({
  decisionNote: z.string().nullable().optional(),
});

export const sharedSkillProposalVerificationUpdateSchema = z.object({
  passedUnitCommands: z.array(z.string().min(1)).optional(),
  passedIntegrationCommands: z.array(z.string().min(1)).optional(),
  passedPromptfooCaseIds: z.array(z.string().min(1)).optional(),
  passedArchitectureScenarioIds: z.array(z.string().min(1)).optional(),
  completedSmokeChecklist: z.array(z.string().min(1)).optional(),
});

export const sharedSkillProposalCommentCreateSchema = z.object({
  body: z.string().min(1),
});

export type SharedSkillMirrorSyncRequest = z.infer<typeof sharedSkillMirrorSyncRequestSchema>;
export type SharedSkillProposalCreate = z.infer<typeof sharedSkillProposalCreateSchema>;
export type SharedSkillProposalDecision = z.infer<typeof sharedSkillProposalDecisionSchema>;
export type SharedSkillProposalCommentCreate = z.infer<typeof sharedSkillProposalCommentCreateSchema>;
export type SharedSkillProposalVerificationUpdate = z.infer<typeof sharedSkillProposalVerificationUpdateSchema>;
