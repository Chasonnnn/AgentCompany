import { z } from "zod";
import { IsoDateTime } from "./common.js";
import { MemoryScopeKind, MemorySensitivity } from "../memory/memory_delta.js";

export const SensitivePatternKind = z.enum([
  "OPENAI_API_KEY",
  "GITHUB_TOKEN",
  "SLACK_TOKEN",
  "BEARER_TOKEN",
  "GENERIC_CREDENTIAL_ASSIGNMENT"
]);
export type SensitivePatternKind = z.infer<typeof SensitivePatternKind>;

export const SensitivePatternCounts = z
  .record(SensitivePatternKind, z.number().int().nonnegative());
export type SensitivePatternCounts = z.infer<typeof SensitivePatternCounts>;

export const MemoryCandidate = z
  .object({
    scope_kind: MemoryScopeKind,
    scope_ref: z.string().min(1),
    sensitivity: MemorySensitivity,
    title: z.string().min(1),
    insert_lines: z.array(z.string().min(1)).min(1),
    rationale: z.string().min(1),
    evidence: z.array(z.string().min(1)).min(1),
    confidence: z.number().min(0).max(1)
  })
  .strict();
export type MemoryCandidate = z.infer<typeof MemoryCandidate>;

export const MemoryCandidateReport = z
  .object({
    schema_version: z.literal(1),
    type: z.literal("memory_candidate_report"),
    generated_at: IsoDateTime,
    project_id: z.string().min(1),
    job_id: z.string().min(1),
    run_id: z.string().min(1),
    actor_id: z.string().min(1),
    actor_role: z.enum(["human", "ceo", "director", "manager", "worker"]),
    actor_team_id: z.string().min(1).optional(),
    blocked_secret_count: z.number().int().nonnegative(),
    blocked_matches_by_kind: SensitivePatternCounts,
    count: z.number().int().nonnegative(),
    candidates: z.array(MemoryCandidate)
  })
  .strict();
export type MemoryCandidateReport = z.infer<typeof MemoryCandidateReport>;
