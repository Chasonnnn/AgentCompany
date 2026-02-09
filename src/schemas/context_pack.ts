import { z } from "zod";
import { IsoDateTime, SchemaVersion, Visibility } from "./common.js";

export const RepoSnapshot = z
  .object({
    repo_id: z.string().min(1),
    head_sha: z.string().min(1),
    dirty: z.boolean(),
    dirty_patch_artifact_id: z.string().min(1).optional()
  })
  .strict();

export const IncludedDoc = z
  .object({
    path: z.string().min(1),
    sha256: z.string().min(16),
    visibility: Visibility
  })
  .strict();

export const ContextPackManifestYaml = z
  .object({
    schema_version: SchemaVersion,
    type: z.literal("context_pack_manifest"),
    id: z.string().min(1),
    created_at: IsoDateTime,
    run_id: z.string().min(1),
    project_id: z.string().min(1),
    agent_id: z.string().min(1),
    repo_snapshot: RepoSnapshot.optional(),
    included_docs: z.array(IncludedDoc),
    tool_allowlist: z.array(z.string())
  })
  .strict();

export type ContextPackManifestYaml = z.infer<typeof ContextPackManifestYaml>;

export const PolicySnapshotYaml = z
  .object({
    schema_version: SchemaVersion,
    type: z.literal("policy_snapshot"),
    id: z.string().min(1),
    created_at: IsoDateTime,
    run_id: z.string().min(1),
    visibility_notes: z.string().optional(),
    tool_allowlist: z.array(z.string())
  })
  .strict();

export type PolicySnapshotYaml = z.infer<typeof PolicySnapshotYaml>;

