import { z } from "zod";
import { PORTFOLIO_CLUSTER_STATUSES } from "../constants.js";
import type {
  PortfolioCluster,
  PortfolioClusterCreateRequest,
  PortfolioClusterUpdateRequest,
} from "../types/portfolio-cluster.js";

export const portfolioClusterStatusSchema = z.enum(PORTFOLIO_CLUSTER_STATUSES);

export const portfolioClusterSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  name: z.string().min(1),
  slug: z.string().min(1),
  summary: z.string().nullable(),
  status: portfolioClusterStatusSchema,
  sortOrder: z.number().int(),
  executiveSponsorAgentId: z.string().uuid().nullable(),
  portfolioDirectorAgentId: z.string().uuid().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
}).strict() satisfies z.ZodType<PortfolioCluster>;

export const createPortfolioClusterSchema = z.object({
  name: z.string().min(1),
  slug: z.string().trim().min(1).optional().nullable(),
  summary: z.string().optional().nullable(),
  status: portfolioClusterStatusSchema.optional().default("active"),
  sortOrder: z.number().int().optional(),
  executiveSponsorAgentId: z.string().uuid().optional().nullable(),
  portfolioDirectorAgentId: z.string().uuid().optional().nullable(),
}).strict() satisfies z.ZodType<PortfolioClusterCreateRequest>;

export const updatePortfolioClusterSchema = z.object({
  name: z.string().min(1).optional(),
  slug: z.string().trim().min(1).optional().nullable(),
  summary: z.string().optional().nullable(),
  status: portfolioClusterStatusSchema.optional(),
  sortOrder: z.number().int().optional(),
  executiveSponsorAgentId: z.string().uuid().optional().nullable(),
  portfolioDirectorAgentId: z.string().uuid().optional().nullable(),
}).strict() satisfies z.ZodType<PortfolioClusterUpdateRequest>;

export type CreatePortfolioCluster = z.infer<typeof createPortfolioClusterSchema>;
export type UpdatePortfolioCluster = z.infer<typeof updatePortfolioClusterSchema>;
