import { z } from "zod";
import { IsoDateTime, SchemaVersion } from "./common.js";

export const ReviewDecision = z.enum(["approved", "denied"]);

export const ActorRole = z.enum(["human", "ceo", "director", "manager", "worker"]);

export const PolicyDecision = z
  .object({
    allowed: z.boolean(),
    rule_id: z.string().min(1),
    reason: z.string().min(1)
  })
  .strict();

export const ReviewSubject = z
  .object({
    kind: z.string().min(1),
    artifact_id: z.string().min(1),
    project_id: z.string().min(1),
    target_file: z.string().min(1).optional(),
    patch_file: z.string().min(1).optional(),
    scope_kind: z.enum(["project_memory", "agent_guidance"]).optional(),
    scope_ref: z.string().min(1).optional(),
    sensitivity: z.enum(["public", "internal", "restricted"]).optional(),
    rationale: z.string().min(1).optional()
  })
  .strict();

export const ReviewYaml = z
  .object({
    schema_version: SchemaVersion,
    type: z.literal("review"),
    id: z.string().min(1),
    created_at: IsoDateTime,
    actor_id: z.string().min(1),
    actor_role: ActorRole,
    decision: ReviewDecision,
    subject: ReviewSubject,
    policy: PolicyDecision,
    notes: z.string().optional()
  })
  .strict();

export type ReviewYaml = z.infer<typeof ReviewYaml>;
