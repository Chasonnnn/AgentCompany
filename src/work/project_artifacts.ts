import path from "node:path";
import { newArtifactMarkdown, type ArtifactType, validateMarkdownArtifact } from "../artifacts/markdown.js";
import { writeFileAtomic } from "../store/fs.js";

export type CreateProjectArtifactArgs = {
  workspace_dir: string;
  project_id: string;
  type: ArtifactType;
  title: string;
  visibility: "private_agent" | "team" | "managers" | "org";
  produced_by: string;
  run_id: string;
  context_pack_id: string;
};

export async function createProjectArtifactFile(
  args: CreateProjectArtifactArgs
): Promise<{ artifact_id: string; artifact_relpath: string }> {
  const md = newArtifactMarkdown({
    type: args.type,
    title: args.title,
    visibility: args.visibility,
    produced_by: args.produced_by,
    run_id: args.run_id,
    context_pack_id: args.context_pack_id
  });
  const validated = validateMarkdownArtifact(md);
  if (!validated.ok) {
    const msg = validated.issues.map((i) => i.message).join("; ");
    throw new Error(`Internal error: generated invalid artifact markdown: ${msg}`);
  }

  const artifactId = validated.frontmatter.id;
  const rel = path.join("work/projects", args.project_id, "artifacts", `${artifactId}.md`);
  await writeFileAtomic(path.join(args.workspace_dir, rel), md);
  return { artifact_id: artifactId, artifact_relpath: rel };
}

