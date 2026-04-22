import { z } from "zod";

export const agentSkillStateSchema = z.enum([
  "available",
  "configured",
  "installed",
  "missing",
  "stale",
  "external",
  "blocked",
]);

export const agentSkillOriginSchema = z.enum([
  "company_managed",
  "paperclip_required",
  "user_installed",
  "external_unknown",
]);

export const agentSkillSyncModeSchema = z.enum([
  "unsupported",
  "persistent",
  "ephemeral",
]);

export const agentSkillEntrySchema = z.object({
  key: z.string().min(1),
  companySkillId: z.string().uuid().nullable().optional(),
  runtimeName: z.string().min(1).nullable(),
  desired: z.boolean(),
  managed: z.boolean(),
  required: z.boolean().optional(),
  requiredReason: z.string().nullable().optional(),
  trustLevel: z.enum(["markdown_only", "assets", "scripts_executables"]).nullable().optional(),
  compatibility: z.enum(["compatible", "unknown", "invalid"]).nullable().optional(),
  state: agentSkillStateSchema,
  origin: agentSkillOriginSchema.optional(),
  originLabel: z.string().nullable().optional(),
  locationLabel: z.string().nullable().optional(),
  readOnly: z.boolean().optional(),
  sourcePath: z.string().nullable().optional(),
  targetPath: z.string().nullable().optional(),
  detail: z.string().nullable().optional(),
});

export const agentSkillSnapshotSchema = z.object({
  adapterType: z.string().min(1),
  supported: z.boolean(),
  mode: agentSkillSyncModeSchema,
  canManage: z.boolean().optional(),
  desiredSkills: z.array(z.string().min(1)),
  desiredSkillIds: z.array(z.string().uuid()).optional(),
  entries: z.array(agentSkillEntrySchema),
  warnings: z.array(z.string()),
});

export const agentSkillSyncSchema = z.object({
  desiredSkills: z.array(z.string().min(1)).optional(),
  desiredSkillIds: z.array(z.string().uuid()).optional(),
}).refine((value) => Array.isArray(value.desiredSkillIds) || Array.isArray(value.desiredSkills), {
  message: "desiredSkillIds or desiredSkills is required",
});

export type AgentSkillSync = z.infer<typeof agentSkillSyncSchema>;
