import { z } from "zod";
import {
  ACTOR_PRINCIPAL_KINDS,
  AGENT_CAPABILITY_PROFILE_KEYS,
  AGENT_DEPARTMENT_KEYS,
  AGENT_EXECUTION_MODELS,
  AGENT_ICON_NAMES,
  AGENT_NAVIGATION_LAYOUTS,
  AGENT_ORG_LEVELS,
  AGENT_OPERATING_CLASSES,
  AGENT_PROJECT_ROLES,
  AGENT_PROJECT_SCOPE_MODES,
  AGENT_ROLES,
  AGENT_SECONDARY_RELATIONSHIP_TYPES,
  AGENT_STATUSES,
  AGENT_TEMPLATE_LIFECYCLE_STATUSES,
  INBOX_MINE_ISSUE_STATUS_FILTER,
  ISSUE_STATUSES,
} from "../constants.js";
import { agentAdapterTypeSchema, optionalAgentAdapterTypeSchema } from "../adapter-type.js";
import type {
  AccountabilityAgentSummary,
  AccountabilityIssueOwnershipSummary,
  AccountabilityProjectNode,
  AgentHierarchyMemberSummary,
  CompanyAgentCompositionSummary,
  AgentTemplateImportPackItem,
  AgentTemplateImportPackRequest,
  AgentTemplateImportPackResult,
  AgentNavigationDepartmentNode,
  AgentNavigationClusterNode,
  AgentNavigationProjectNode,
  AgentNavigationTeamNode,
  AgentProjectPlacementInput,
  AgentProjectScope,
  AgentSecondaryRelationship,
  AgentTemplate,
  AgentTemplateRevision,
  AgentTemplateSnapshot,
  CompanyAgentAccountability,
  CompanyOrgSimplificationReport,
  CompanyAgentNavigation,
  CompanyAgentHierarchy,
  CompanyAgentHierarchyDepartment,
  CompanyAgentHierarchyExecutiveGroup,
  CompanyAgentHierarchyUnassigned,
  OrgSimplificationAction,
  OrgSimplificationActionResult,
  OrgSimplificationArchiveRequest,
  OrgSimplificationCandidate,
  OrgSimplificationConvertSharedServiceRequest,
  OrgSimplificationReparentReportsRequest,
  CompanyOperatingHierarchy,
  OperatingHierarchyAgentSummary,
  OperatingHierarchyDepartmentSummary,
  OperatingHierarchyPortfolioClusterSummary,
  OperatingHierarchyProjectSummary,
} from "../types/agent.js";
import {
  issueContinuityHealthSchema,
  issueContinuityStatusSchema,
} from "./issue.js";
import { envConfigSchema } from "./secret.js";

export const agentPermissionsSchema = z.object({
  canCreateAgents: z.boolean().optional().default(false),
});

export const agentInstructionsBundleModeSchema = z.enum(["managed", "external"]);

export const updateAgentInstructionsBundleSchema = z.object({
  mode: agentInstructionsBundleModeSchema.optional(),
  rootPath: z.string().trim().min(1).nullable().optional(),
  entryFile: z.string().trim().min(1).optional(),
  clearLegacyPromptTemplate: z.boolean().optional().default(false),
});

export type UpdateAgentInstructionsBundle = z.infer<typeof updateAgentInstructionsBundleSchema>;

export const upsertAgentInstructionsFileSchema = z.object({
  path: z.string().trim().min(1),
  content: z.string(),
  clearLegacyPromptTemplate: z.boolean().optional().default(false),
});

export type UpsertAgentInstructionsFile = z.infer<typeof upsertAgentInstructionsFileSchema>;

const adapterConfigSchema = z.record(z.unknown()).superRefine((value, ctx) => {
  const envValue = value.env;
  if (envValue === undefined) return;
  const parsed = envConfigSchema.safeParse(envValue);
  if (!parsed.success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "adapterConfig.env must be a map of valid env bindings",
      path: ["env"],
    });
  }
});

