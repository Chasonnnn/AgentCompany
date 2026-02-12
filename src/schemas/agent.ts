import { z } from "zod";
import { IsoDateTime, SchemaVersion } from "./common.js";

export const AgentRole = z.enum(["ceo", "director", "manager", "worker"]);

export const AgentYaml = z.object({
  schema_version: SchemaVersion,
  type: z.literal("agent"),
  id: z.string().min(1),
  name: z.string().min(1),
  display_title: z.string().min(1).optional(),
  avatar: z.string().min(1).optional(),
  model_hint: z.string().min(1).optional(),
  role: AgentRole,
  provider: z.string().min(1),
  team_id: z.string().optional(),
  created_at: IsoDateTime,
  launcher: z.record(z.string(), z.unknown()).optional()
});

export type AgentYaml = z.infer<typeof AgentYaml>;
