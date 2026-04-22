import type {
  AgentAdapterType,
  AgentCapabilityProfileKey,
  AgentDepartmentKey,
  AgentExecutionModel,
  AgentInstructionsBundleRole,
  AgentInstructionsRootPolicy,
  AgentMemoryOwnershipMode,
  AgentNavigationLayout,
  AgentOperatingClass,
  AgentOrgLevel,
  AgentProjectRole,
  AgentProjectScopeMode,
  PauseReason,
  AgentRole,
  AgentSecondaryRelationshipType,
  AgentStatus,
  AgentTemplateLifecycleStatus,
  ActorPrincipalKind,
  IssueContinuityHealth,
  IssueContinuityStatus,
  IssueStatus,
} from "../constants.js";
import type {
  CompanyMembership,
  PrincipalPermissionGrant,
} from "./access.js";

export interface AgentPermissions {
  canCreateAgents: boolean;
}

export type AgentInstructionsBundleMode = "managed" | "external";

export interface AgentInstructionsFileSummary {
  path: string;
  size: number;
  language: string;
  markdown: boolean;
  isEntryFile: boolean;
  editable: boolean;
  deprecated: boolean;
  virtual: boolean;
}

export interface AgentInstructionsFileDetail extends AgentInstructionsFileSummary {
  content: string;
}

export interface AgentInstructionsBundle {
  agentId: string;
  companyId: string;
  mode: AgentInstructionsBundleMode | null;
  bundleRole: AgentInstructionsBundleRole;
  rootPolicy: AgentInstructionsRootPolicy;
  memoryOwnership: AgentMemoryOwnershipMode;
  rootPath: string | null;
  managedRootPath: string;
  entryFile: string;
  resolvedEntryPath: string | null;
  editable: boolean;
  externalRootAllowed: boolean;
  warnings: string[];
  legacyPromptTemplateActive: boolean;
  legacyBootstrapPromptTemplateActive: boolean;
  files: AgentInstructionsFileSummary[];
}

export interface AgentAccessState {
  canAssignTasks: boolean;
  taskAssignSource: "explicit_grant" | "agent_creator" | "capability_profile" | "none";
  membership: CompanyMembership | null;
  grants: PrincipalPermissionGrant[];
}

export interface AgentChainOfCommandEntry {
  id: string;
  name: string;
  role: AgentRole;
  title: string | null;
  orgLevel: AgentOrgLevel;
  departmentKey: AgentDepartmentKey;
  departmentName: string | null;
}

export interface AgentHierarchyMemberSummary {
  id: string;
  name: string;
  urlKey: string;
  role: AgentRole;
  title: string | null;
  icon: string | null;
  status: AgentStatus;
  reportsTo: string | null;
  orgLevel: AgentOrgLevel;
  operatingClass?: AgentOperatingClass;
  capabilityProfileKey?: AgentCapabilityProfileKey;
  archetypeKey?: string | null;
  departmentKey: AgentDepartmentKey;
  departmentName: string | null;
}

export interface CompanyAgentHierarchyDepartment {
  key: AgentDepartmentKey;
  name: string;
  ownerExecutiveId: string | null;
  ownerExecutiveName: string | null;
  directors: AgentHierarchyMemberSummary[];
  staff: AgentHierarchyMemberSummary[];
}

export interface CompanyAgentHierarchyExecutiveGroup {
  executive: AgentHierarchyMemberSummary;
  departments: CompanyAgentHierarchyDepartment[];
}

export interface CompanyAgentHierarchyUnassigned {
  executives: AgentHierarchyMemberSummary[];
  directors: AgentHierarchyMemberSummary[];
  staff: AgentHierarchyMemberSummary[];
}

export interface CompanyAgentHierarchy {
  executives: CompanyAgentHierarchyExecutiveGroup[];
  unassigned: CompanyAgentHierarchyUnassigned;
}

export interface AgentTemplateSnapshot {
  name: string;
  role: AgentRole;
  title: string | null;
  icon: string | null;
  reportsTo: string | null;
  orgLevel: AgentOrgLevel;
  operatingClass: AgentOperatingClass;
  capabilityProfileKey: AgentCapabilityProfileKey;
  archetypeKey: string;
  departmentKey: AgentDepartmentKey;
  departmentName: string | null;
  capabilities: string | null;
  adapterType: AgentAdapterType | null;
  adapterConfig: Record<string, unknown>;
  runtimeConfig: Record<string, unknown>;
  budgetMonthlyCents: number;
  metadata: Record<string, unknown> | null;
  executionModel?: AgentExecutionModel | null;
  lifecycleStatus?: AgentTemplateLifecycleStatus | null;
  instructionsBody: string;
}

