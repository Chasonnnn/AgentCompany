import type { FeedbackDataSharingPreference } from "./feedback.js";
import type { CompanySkillTrustLevel } from "./company-skill.js";
import type { AssetRetentionClass } from "../constants.js";

export const DAILY_RETENTION_PRESETS = [3, 7, 14] as const;
export const WEEKLY_RETENTION_PRESETS = [1, 2, 4] as const;
export const MONTHLY_RETENTION_PRESETS = [1, 3, 6] as const;

export interface BackupRetentionPolicy {
  dailyDays: (typeof DAILY_RETENTION_PRESETS)[number];
  weeklyWeeks: (typeof WEEKLY_RETENTION_PRESETS)[number];
  monthlyMonths: (typeof MONTHLY_RETENTION_PRESETS)[number];
}

export const DEFAULT_BACKUP_RETENTION: BackupRetentionPolicy = {
  dailyDays: 7,
  weeklyWeeks: 4,
  monthlyMonths: 1,
};

export type EnterpriseUnsafeHostBehavior = "deny" | "allow_local_trusted";

export interface EnterprisePolicy {
  allowedExternalInstructionRoots: string[];
  allowedSkillSourceHosts: string[];
  maxSkillTrustLevel: CompanySkillTrustLevel;
  enforceAttachmentScanning: boolean;
  defaultAttachmentRetentionClass: AssetRetentionClass;
  unsafeHostBehavior: EnterpriseUnsafeHostBehavior;
  advisorsEnabled: boolean;
  disableSharedHostSkills: boolean;
}

export const DEFAULT_ENTERPRISE_POLICY: EnterprisePolicy = {
  allowedExternalInstructionRoots: [],
  allowedSkillSourceHosts: [],
  maxSkillTrustLevel: "markdown_only",
  enforceAttachmentScanning: true,
  defaultAttachmentRetentionClass: "evidence",
  unsafeHostBehavior: "deny",
  advisorsEnabled: false,
  disableSharedHostSkills: true,
};

export interface InstanceGeneralSettings {
  censorUsernameInLogs: boolean;
  keyboardShortcuts: boolean;
  feedbackDataSharingPreference: FeedbackDataSharingPreference;
  backupRetention: BackupRetentionPolicy;
  enterprisePolicy: EnterprisePolicy;
}

export interface InstanceExperimentalSettings {
  enableIsolatedWorkspaces: boolean;
  autoRestartDevServerWhenIdle: boolean;
}

export interface InstanceSettings {
  id: string;
  general: InstanceGeneralSettings;
  experimental: InstanceExperimentalSettings;
  createdAt: Date;
  updatedAt: Date;
}