export const agentOrgLevelSchema = z.enum(AGENT_ORG_LEVELS);
export const agentOperatingClassSchema = z.enum(AGENT_OPERATING_CLASSES);
export const agentCapabilityProfileKeySchema = z.union([
  z.enum(AGENT_CAPABILITY_PROFILE_KEYS),
  z.string().trim().min(1),
]);
export const agentDepartmentKeySchema = z.enum(AGENT_DEPARTMENT_KEYS);
export const agentProjectScopeModeSchema = z.enum(AGENT_PROJECT_SCOPE_MODES);
export const agentProjectRoleSchema = z.enum(AGENT_PROJECT_ROLES);
export const agentSecondaryRelationshipTypeSchema = z.enum(AGENT_SECONDARY_RELATIONSHIP_TYPES);
export const agentNavigationLayoutSchema = z.enum(AGENT_NAVIGATION_LAYOUTS);
export const actorPrincipalKindSchema = z.enum(ACTOR_PRINCIPAL_KINDS);
export const agentExecutionModelSchema = z.enum(AGENT_EXECUTION_MODELS);
export const agentTemplateLifecycleStatusSchema = z.enum(AGENT_TEMPLATE_LIFECYCLE_STATUSES);

export const agentHierarchyMemberSummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  urlKey: z.string().min(1),
  role: z.enum(AGENT_ROLES),
  title: z.string().nullable(),
  icon: z.enum(AGENT_ICON_NAMES).nullable(),
  status: z.enum(AGENT_STATUSES),
  reportsTo: z.string().uuid().nullable(),
  orgLevel: agentOrgLevelSchema,
  operatingClass: agentOperatingClassSchema.optional(),
  capabilityProfileKey: agentCapabilityProfileKeySchema.optional(),
  archetypeKey: z.string().trim().min(1).nullable().optional(),
  departmentKey: agentDepartmentKeySchema,
  departmentName: z.string().nullable(),
}).strict() satisfies z.ZodType<AgentHierarchyMemberSummary>;

export const agentTemplateSnapshotSchema = z.object({
  name: z.string().min(1),
  role: z.enum(AGENT_ROLES),
  title: z.string().nullable(),
  icon: z.enum(AGENT_ICON_NAMES).nullable(),
  reportsTo: z.string().uuid().nullable(),
  orgLevel: agentOrgLevelSchema,
  operatingClass: agentOperatingClassSchema,
  capabilityProfileKey: agentCapabilityProfileKeySchema,
  archetypeKey: z.string().trim().min(1),
  departmentKey: agentDepartmentKeySchema,
  departmentName: z.string().nullable(),
  capabilities: z.string().nullable(),
  adapterType: agentAdapterTypeSchema.nullable(),
  adapterConfig: adapterConfigSchema,
  runtimeConfig: z.record(z.unknown()),
  budgetMonthlyCents: z.number().int().nonnegative(),
  metadata: z.record(z.unknown()).nullable(),
  executionModel: agentExecutionModelSchema.nullable().optional(),
  lifecycleStatus: agentTemplateLifecycleStatusSchema.nullable().optional(),
  instructionsBody: z.string(),
}).strict();

export const agentTemplateSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  name: z.string().min(1),
  role: z.enum(AGENT_ROLES),
  operatingClass: agentOperatingClassSchema,
  capabilityProfileKey: agentCapabilityProfileKeySchema,
  archetypeKey: z.string().trim().min(1),
  metadata: z.record(z.unknown()).nullable(),
  executionModel: agentExecutionModelSchema.nullable().optional(),
  lifecycleStatus: agentTemplateLifecycleStatusSchema.nullable().optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  archivedAt: z.coerce.date().nullable(),
}).strict() satisfies z.ZodType<AgentTemplate>;

export const agentTemplateRevisionSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  templateId: z.string().uuid(),
  revisionNumber: z.number().int().positive(),
  snapshot: agentTemplateSnapshotSchema,
  createdByAgentId: z.string().uuid().nullable(),
  createdByUserId: z.string().nullable(),
  createdAt: z.coerce.date(),
}).strict();