export interface AgentTemplate {
  id: string;
  companyId: string;
  name: string;
  role: AgentRole;
  operatingClass: AgentOperatingClass;
  capabilityProfileKey: AgentCapabilityProfileKey;
  archetypeKey: string;
  metadata: Record<string, unknown> | null;
  executionModel?: AgentExecutionModel | null;
  lifecycleStatus?: AgentTemplateLifecycleStatus | null;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

export interface AgentTemplateRevision {
  id: string;
  companyId: string;
  templateId: string;
  revisionNumber: number;
  snapshot: AgentTemplateSnapshot;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
}

export interface AgentTemplateImportPackRequest {
  rootPath?: string | null;
  files: Record<string, string>;
}

export interface AgentTemplateImportPackItem {
  path: string;
  template: AgentTemplate;
  revision: AgentTemplateRevision;
  created: boolean;
  revisionCreated: boolean;
}

export interface AgentTemplateImportPackResult {
  items: AgentTemplateImportPackItem[];
  warnings: string[];
}

export interface AgentProjectScope {
  id: string;
  companyId: string;
  agentId: string;
  projectId: string;
  scopeMode: AgentProjectScopeMode;
  projectRole: AgentProjectRole;
  isPrimary: boolean;
  teamFunctionKey?: string | null;
  teamFunctionLabel?: string | null;
  workstreamKey: string | null;
  workstreamLabel: string | null;
  grantedByPrincipalType: ActorPrincipalKind | null;
  grantedByPrincipalId: string | null;
  activeFrom: Date;
  activeTo: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentProjectPlacementInput {
  projectId: string;
  teamFunctionKey?: string | null;
  teamFunctionLabel?: string | null;
  workstreamKey?: string | null;
  workstreamLabel?: string | null;
  projectRole?: AgentProjectRole | null;
  scopeMode?: AgentProjectScopeMode | null;
  requestedReason?: string | null;
}

export interface AgentSecondaryRelationship {
  id: string;
  companyId: string;
  agentId: string;
  relatedAgentId: string;
  relationshipType: AgentSecondaryRelationshipType;
  createdByPrincipalType: ActorPrincipalKind | null;
  createdByPrincipalId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface OperatingHierarchyAgentSummary extends AgentHierarchyMemberSummary {
  operatingClass: AgentOperatingClass;
  capabilityProfileKey: AgentCapabilityProfileKey;
  archetypeKey: string;
}

export interface OperatingHierarchyProjectSummary {
  projectId: string;
  projectName: string;
  color: string | null;
  leadership: OperatingHierarchyAgentSummary[];
  workers: OperatingHierarchyAgentSummary[];
  consultants: OperatingHierarchyAgentSummary[];
}

export interface OperatingHierarchyPortfolioClusterSummary {
  clusterId: string;
  name: string;
  slug: string;
  summary: string | null;
  executiveSponsor: OperatingHierarchyAgentSummary | null;
  portfolioDirector: OperatingHierarchyAgentSummary | null;
  projects: OperatingHierarchyProjectSummary[];
}

export interface OperatingHierarchyDepartmentSummary {
  key: AgentDepartmentKey;
  name: string;
  leaders: OperatingHierarchyAgentSummary[];
  projects: OperatingHierarchyProjectSummary[];
}

export interface CompanyOperatingHierarchy {
  executiveOffice: OperatingHierarchyAgentSummary[];
  portfolioClusters?: OperatingHierarchyPortfolioClusterSummary[];
  projectPods: OperatingHierarchyProjectSummary[];
  sharedServices: OperatingHierarchyDepartmentSummary[];
  unassigned: OperatingHierarchyAgentSummary[];
}

export interface AccountabilityIssueOwnershipSummary {
  issueId: string;
  identifier: string | null;
  title: string;
  status: IssueStatus;
  continuityStatus: IssueContinuityStatus | null;
  continuityHealth: IssueContinuityHealth | null;
}

export interface AccountabilityAgentSummary extends OperatingHierarchyAgentSummary {
  activeIssueCount: number;
  blockedContinuityIssueCount: number;
  openReviewFindingsCount: number;
  returnedBranchCount: number;
  issues: AccountabilityIssueOwnershipSummary[];
}

export interface AccountabilityProjectNode {
  projectId: string | null;
  projectName: string;
  color: string | null;
  executiveSponsor: OperatingHierarchyAgentSummary | null;
  portfolioDirector: OperatingHierarchyAgentSummary | null;
  projectLead: OperatingHierarchyAgentSummary | null;
  leadership: OperatingHierarchyAgentSummary[];
  continuityOwners: AccountabilityAgentSummary[];
  executiveIssueOwners: AccountabilityAgentSummary[];
  sharedServices: OperatingHierarchyAgentSummary[];
  issueCounts: {
    active: number;
    blockedMissingDocs: number;
    staleProgress: number;
    invalidHandoff: number;
    openReviewFindings: number;
    returnedBranches: number;
    handoffPending: number;
  };
}

export interface CompanyAgentCompositionSummary {
  totalConfiguredAgents: number;
  activeContinuityOwners: number;
  activeGovernanceLeads: number;
  activeSharedServiceAgents: number;
  legacyAgents: number;
  inactiveAgents: number;
  simplificationCandidates: number;
}

export interface CompanyAgentAccountability {
  companyId: string;
  generatedAt: string;
  counts: CompanyAgentCompositionSummary;
  executiveOffice: OperatingHierarchyAgentSummary[];
  projects: AccountabilityProjectNode[];
  sharedServices: OperatingHierarchyDepartmentSummary[];
  unassigned: OperatingHierarchyAgentSummary[];
}

export type OrgSimplificationAction = "archive" | "reparent_reports" | "convert_shared_service";

export interface OrgSimplificationCandidate {
  agent: OperatingHierarchyAgentSummary;
  classification: "keep" | "merge" | "convert" | "archive";
  confidence: "high" | "medium" | "low";
  reasons: string[];
  activeIssueCount: number;
  directReportCount: number;
  recentRunCount: number;
  activeSharedServiceEngagementCount: number;
  activeGateCount: number;
  suggestedTargetAgentId: string | null;
  suggestedTargetName: string | null;
}

export interface CompanyOrgSimplificationReport {
  companyId: string;
  generatedAt: string;
  recommendedSteadyStateAgents: {
    min: number;
    max: number;
  };
  counts: CompanyAgentCompositionSummary;
  candidates: OrgSimplificationCandidate[];
}

export interface OrgSimplificationArchiveRequest {
  agentIds: string[];
  reason?: string | null;
}

export interface OrgSimplificationReparentReportsRequest {
  fromAgentIds: string[];
  targetAgentId: string;
  reason?: string | null;
}

export interface OrgSimplificationConvertSharedServiceRequest {
  agentIds: string[];
  reason?: string | null;
}

export interface OrgSimplificationActionResult {
  companyId: string;
  action: OrgSimplificationAction;
  affectedAgentIds: string[];
  report: CompanyOrgSimplificationReport;
}

export interface AgentNavigationTeamNode {
  key: string;
  label: string;
  leaders: OperatingHierarchyAgentSummary[];
  workers: OperatingHierarchyAgentSummary[];
}

export interface AgentNavigationProjectNode {
  projectId: string;
  projectName: string;
  color: string | null;
  leaders: OperatingHierarchyAgentSummary[];
  teams: AgentNavigationTeamNode[];
  workers: OperatingHierarchyAgentSummary[];
}

export interface AgentNavigationClusterNode {
  clusterId: string;
  name: string;
  slug: string;
  summary: string | null;
  executiveSponsor: OperatingHierarchyAgentSummary | null;
  portfolioDirector: OperatingHierarchyAgentSummary | null;
  projects: AgentNavigationProjectNode[];
}

export interface AgentNavigationDepartmentNode {
  key: AgentDepartmentKey | "shared_service";
  name: string;
  leaders: OperatingHierarchyAgentSummary[];
  clusters?: AgentNavigationClusterNode[];
  projects: AgentNavigationProjectNode[];
}

export interface CompanyAgentNavigation {
  layout: AgentNavigationLayout;
  executives: OperatingHierarchyAgentSummary[];
  departments: AgentNavigationDepartmentNode[];
  portfolioClusters?: AgentNavigationClusterNode[];
  projectPods: AgentNavigationProjectNode[];
  sharedServices: AgentNavigationDepartmentNode[];
  unassigned: OperatingHierarchyAgentSummary[];
}

export interface Agent {
  id: string;
  companyId: string;
  name: string;
  urlKey: string;
  role: AgentRole;
  title: string | null;
  icon: string | null;
  status: AgentStatus;
  reportsTo: string | null;
  orgLevel: AgentOrgLevel;
  templateId?: string | null;
  templateRevisionId?: string | null;
  operatingClass?: AgentOperatingClass;
  capabilityProfileKey?: AgentCapabilityProfileKey;
  archetypeKey?: string | null;
  departmentKey: AgentDepartmentKey;
  departmentName: string | null;
  capabilities: string | null;
  adapterType: AgentAdapterType;
  adapterConfig: Record<string, unknown>;
  runtimeConfig: Record<string, unknown>;
  budgetMonthlyCents: number;
  spentMonthlyCents: number;
  pauseReason: PauseReason | null;
  pausedAt: Date | null;
  permissions: AgentPermissions;
  requestedByPrincipalType?: ActorPrincipalKind | null;
  requestedByPrincipalId?: string | null;
  requestedForProjectId?: string | null;
  requestedReason?: string | null;
  lastHeartbeatAt: Date | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentDetail extends Agent {
  chainOfCommand: AgentChainOfCommandEntry[];
  access: AgentAccessState;
}

export interface AgentKeyCreated {
  id: string;
  name: string;
  token: string;
  createdAt: Date;
}

export interface AgentConfigRevision {
  id: string;
  companyId: string;
  agentId: string;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  source: string;
  rolledBackFromRevisionId: string | null;
  changedKeys: string[];
  beforeConfig: Record<string, unknown>;
  afterConfig: Record<string, unknown>;
  createdAt: Date;
}

export type AdapterEnvironmentCheckLevel = "info" | "warn" | "error";
export type AdapterEnvironmentTestStatus = "pass" | "warn" | "fail";

export interface AdapterEnvironmentCheck {
  code: string;
  level: AdapterEnvironmentCheckLevel;
  message: string;
  detail?: string | null;
  hint?: string | null;
}

export interface AdapterEnvironmentTestResult {
  adapterType: string;
  status: AdapterEnvironmentTestStatus;
  checks: AdapterEnvironmentCheck[];
  testedAt: string;
}
