import { z } from "zod";
import { SchemaVersion, Visibility } from "./common.js";

export const PolicyYaml = z.object({
  schema_version: SchemaVersion,
  type: z.literal("policy"),
  id: z.string().min(1),
  visibility_defaults: z
    .object({
      worker_journal: Visibility,
      worker_milestone_artifact: Visibility,
      manager_proposal: Visibility,
      director_workplan: Visibility
    })
    .strict()
});

export type PolicyYaml = z.infer<typeof PolicyYaml>;

