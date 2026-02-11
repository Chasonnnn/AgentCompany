import { z } from "zod";
import { IsoDateTime, SchemaVersion } from "./common.js";

export const RunStatus = z.enum(["running", "ended", "failed", "stopped"]);

export const RunUsageSource = z.enum(["provider_reported", "estimated_chars"]);
export const RunUsageConfidence = z.enum(["high", "low"]);

export const RunUsageSummary = z
  .object({
    source: RunUsageSource,
    confidence: RunUsageConfidence,
    estimate_method: z.string().min(1).optional(),
    provider: z.string().min(1).optional(),
    input_tokens: z.number().int().nonnegative().optional(),
    cached_input_tokens: z.number().int().nonnegative().optional(),
    output_tokens: z.number().int().nonnegative().optional(),
    reasoning_output_tokens: z.number().int().nonnegative().optional(),
    total_tokens: z.number().int().nonnegative(),
    captured_from_event_type: z.string().min(1).optional()
  })
  .strict();

export const CommandRunSpec = z
  .object({
    kind: z.literal("command"),
    argv: z.array(z.string().min(1)).min(1),
    repo_id: z.string().min(1).optional(),
    workdir_rel: z.string().min(1).optional(),
    task_id: z.string().min(1).optional(),
    milestone_id: z.string().min(1).optional(),
    worktree_relpath: z.string().min(1).optional(),
    worktree_branch: z.string().min(1).optional(),
    env: z.record(z.string(), z.string()).optional(),
    stdin_relpath: z.string().min(1).optional()
  })
  .strict();

export const RunYaml = z.object({
  schema_version: SchemaVersion,
  type: z.literal("run"),
  id: z.string().min(1),
  project_id: z.string().min(1),
  agent_id: z.string().min(1),
  provider: z.string().min(1),
  created_at: IsoDateTime,
  ended_at: IsoDateTime.optional(),
  status: RunStatus,
  usage: RunUsageSummary.optional(),
  context_pack_id: z.string().min(1),
  events_relpath: z.string().min(1),
  spec: CommandRunSpec.optional()
});

export type RunYaml = z.infer<typeof RunYaml>;
export type RunUsageSummary = z.infer<typeof RunUsageSummary>;