export const agentTemplateImportPackRequestSchema = z.object({
  rootPath: z.string().trim().min(1).nullable().optional(),
  files: z.record(z.string()),
}).strict() satisfies z.ZodType<AgentTemplateImportPackRequest>;

export const agentTemplateImportPackItemSchema = z.object({
  path: z.string().min(1),
  template: agentTemplateSchema,
  revision: agentTemplateRevisionSchema,
  created: z.boolean(),
  revisionCreated: z.boolean(),
}).strict();

export const agentTemplateImportPackResultSchema = z.object({
  items: z.array(agentTemplateImportPackItemSchema),
  warnings: z.array(z.string()),
}).strict();

export const agentProjectScopeSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  agentId: z.string().uuid(),
  projectId: z.string().uuid(),
  scopeMode: agentProjectScopeModeSchema,
  projectRole: agentProjectRoleSchema,
  isPrimary: z.boolean(),
  teamFunctionKey: z.string().nullable().optional(),
  teamFunctionLabel: z.string().nullable().optional(),
  workstreamKey: z.string().nullable(),
  workstreamLabel: z.string().nullable(),
  grantedByPrincipalType: actorPrincipalKindSchema.nullable(),
  grantedByPrincipalId: z.string().nullable(),
  activeFrom: z.coerce.date(),
  activeTo: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
}).strict() satisfies z.ZodType<AgentProjectScope>;

export const agentProjectPlacementInputSchema = z.object({
  projectId: z.string().uuid(),
  teamFunctionKey: z.string().trim().min(1).optional().nullable(),
  teamFunctionLabel: z.string().trim().min(1).optional().nullable(),
  workstreamKey: z.string().trim().min(1).optional().nullable(),
  workstreamLabel: z.string().trim().min(1).optional().nullable(),
  projectRole: agentProjectRoleSchema.optional().nullable(),
  scopeMode: agentProjectScopeModeSchema.optional().nullable(),
  requestedReason: z.string().trim().min(1).optional().nullable(),
}).strict() satisfies z.ZodType<AgentProjectPlacementInput>;

export const agentSecondaryRelationshipSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  agentId: z.string().uuid(),
  relatedAgentId: z.string().uuid(),
  relationshipType: agentSecondaryRelationshipTypeSchema,
  createdByPrincipalType: actorPrincipalKindSchema.nullable(),
  createdByPrincipalId: z.string().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
}).strict() satisfies z.ZodType<AgentSecondaryRelationship>;

export const operatingHierarchyAgentSummarySchema = agentHierarchyMemberSummarySchema.extend({
  operatingClass: agentOperatingClassSchema,
  capabilityProfileKey: agentCapabilityProfileKeySchema,
  archetypeKey: z.string().trim().min(1),
}).strict() satisfies z.ZodType<OperatingHierarchyAgentSummary>;

export const operatingHierarchyProjectSummarySchema = z.object({
  projectId: z.string().uuid(),
  projectName: z.string().min(1),
  color: z.string().nullable(),
  leadership: z.array(operatingHierarchyAgentSummarySchema),
  workers: z.array(operatingHierarchyAgentSummarySchema),
  consultants: z.array(operatingHierarchyAgentSummarySchema),
}).strict() satisfies z.ZodType<OperatingHierarchyProjectSummary>;

export const operatingHierarchyPortfolioClusterSummarySchema = z.object({
  clusterId: z.string().uuid(),
  name: z.string().min(1),
  slug: z.string().min(1),
  summary: z.string().nullable(),
  executiveSponsor: operatingHierarchyAgentSummarySchema.nullable(),
  portfolioDirector: operatingHierarchyAgentSummarySchema.nullable(),
  projects: z.array(operatingHierarchyProjectSummarySchema),
}).strict() satisfies z.ZodType<OperatingHierarchyPortfolioClusterSummary>;

