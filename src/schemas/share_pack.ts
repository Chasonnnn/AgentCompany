import { z } from "zod";
import { IsoDateTime, SchemaVersion, Visibility } from "./common.js";

export const SharePackIncludedArtifact = z
  .object({
    artifact_id: z.string().min(1),
    type: z.string().min(1),
    visibility: Visibility,
    source_relpath: z.string().min(1),
    bundle_relpath: z.string().min(1)
  })
  .strict();

export const SharePackIncludedFile = z
  .object({
    source_relpath: z.string().min(1),
    bundle_relpath: z.string().min(1)
  })
  .strict();

export const SharePackIncludedRun = z
  .object({
    run_id: z.string().min(1),
    source_relpath: z.string().min(1),
    bundle_relpath: z.string().min(1),
    included_event_count: z.number().int().nonnegative()
  })
  .strict();

export const SharePackManifestYaml = z
  .object({
    schema_version: SchemaVersion,
    type: z.literal("share_pack"),
    id: z.string().min(1),
    created_at: IsoDateTime,
    project_id: z.string().min(1),
    created_by: z.string().min(1),
    visibility: Visibility,
    included_artifacts: z.array(SharePackIncludedArtifact),
    included_files: z.array(SharePackIncludedFile).optional(),
    included_runs: z.array(SharePackIncludedRun).optional()
  })
  .strict();

export type SharePackManifestYaml = z.infer<typeof SharePackManifestYaml>;
