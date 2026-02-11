import { z } from "zod";
import { IsoDateTime, SchemaVersion, Visibility } from "./common.js";
import { ActorRole } from "./review.js";

export const CommentTarget = z
  .object({
    project_id: z.string().min(1),
    agent_id: z.string().min(1).optional(),
    artifact_id: z.string().min(1).optional(),
    run_id: z.string().min(1).optional()
  })
  .strict()
  .refine((v) => Boolean(v.agent_id || v.artifact_id || v.run_id), {
    message: "target must include at least one of: agent_id, artifact_id, run_id"
  });

export const CommentYaml = z
  .object({
    schema_version: SchemaVersion,
    type: z.literal("comment"),
    id: z.string().min(1),
    created_at: IsoDateTime,
    author_id: z.string().min(1),
    author_role: ActorRole,
    visibility: Visibility,
    target: CommentTarget,
    body: z.string().min(1)
  })
  .strict();

export type CommentYaml = z.infer<typeof CommentYaml>;
