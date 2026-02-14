import { z } from "zod";
import { IsoDateTime, SchemaVersion } from "./common.js";

export const TeamYaml = z.object({
  schema_version: SchemaVersion,
  type: z.literal("team"),
  id: z.string().min(1),
  name: z.string().min(1),
  department_key: z.string().min(1).optional(),
  department_label: z.string().min(1).optional(),
  charter: z.string().min(1).optional(),
  created_at: IsoDateTime
});

export type TeamYaml = z.infer<typeof TeamYaml>;
