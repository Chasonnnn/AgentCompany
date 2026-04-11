import type { AgentDepartmentKey, AgentRole } from "../constants.js";

export type CompanySkillSourceType = "local_path" | "github" | "url" | "catalog" | "skills_sh";

export type CompanySkillTrustLevel = "markdown_only" | "assets" | "scripts_executables";

export type CompanySkillCompatibility = "compatible" | "unknown" | "invalid";

export type CompanySkillSourceBadge = "paperclip" | "github" | "local" | "url" | "catalog" | "skills_sh";

export type GlobalSkillCatalogSourceRoot = "codex" | "claude" | "agents";
export type BulkSkillGrantTier = "all" | "leaders" | "workers";
export type BulkSkillGrantMode = "add" | "remove" | "replace";

export interface CompanySkillFileInventoryEntry {
  path: string;
  kind: "skill" | "markdown" | "reference" | "script" | "asset" | "other";
}

export interface CompanySkill {
  id: string;
  companyId: string;
  key: string;
  slug: string;
  name: string;
  description: string | null;
  markdown: string;
  sourceType: CompanySkillSourceType;
  sourceLocator: string | null;
  sourceRef: string | null;
  trustLevel: CompanySkillTrustLevel;
  compatibility: CompanySkillCompatibility;
  fileInventory: CompanySkillFileInventoryEntry[];
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CompanySkillListItem {
  id: string;
  companyId: string;
  key: string;
  slug: string;
  name: string;
  description: string | null;
  sourceType: CompanySkillSourceType;
  sourceLocator: string | null;
  sourceRef: string | null;
  trustLevel: CompanySkillTrustLevel;
  compatibility: CompanySkillCompatibility;
  fileInventory: CompanySkillFileInventoryEntry[];
  createdAt: Date;
  updatedAt: Date;
  attachedAgentCount: number;
  editable: boolean;
  editableReason: string | null;
  sourceLabel: string | null;
  sourceBadge: CompanySkillSourceBadge;
  sourcePath: string | null;
}

export interface GlobalSkillCatalogItem {
  catalogKey: string;
  slug: string;
  name: string;
  description: string | null;
  sourceRoot: GlobalSkillCatalogSourceRoot;
  sourcePath: string;
  trustLevel: CompanySkillTrustLevel;
  compatibility: CompanySkillCompatibility;
  fileInventory: CompanySkillFileInventoryEntry[];
  installedSkillId: string | null;
  installedSkillKey: string | null;
}

export interface CompanySkillUsageAgent {
  id: string;
  name: string;
  urlKey: string;
  adapterType: string;
  desired: boolean;
  actualState: string | null;
}

export interface CompanySkillDetail extends CompanySkill {
  attachedAgentCount: number;
  usedByAgents: CompanySkillUsageAgent[];
  editable: boolean;
  editableReason: string | null;
  sourceLabel: string | null;
  sourceBadge: CompanySkillSourceBadge;
  sourcePath: string | null;
}

export interface CompanySkillUpdateStatus {
  supported: boolean;
  reason: string | null;
  trackingRef: string | null;
  currentRef: string | null;
  latestRef: string | null;
  hasUpdate: boolean;
}

export interface CompanySkillImportRequest {
  source: string;
}

export interface CompanySkillInstallGlobalRequest {
  catalogKey: string;
}

export interface CompanySkillInstallGlobalAllSkipped {
  catalogKey: string;
  name: string;
  sourceRoot: GlobalSkillCatalogSourceRoot;
  reason: string;
  conflictingSkillId: string | null;
  conflictingSkillKey: string | null;
}

export interface CompanySkillInstallGlobalAllResult {
  discoverableCount: number;
  installedCount: number;
  alreadyInstalledCount: number;
  skipped: CompanySkillInstallGlobalAllSkipped[];
  installed: CompanySkill[];
}

export type BulkSkillGrantTarget =
  | {
    kind: "department";
    departmentKey: AgentDepartmentKey;
  }
  | {
    kind: "project";
    projectId: string;
  };

export type BulkSkillGrantTargetSummary =
  | {
    kind: "department";
    departmentKey: AgentDepartmentKey;
    label: string;
  }
  | {
    kind: "project";
    projectId: string;
    label: string;
  };

export interface BulkSkillGrantRequest {
  target: BulkSkillGrantTarget;
  tier: BulkSkillGrantTier;
  mode: BulkSkillGrantMode;
}

export interface BulkSkillGrantApplyRequest extends BulkSkillGrantRequest {
  selectionFingerprint: string;
}

export interface BulkSkillGrantSkippedAgent {
  id: string;
  name: string;
  reason: string;
}

export interface BulkSkillGrantPreviewAgent {
  id: string;
  name: string;
  urlKey: string;
  role: AgentRole;
  title: string | null;
  currentDesiredSkills: string[];
  nextDesiredSkills: string[];
  change: "unchanged" | "add" | "remove" | "replace";
}

export interface BulkSkillGrantPreview {
  skillId: string;
  skillKey: string;
  skillName: string;
  target: BulkSkillGrantTargetSummary;
  tier: BulkSkillGrantTier;
  mode: BulkSkillGrantMode;
  matchedAgentCount: number;
  changedAgentCount: number;
  addCount: number;
  removeCount: number;
  unchangedCount: number;
  agents: BulkSkillGrantPreviewAgent[];
  skippedAgents: BulkSkillGrantSkippedAgent[];
  selectionFingerprint: string;
}

export interface BulkSkillGrantResult {
  skillId: string;
  skillKey: string;
  skillName: string;
  target: BulkSkillGrantTargetSummary;
  tier: BulkSkillGrantTier;
  mode: BulkSkillGrantMode;
  matchedAgentCount: number;
  changedAgentCount: number;
  addCount: number;
  removeCount: number;
  unchangedCount: number;
  appliedAgentIds: string[];
  rollbackPerformed: boolean;
  rollbackErrors: string[];
}

export interface CompanySkillImportResult {
  imported: CompanySkill[];
  warnings: string[];
}

export interface CompanySkillProjectScanRequest {
  projectIds?: string[];
  workspaceIds?: string[];
}

export interface CompanySkillProjectScanSkipped {
  projectId: string;
  projectName: string;
  workspaceId: string | null;
  workspaceName: string | null;
  path: string | null;
  reason: string;
}

export interface CompanySkillProjectScanConflict {
  slug: string;
  key: string;
  projectId: string;
  projectName: string;
  workspaceId: string;
  workspaceName: string;
  path: string;
  existingSkillId: string;
  existingSkillKey: string;
  existingSourceLocator: string | null;
  reason: string;
}

export interface CompanySkillProjectScanResult {
  scannedProjects: number;
  scannedWorkspaces: number;
  discovered: number;
  imported: CompanySkill[];
  updated: CompanySkill[];
  skipped: CompanySkillProjectScanSkipped[];
  conflicts: CompanySkillProjectScanConflict[];
  warnings: string[];
}

export interface CompanySkillCreateRequest {
  name: string;
  slug?: string | null;
  description?: string | null;
  markdown?: string | null;
}

export interface CompanySkillFileDetail {
  skillId: string;
  path: string;
  kind: CompanySkillFileInventoryEntry["kind"];
  content: string;
  language: string | null;
  markdown: boolean;
  editable: boolean;
}

export interface CompanySkillFileUpdateRequest {
  path: string;
  content: string;
}
