import { z } from "zod";
import { SchemaVersion } from "./common.js";

export const MachineYaml = z.object({
  schema_version: SchemaVersion,
  type: z.literal("machine"),
  repo_roots: z.record(z.string(), z.string()),
  provider_bins: z.record(z.string(), z.string())
});

export type MachineYaml = z.infer<typeof MachineYaml>;

