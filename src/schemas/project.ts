import { z } from "zod";
import { IsoDateTime, SchemaVersion } from "./common.js";
import { BudgetThreshold } from "./budget.js";

export const ProjectStatus = z.enum(["active", "archived"]);

export const ProjectYaml = z.object({
  schema_version: SchemaVersion,
  type: z.literal("project"),
  id: z.string().min(1),
  name: z.string().min(1),
  status: ProjectStatus,
  created_at: IsoDateTime,
  budget: BudgetThreshold.optional()
});

export type ProjectYaml = z.infer<typeof ProjectYaml>;