export const operatingHierarchyDepartmentSummarySchema = z.object({
  key: agentDepartmentKeySchema,
  name: z.string().min(1),
  leaders: z.array(operatingHierarchyAgentSummarySchema),
  projects: z.array(operatingHierarchyProjectSummarySchema),
}).strict() satisfies z.ZodType<OperatingHierarchyDepartmentSummary>;

export const companyOperatingHierarchySchema = z.object({
  executiveOffice: z.array(operatingHierarchyAgentSummarySchema),
  portfolioClusters: z.array(operatingHierarchyPortfolioClusterSummarySchema).optional().default([]),
  projectPods: z.array(operatingHierarchyProjectSummarySchema),
  sharedServices: z.array(operatingHierarchyDepartmentSummarySchema),
  unassigned: z.array(operatingHierarchyAgentSummarySchema),
}).strict() satisfies z.ZodType<CompanyOperatingHierarchy>;

export const accountabilityIssueOwnershipSummarySchema = z.object({
  issueId: z.string().uuid(),
  identifier: z.string().nullable(),
  title: z.string().min(1),
  status: z.enum(ISSUE_STATUSES),
  continuityStatus: issueContinuityStatusSchema.nullable(),
  continuityHealth: issueContinuityHealthSchema.nullable(),
}).strict() satisfies z.ZodType<AccountabilityIssueOwnershipSummary>;

export const accountabilityAgentSummarySchema = operatingHierarchyAgentSummarySchema.extend({
  activeIssueCount: z.number().int().nonnegative(),
  blockedContinuityIssueCount: z.number().int().nonnegative(),
  openReviewFindingsCount: z.number().int().nonnegative(),
  returnedBranchCount: z.number().int().nonnegative(),
  issues: z.array(accountabilityIssueOwnershipSummarySchema),
}).strict() satisfies z.ZodType<AccountabilityAgentSummary>;

export const accountabilityProjectNodeSchema = z.object({
  projectId: z.string().uuid().nullable(),
  projectName: z.string().min(1),
  color: z.string().nullable(),
  executiveSponsor: operatingHierarchyAgentSummarySchema.nullable(),
  portfolioDirector: operatingHierarchyAgentSummarySchema.nullable(),
  leadership: z.array(operatingHierarchyAgentSummarySchema),
  continuityOwners: z.array(accountabilityAgentSummarySchema),
  sharedServices: z.array(operatingHierarchyAgentSummarySchema),
  issueCounts: z.object({
    active: z.number().int().nonnegative(),
    blockedMissingDocs: z.number().int().nonnegative(),
    staleProgress: z.number().int().nonnegative(),
    invalidHandoff: z.number().int().nonnegative(),
    openReviewFindings: z.number().int().nonnegative(),
    returnedBranches: z.number().int().nonnegative(),
    handoffPending: z.number().int().nonnegative(),
  }).strict(),
}).strict() satisfies z.ZodType<AccountabilityProjectNode>;

export const companyAgentCompositionSummarySchema = z.object({
  totalConfiguredAgents: z.number().int().nonnegative(),
  activeContinuityOwners: z.number().int().nonnegative(),
  activeGovernanceLeads: z.number().int().nonnegative(),
  activeSharedServiceAgents: z.number().int().nonnegative(),
  legacyAgents: z.number().int().nonnegative(),
  inactiveAgents: z.number().int().nonnegative(),
  simplificationCandidates: z.number().int().nonnegative(),
}).strict() satisfies z.ZodType<CompanyAgentCompositionSummary>;

export const companyAgentAccountabilitySchema = z.object({
  companyId: z.string().uuid(),
  generatedAt: z.string().datetime(),
  counts: companyAgentCompositionSummarySchema,
  executiveOffice: z.array(operatingHierarchyAgentSummarySchema),
  projects: z.array(accountabilityProjectNodeSchema),
  sharedServices: z.array(operatingHierarchyDepartmentSummarySchema),
  unassigned: z.array(operatingHierarchyAgentSummarySchema),
}).strict() satisfies z.ZodType<CompanyAgentAccountability>;

