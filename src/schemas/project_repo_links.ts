import { z } from "zod";
import { IsoDateTime, SchemaVersion } from "./common.js";

export const ProjectRepoLink = z
  .object({
    repo_id: z.string().min(1),
    label: z.string().min(1).optional()
  })
  .strict();

export const ProjectRepoLinksYaml = z
  .object({
    schema_version: SchemaVersion,
    type: z.literal("project_repo_links"),
    project_id: z.string().min(1),
    updated_at: IsoDateTime,
    repos: z.array(ProjectRepoLink).default([])
  })
  .strict();

export type ProjectRepoLinksYaml = z.infer<typeof ProjectRepoLinksYaml>;
