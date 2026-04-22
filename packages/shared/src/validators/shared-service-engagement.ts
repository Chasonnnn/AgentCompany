import { z } from "zod";
import { ADVISOR_KINDS, SHARED_SERVICE_ENGAGEMENT_STATUSES } from "../constants.js";
import type {
  SharedServiceEngagement,
  SharedServiceEngagementAssignment,
  SharedServiceEngagementCreateRequest,
  SharedServiceEngagementUpdateRequest,
} from "../types/shared-service-engagement.js";

export const sharedServiceEngagementStatusSchema = z.enum(SHARED_SERVICE_ENGAGEMENT_STATUSES);

export const sharedServiceEngagementAssignmentSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  engagementId: z.string().uuid(),
  agentId: z.string().uuid(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
}).strict() satisfies z.ZodType<SharedServiceEngagementAssignment>;

export const sharedServiceEngagementSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  targetProjectId: z.string().uuid(),
  serviceAreaKey: z.string().min(1),
  serviceAreaLabel: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().min(1),
  status: sharedServiceEngagementStatusSchema,
  requestedByAgentId: z.string().uuid().nullable(),
  requestedByUserId: z.string().nullable(),
  approvedByAgentId: z.string().uuid().nullable(),
  approvedByUserId: z.string().nullable(),
  closedByAgentId: z.string().uuid().nullable(),
  closedByUserId: z.string().nullable(),
  approvedAt: z.coerce.date().nullable(),
  closedAt: z.coerce.date().nullable(),
  outcomeSummary: z.string().nullable(),
  advisorKind: z.enum(ADVISOR_KINDS).nullable().optional(),
  advisorEnabled: z.boolean().optional(),
  metadata: z.record(z.unknown()).nullable(),
  assignments: z.array(sharedServiceEngagementAssignmentSchema),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
}).strict() satisfies z.ZodType<SharedServiceEngagement>;

export const createSharedServiceEngagementSchema = z.object({
  targetProjectId: z.string().uuid(),
  serviceAreaKey: z.string().trim().min(1),
  serviceAreaLabel: z.string().trim().min(1).optional().nullable(),
  title: z.string().trim().min(1),
  summary: z.string().trim().min(1),
  advisorKind: z.enum(ADVISOR_KINDS).optional().nullable(),
  advisorEnabled: z.boolean().optional().default(false),
  assignedAgentIds: z.array(z.string().uuid()).optional(),
  metadata: z.record(z.unknown()).optional().nullable(),
}).strict() satisfies z.ZodType<SharedServiceEngagementCreateRequest>;

export const updateSharedServiceEngagementSchema = z.object({
  serviceAreaKey: z.string().trim().min(1).optional(),
  serviceAreaLabel: z.string().trim().min(1).optional().nullable(),
  title: z.string().trim().min(1).optional(),
  summary: z.string().trim().min(1).optional(),
  advisorKind: z.enum(ADVISOR_KINDS).optional().nullable(),
  advisorEnabled: z.boolean().optional(),
  assignedAgentIds: z.array(z.string().uuid()).optional(),
  outcomeSummary: z.string().optional().nullable(),
  metadata: z.record(z.unknown()).optional().nullable(),
}).strict() satisfies z.ZodType<SharedServiceEngagementUpdateRequest>;

export type CreateSharedServiceEngagement = z.infer<typeof createSharedServiceEngagementSchema>;
export type UpdateSharedServiceEngagement = z.infer<typeof updateSharedServiceEngagementSchema>;