export const orgSimplificationActionSchema = z.enum([
  "archive",
  "reparent_reports",
  "convert_shared_service",
] as const) satisfies z.ZodType<OrgSimplificationAction>;

export const orgSimplificationCandidateSchema = z.object({
  agent: operatingHierarchyAgentSummarySchema,
  classification: z.enum(["keep", "merge", "convert", "archive"]),
  confidence: z.enum(["high", "medium", "low"]),
  reasons: z.array(z.string().trim().min(1)),
  activeIssueCount: z.number().int().nonnegative(),
  directReportCount: z.number().int().nonnegative(),
  recentRunCount: z.number().int().nonnegative(),
  activeSharedServiceEngagementCount: z.number().int().nonnegative(),
  activeGateCount: z.number().int().nonnegative(),
  suggestedTargetAgentId: z.string().uuid().nullable(),
  suggestedTargetName: z.string().nullable(),
}).strict() satisfies z.ZodType<OrgSimplificationCandidate>;

export const companyOrgSimplificationReportSchema = z.object({
  companyId: z.string().uuid(),
  generatedAt: z.string().datetime(),
  recommendedSteadyStateAgents: z.object({
    min: z.number().int().positive(),
    max: z.number().int().positive(),
  }).strict(),
  counts: companyAgentCompositionSummarySchema,
  candidates: z.array(orgSimplificationCandidateSchema),
}).strict() satisfies z.ZodType<CompanyOrgSimplificationReport>;

export const orgSimplificationArchiveRequestSchema = z.object({
  agentIds: z.array(z.string().uuid()).min(1),
  reason: z.string().trim().min(1).nullable().optional(),
}).strict() satisfies z.ZodType<OrgSimplificationArchiveRequest>;

export const orgSimplificationReparentReportsRequestSchema = z.object({
  fromAgentIds: z.array(z.string().uuid()).min(1),
  targetAgentId: z.string().uuid(),
  reason: z.string().trim().min(1).nullable().optional(),
}).strict() satisfies z.ZodType<OrgSimplificationReparentReportsRequest>;

export const orgSimplificationConvertSharedServiceRequestSchema = z.object({
  agentIds: z.array(z.string().uuid()).min(1),
  reason: z.string().trim().min(1).nullable().optional(),
}).strict() satisfies z.ZodType<OrgSimplificationConvertSharedServiceRequest>;

export const orgSimplificationActionResultSchema = z.object({
  companyId: z.string().uuid(),
  action: orgSimplificationActionSchema,
  affectedAgentIds: z.array(z.string().uuid()),
  report: companyOrgSimplificationReportSchema,
}).strict() satisfies z.ZodType<OrgSimplificationActionResult>;

export const agentNavigationTeamNodeSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  leaders: z.array(operatingHierarchyAgentSummarySchema),
  workers: z.array(operatingHierarchyAgentSummarySchema),
}).strict() satisfies z.ZodType<AgentNavigationTeamNode>;

export const agentNavigationProjectNodeSchema = z.object({
  projectId: z.string().uuid(),
  projectName: z.string().min(1),
  color: z.string().nullable(),
  leaders: z.array(operatingHierarchyAgentSummarySchema),
  teams: z.array(agentNavigationTeamNodeSchema),
  workers: z.array(operatingHierarchyAgentSummarySchema),
}).strict() satisfies z.ZodType<AgentNavigationProjectNode>;

export const agentNavigationClusterNodeSchema = z.object({
  clusterId: z.string().uuid(),
  name: z.string().min(1),
  slug: z.string().min(1),
  summary: z.string().nullable(),
  executiveSponsor: operatingHierarchyAgentSummarySchema.nullable(),
  portfolioDirector: operatingHierarchyAgentSummarySchema.nullable(),
  projects: z.array(agentNavigationProjectNodeSchema),
}).strict() satisfies z.ZodType<AgentNavigationClusterNode>;

