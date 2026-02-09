import { z } from "zod";
import { IsoDateTime, SchemaVersion } from "./common.js";

export const RunStatus = z.enum(["running", "ended", "failed"]);

export const RunYaml = z.object({
  schema_version: SchemaVersion,
  type: z.literal("run"),
  id: z.string().min(1),
  project_id: z.string().min(1),
  agent_id: z.string().min(1),
  provider: z.string().min(1),
  created_at: IsoDateTime,
  status: RunStatus,
  context_pack_id: z.string().min(1),
  events_relpath: z.string().min(1)
});

export type RunYaml = z.infer<typeof RunYaml>;

