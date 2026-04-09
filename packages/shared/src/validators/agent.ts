import { z } from "zod";
import {
  AGENT_DEPARTMENT_KEYS,
  AGENT_ICON_NAMES,
  AGENT_ORG_LEVELS,
  AGENT_ROLES,
  AGENT_STATUSES,
  INBOX_MINE_ISSUE_STATUS_FILTER,
} from "../constants.js";
import { agentAdapterTypeSchema } from "../adapter-type.js";
import type {
  AgentHierarchyMemberSummary,
  CompanyAgentHierarchy,
  CompanyAgentHierarchyDepartment,
  CompanyAgentHierarchyExecutiveGroup,
  CompanyAgentHierarchyUnassigned,
} from "../types/agent.js";
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
export const agentDepartmentKeySchema = z.enum(AGENT_DEPARTMENT_KEYS);

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
  departmentKey: agentDepartmentKeySchema,
  departmentName: z.string().nullable(),
}).strict() satisfies z.ZodType<AgentHierarchyMemberSummary>;

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
  name: z.string().min(1),
  role: z.enum(AGENT_ROLES).optional().default("general"),
  title: z.string().optional().nullable(),
  icon: z.enum(AGENT_ICON_NAMES).optional().nullable(),
  reportsTo: z.string().uuid().optional().nullable(),
  orgLevel: agentOrgLevelSchema.optional(),
  departmentKey: agentDepartmentKeySchema.optional(),
  departmentName: z.string().trim().min(1).optional().nullable(),
  capabilities: z.string().optional().nullable(),
  desiredSkills: z.array(z.string().min(1)).optional(),
  adapterType: agentAdapterTypeSchema,
  adapterConfig: adapterConfigSchema.optional().default({}),
  runtimeConfig: z.record(z.unknown()).optional().default({}),
  budgetMonthlyCents: z.number().int().nonnegative().optional().default(0),
  permissions: agentPermissionsSchema.optional(),
  metadata: z.record(z.unknown()).optional().nullable(),
});

const validateAgentDepartment = (
  value: { departmentKey?: z.infer<typeof agentDepartmentKeySchema>; departmentName?: string | null },
  ctx: z.RefinementCtx,
) => {
  if (value.departmentKey === "custom" && (!value.departmentName || value.departmentName.trim().length === 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "departmentName is required when departmentKey is custom",
      path: ["departmentName"],
    });
  }
  if (value.departmentKey !== "custom" && value.departmentName && value.departmentName.trim().length > 0) {
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
