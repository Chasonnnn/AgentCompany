import { z } from "zod";
import { IsoDateTime } from "./common.js";
import { JobContextRef } from "./job.js";
import { MemorySensitivity, MemoryScopeKind } from "../memory/memory_delta.js";

export const ContextLayer = z.enum(["L0", "L1", "L2"]);
export type ContextLayer = z.infer<typeof ContextLayer>;

export const ContextTraceDecision = z.enum([
  "included",
  "filtered_policy",
  "filtered_sensitivity",
  "filtered_secret",
  "filtered_not_approved",
  "filtered_limit"
]);
export type ContextTraceDecision = z.infer<typeof ContextTraceDecision>;

export const ContextTraceEntry = z
  .object({
    layer: ContextLayer,
    source_kind: z.enum(["file", "artifact", "run", "note", "memory_delta", "seed"]),
    source_id: z.string().min(1),
    score: z.number().finite(),
    created_at: IsoDateTime.optional(),
    decision: ContextTraceDecision,
    reason: z.string().min(1),
    visibility: z.enum(["private_agent", "team", "managers", "org"]).optional(),
    sensitivity: MemorySensitivity.optional()
  })
  .strict();
export type ContextTraceEntry = z.infer<typeof ContextTraceEntry>;

export const ContextPlanResult = z
  .object({
    context_refs: z.array(JobContextRef),
    layers_used: z.array(ContextLayer),
    retrieval_trace: z.array(ContextTraceEntry),
    filtered_by_policy_count: z.number().int().nonnegative(),
    filtered_by_sensitivity_count: z.number().int().nonnegative(),
    filtered_by_secret_count: z.number().int().nonnegative()
  })
  .strict();
export type ContextPlanResult = z.infer<typeof ContextPlanResult>;

export const PersistedContextPlan = z
  .object({
    schema_version: z.literal(1),
    type: z.literal("context_plan"),
    generated_at: IsoDateTime,
    run_id: z.string().min(1),
    context_pack_id: z.string().min(1),
    project_id: z.string().min(1),
    worker_agent_id: z.string().min(1).optional(),
    manager_actor_id: z.string().min(1),
    manager_role: z.enum(["human", "ceo", "director", "manager", "worker"]),
    scope: z
      .object({
        goal: z.string().min(1),
        job_kind: z.enum(["execution", "heartbeat"]),
        max_refs: z.number().int().positive().max(200),
        scope_kind: MemoryScopeKind,
        scope_ref: z.string().min(1)
      })
      .strict(),
    result: ContextPlanResult
  })
  .strict();
export type PersistedContextPlan = z.infer<typeof PersistedContextPlan>;

