import { z } from "zod";
import { IsoDateTime, SchemaVersion } from "./common.js";

export const CompanyYaml = z.object({
  schema_version: SchemaVersion,
  type: z.literal("company"),
  id: z.string().min(1),
  name: z.string().min(1),
  created_at: IsoDateTime
});

export type CompanyYaml = z.infer<typeof CompanyYaml>;