export const agentNavigationDepartmentNodeSchema = z.object({
  key: z.union([agentDepartmentKeySchema, z.literal("shared_service")]),
  name: z.string().min(1),
  leaders: z.array(operatingHierarchyAgentSummarySchema),
  clusters: z.array(agentNavigationClusterNodeSchema).optional().default([]),
  projects: z.array(agentNavigationProjectNodeSchema),
}).strict() satisfies z.ZodType<AgentNavigationDepartmentNode>;

export const companyAgentNavigationSchema = z.object({
  layout: agentNavigationLayoutSchema,
  executives: z.array(operatingHierarchyAgentSummarySchema),
  departments: z.array(agentNavigationDepartmentNodeSchema),
  portfolioClusters: z.array(agentNavigationClusterNodeSchema).optional().default([]),
  projectPods: z.array(agentNavigationProjectNodeSchema),
  sharedServices: z.array(agentNavigationDepartmentNodeSchema),
  unassigned: z.array(operatingHierarchyAgentSummarySchema),
}).strict() satisfies z.ZodType<CompanyAgentNavigation>;

export const companyAgentHierarchyDepartmentSchema = z.object({
  key: agentDepartmentKeySchema,
  name: z.string().min(1),
  ownerExecutiveId: z.string().uuid().nullable(),
  ownerExecutiveName: z.string().nullable(),
  directors: z.array(agentHierarchyMemberSummarySchema),
  staff: z.array(agentHierarchyMemberSummarySchema),
}).strict() satisfies z.ZodType<CompanyAgentHierarchyDepartment>;

export const companyAgentHierarchyExecutiveGroupSchema = z.object({
  executive: agentHierarchyMemberSummarySchema,
  departments: z.array(companyAgentHierarchyDepartmentSchema),
}).strict() satisfies z.ZodType<CompanyAgentHierarchyExecutiveGroup>;

export const companyAgentHierarchyUnassignedSchema = z.object({
  executives: z.array(agentHierarchyMemberSummarySchema),
  directors: z.array(agentHierarchyMemberSummarySchema),
  staff: z.array(agentHierarchyMemberSummarySchema),
}).strict() satisfies z.ZodType<CompanyAgentHierarchyUnassigned>;

export const companyAgentHierarchySchema = z.object({
  executives: z.array(companyAgentHierarchyExecutiveGroupSchema),
  unassigned: companyAgentHierarchyUnassignedSchema,
}).strict() satisfies z.ZodType<CompanyAgentHierarchy>;

const createAgentSchemaBase = z.object({
  name: z.string().min(1).optional(),
  role: z.enum(AGENT_ROLES).optional(),
  title: z.string().optional().nullable(),
  icon: z.enum(AGENT_ICON_NAMES).optional().nullable(),
  reportsTo: z.string().uuid().optional().nullable(),
  orgLevel: agentOrgLevelSchema.optional(),
  operatingClass: agentOperatingClassSchema.optional(),
  capabilityProfileKey: agentCapabilityProfileKeySchema.optional(),
  archetypeKey: z.string().trim().min(1).optional(),
  departmentKey: agentDepartmentKeySchema.optional(),
  departmentName: z.string().trim().min(1).optional().nullable(),
  capabilities: z.string().optional().nullable(),
  desiredSkills: z.array(z.string().min(1)).optional(),
  adapterType: optionalAgentAdapterTypeSchema,
  adapterConfig: adapterConfigSchema.optional(),
  runtimeConfig: z.record(z.unknown()).optional(),
  budgetMonthlyCents: z.number().int().nonnegative().optional(),
  permissions: agentPermissionsSchema.optional(),
  metadata: z.record(z.unknown()).optional().nullable(),
  templateId: z.string().uuid().optional().nullable(),
  templateRevisionId: z.string().uuid().optional().nullable(),
  projectPlacement: agentProjectPlacementInputSchema.optional().nullable(),
});

