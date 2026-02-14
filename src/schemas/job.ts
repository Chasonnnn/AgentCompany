import { z } from "zod";
import { IsoDateTime, SchemaVersion } from "./common.js";

export const WorkerKind = z.enum(["codex", "claude", "gemini"]);
export type WorkerKind = z.infer<typeof WorkerKind>;

export const JobPermissionLevel = z.enum(["read-only", "patch", "run-commands"]);
export type JobPermissionLevel = z.infer<typeof JobPermissionLevel>;

export const JobContextRef = z
  .object({
    kind: z.enum(["file", "command", "artifact", "note"]),
    value: z.string().min(1),
    description: z.string().min(1).optional()
  })
  .strict();
export type JobContextRef = z.infer<typeof JobContextRef>;

export const JobSpec = z
  .object({
    schema_version: SchemaVersion.default(1),
    type: z.literal("job").default("job"),
    job_id: z.string().min(1),
    job_kind: z.enum(["execution", "heartbeat"]).default("execution"),
    context_mode: z.enum(["auto", "manual"]).optional(),
    worker_kind: WorkerKind,
    workspace_dir: z.string().min(1),
    project_id: z.string().min(1),
    goal: z.string().min(1),
    constraints: z.array(z.string().min(1)),
    deliverables: z.array(z.string().min(1)),
    permission_level: JobPermissionLevel,
    context_refs: z.array(JobContextRef),
    max_context_refs: z.number().int().positive().max(200).optional(),
    worker_agent_id: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    manager_actor_id: z.string().min(1).optional(),
    manager_role: z.enum(["human", "ceo", "director", "manager", "worker"]).optional(),
    manager_team_id: z.string().min(1).optional()
  })
  .strict();

export type JobSpec = z.infer<typeof JobSpec>;

export const JobAttempt = z
  .object({
    attempt: z.number().int().positive(),
    run_id: z.string().min(1),
    context_pack_id: z.string().min(1),
    session_ref: z.string().min(1),
    worker_kind: WorkerKind,
    worker_agent_id: z.string().min(1),
    provider: z.string().min(1),
    provider_bin: z.string().min(1).optional(),
    provider_version: z.string().min(1).optional(),
    provider_help_hash: z.string().min(1).optional(),
    output_format: z.string().min(1).optional(),
    context_plan_relpath: z.string().min(1).optional(),
    context_plan_hash: z.string().min(1).optional(),
    started_at: IsoDateTime,
    ended_at: IsoDateTime.optional(),
    status: z.enum(["running", "ended", "failed", "stopped"]),
    error: z.string().optional()
  })
  .strict();

export type JobAttempt = z.infer<typeof JobAttempt>;

export const JobRecord = z
  .object({
    schema_version: SchemaVersion.default(1),
    type: z.literal("job_record").default("job_record"),
    job: JobSpec,
    created_at: IsoDateTime,
    updated_at: IsoDateTime,
    status: z.enum(["queued", "running", "completed", "canceled"]),
    cancellation_requested: z.boolean().default(false),
    current_attempt: z.number().int().nonnegative().default(0),
    attempts: z.array(JobAttempt),
    final_result_relpath: z.string().min(1).optional()
  })
  .strict();

export type JobRecord = z.infer<typeof JobRecord>;
