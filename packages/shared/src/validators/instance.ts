import { z } from "zod";
import { DEFAULT_FEEDBACK_DATA_SHARING_PREFERENCE } from "../types/feedback.js";
import {
  DAILY_RETENTION_PRESETS,
  WEEKLY_RETENTION_PRESETS,
  MONTHLY_RETENTION_PRESETS,
  DEFAULT_BACKUP_RETENTION,
  DEFAULT_ENTERPRISE_POLICY,
} from "../types/instance.js";
import { companySkillTrustLevelSchema } from "./company-skill.js";
import { feedbackDataSharingPreferenceSchema } from "./feedback.js";

function presetSchema<T extends readonly number[]>(presets: T, label: string) {
  return z.number().refine(
    (v): v is T[number] => (presets as readonly number[]).includes(v),
    { message: `${label} must be one of: ${presets.join(", ")}` },
  );
}

export const backupRetentionPolicySchema = z.object({
  dailyDays: presetSchema(DAILY_RETENTION_PRESETS, "dailyDays").default(DEFAULT_BACKUP_RETENTION.dailyDays),
  weeklyWeeks: presetSchema(WEEKLY_RETENTION_PRESETS, "weeklyWeeks").default(DEFAULT_BACKUP_RETENTION.weeklyWeeks),
  monthlyMonths: presetSchema(MONTHLY_RETENTION_PRESETS, "monthlyMonths").default(DEFAULT_BACKUP_RETENTION.monthlyMonths),
});

export const enterprisePolicySchema = z.object({
  allowedExternalInstructionRoots: z.array(z.string().trim().min(1)).default(
    DEFAULT_ENTERPRISE_POLICY.allowedExternalInstructionRoots,
  ),
  allowedSkillSourceHosts: z.array(z.string().trim().min(1)).default(
    DEFAULT_ENTERPRISE_POLICY.allowedSkillSourceHosts,
  ),
  maxSkillTrustLevel: companySkillTrustLevelSchema.default(DEFAULT_ENTERPRISE_POLICY.maxSkillTrustLevel),
  enforceAttachmentScanning: z.boolean().default(DEFAULT_ENTERPRISE_POLICY.enforceAttachmentScanning),
  defaultAttachmentRetentionClass: z.enum(["standard", "evidence", "company_brand", "temporary"]).default(
    DEFAULT_ENTERPRISE_POLICY.defaultAttachmentRetentionClass,
  ),
  unsafeHostBehavior: z.enum(["deny", "allow_local_trusted"]).default(
    DEFAULT_ENTERPRISE_POLICY.unsafeHostBehavior,
  ),
  advisorsEnabled: z.boolean().default(DEFAULT_ENTERPRISE_POLICY.advisorsEnabled),
  disableSharedHostSkills: z.boolean().default(DEFAULT_ENTERPRISE_POLICY.disableSharedHostSkills),
}).strict();

export const instanceGeneralSettingsSchema = z.object({
  censorUsernameInLogs: z.boolean().default(false),
  keyboardShortcuts: z.boolean().default(false),
  feedbackDataSharingPreference: feedbackDataSharingPreferenceSchema.default(
    DEFAULT_FEEDBACK_DATA_SHARING_PREFERENCE,
  ),
  backupRetention: backupRetentionPolicySchema.default(DEFAULT_BACKUP_RETENTION),
  enterprisePolicy: enterprisePolicySchema.default(DEFAULT_ENTERPRISE_POLICY),
}).strict();

export const patchInstanceGeneralSettingsSchema = instanceGeneralSettingsSchema.partial();

export const instanceExperimentalSettingsSchema = z.object({
  enableIsolatedWorkspaces: z.boolean().default(false),
  autoRestartDevServerWhenIdle: z.boolean().default(false),
}).strict();

export const patchInstanceExperimentalSettingsSchema = instanceExperimentalSettingsSchema.partial();

export type InstanceGeneralSettings = z.infer<typeof instanceGeneralSettingsSchema>;
export type PatchInstanceGeneralSettings = z.infer<typeof patchInstanceGeneralSettingsSchema>;
export type InstanceExperimentalSettings = z.infer<typeof instanceExperimentalSettingsSchema>;
export type PatchInstanceExperimentalSettings = z.infer<typeof patchInstanceExperimentalSettingsSchema>;
