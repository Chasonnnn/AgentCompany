import { z } from "zod";
import { SchemaVersion } from "./common.js";

export const ResultStatus = z.enum(["succeeded", "needs_input", "blocked", "failed", "canceled"]);
export type ResultStatus = z.infer<typeof ResultStatus>;

export const ResultFileChange = z
  .object({
    path: z.string().min(1),
    change_type: z.enum(["added", "modified", "deleted", "renamed"]).optional(),
    summary: z.string().min(1).optional()
  })
  .strict();

export type ResultFileChange = z.infer<typeof ResultFileChange>;

export const ResultCommand = z
  .object({
    command: z.string().min(1),
    exit_code: z.number().int().nullable().optional(),
    summary: z.string().min(1).optional()
  })
  .strict();

export type ResultCommand = z.infer<typeof ResultCommand>;

export const ResultArtifactPointer = z
  .object({
    relpath: z.string().min(1),
    artifact_id: z.string().min(1).optional(),
    kind: z.string().min(1).optional(),
    sha256: z.string().min(1).optional()
  })
  .strict();

export type ResultArtifactPointer = z.infer<typeof ResultArtifactPointer>;

export const ResultNextAction = z
  .object({
    action: z.string().min(1),
    rationale: z.string().min(1).optional()
  })
  .strict();

export type ResultNextAction = z.infer<typeof ResultNextAction>;

export const ResultError = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    details: z.string().optional()
  })
  .strict();

export type ResultError = z.infer<typeof ResultError>;

export const ResultSpec = z
  .object({
    schema_version: SchemaVersion.default(1),
    type: z.literal("result").default("result"),
    job_id: z.string().min(1),
    attempt_run_id: z.string().min(1),
    status: ResultStatus,
    summary: z.string().min(1),
    files_changed: z.array(ResultFileChange),
    commands_run: z.array(ResultCommand),
    artifacts: z.array(ResultArtifactPointer),
    next_actions: z.array(ResultNextAction),
    errors: z.array(ResultError)
  })
  .strict();

export type ResultSpec = z.infer<typeof ResultSpec>;