const validateAgentDepartment = (value: Record<string, unknown>, ctx: z.RefinementCtx) => {
  const departmentKey =
    value.departmentKey === "general" ||
    value.departmentKey === "executive" ||
    value.departmentKey === "engineering" ||
    value.departmentKey === "product" ||
    value.departmentKey === "design" ||
    value.departmentKey === "marketing" ||
    value.departmentKey === "finance" ||
    value.departmentKey === "operations" ||
    value.departmentKey === "research" ||
    value.departmentKey === "custom"
      ? value.departmentKey
      : undefined;
  const departmentName = typeof value.departmentName === "string" ? value.departmentName : null;

  if (departmentKey === "custom" && (!departmentName || departmentName.trim().length === 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "departmentName is required when departmentKey is custom",
      path: ["departmentName"],
    });
  }
  if (departmentKey !== "custom" && departmentName && departmentName.trim().length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "departmentName is only allowed when departmentKey is custom",
      path: ["departmentName"],
    });
  }
};

export const createAgentSchema = createAgentSchemaBase.superRefine(validateAgentDepartment);

export type CreateAgent = z.infer<typeof createAgentSchema>;

export const createAgentHireSchema = createAgentSchemaBase.extend({
  sourceIssueId: z.string().uuid().optional().nullable(),
  sourceIssueIds: z.array(z.string().uuid()).optional(),
}).superRefine(validateAgentDepartment);

export type CreateAgentHire = z.infer<typeof createAgentHireSchema>;

export const updateAgentSchema = createAgentSchemaBase
  .omit({ permissions: true })
  .partial()
  .extend({
    permissions: z.never().optional(),
    replaceAdapterConfig: z.boolean().optional(),
    status: z.enum(AGENT_STATUSES).optional(),
    spentMonthlyCents: z.number().int().nonnegative().optional(),
  })
  .superRefine(validateAgentDepartment);

export type UpdateAgent = z.infer<typeof updateAgentSchema>;

export const updateAgentInstructionsPathSchema = z.object({
  path: z.string().trim().min(1).nullable(),
  adapterConfigKey: z.string().trim().min(1).optional(),
});

export type UpdateAgentInstructionsPath = z.infer<typeof updateAgentInstructionsPathSchema>;

export const createAgentKeySchema = z.object({
  name: z.string().min(1).default("default"),
});

export type CreateAgentKey = z.infer<typeof createAgentKeySchema>;

export const agentMineInboxQuerySchema = z.object({
  userId: z.string().trim().min(1),
  status: z.string().trim().min(1).optional().default(INBOX_MINE_ISSUE_STATUS_FILTER),
});

export type AgentMineInboxQuery = z.infer<typeof agentMineInboxQuerySchema>;

export const wakeAgentSchema = z.object({
  source: z.enum(["timer", "assignment", "on_demand", "automation"]).optional().default("on_demand"),
  triggerDetail: z.enum(["manual", "ping", "callback", "system"]).optional(),
  reason: z.string().optional().nullable(),
  payload: z.record(z.unknown()).optional().nullable(),
  idempotencyKey: z.string().optional().nullable(),
  forceFreshSession: z.preprocess(
    (value) => (value === null ? undefined : value),
    z.boolean().optional().default(false),
  ),
});

export type WakeAgent = z.infer<typeof wakeAgentSchema>;

export const resetAgentSessionSchema = z.object({
  taskKey: z.string().min(1).optional().nullable(),
});

export type ResetAgentSession = z.infer<typeof resetAgentSessionSchema>;

export const testAdapterEnvironmentSchema = z.object({
  adapterConfig: adapterConfigSchema.optional().default({}),
});

export type TestAdapterEnvironment = z.infer<typeof testAdapterEnvironmentSchema>;

export const updateAgentPermissionsSchema = z.object({
  canCreateAgents: z.boolean(),
  canAssignTasks: z.boolean(),
});

export type UpdateAgentPermissions = z.infer<typeof updateAgentPermissionsSchema>;
