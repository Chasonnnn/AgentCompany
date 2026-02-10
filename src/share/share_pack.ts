import fs from "node:fs/promises";
import path from "node:path";
import { newId } from "../core/ids.js";
import { nowIso } from "../core/time.js";
import { ensureDir } from "../store/fs.js";
import { writeYamlFile } from "../store/yaml.js";
import { validateMarkdownArtifact } from "../artifacts/markdown.js";

export type CreateSharePackArgs = {
  workspace_dir: string;
  project_id: string;
  created_by: string;
  include_visibilities?: readonly ("managers" | "org")[];
};

export type CreateSharePackResult = {
  share_pack_id: string;
  manifest_relpath: string;
  bundle_relpath: string;
  included_artifact_ids: string[];
};

export async function createSharePack(
  args: CreateSharePackArgs
): Promise<CreateSharePackResult> {
  const includeVis = new Set(args.include_visibilities ?? ["managers", "org"]);

  const shareId = newId("share");
  const createdAt = nowIso();

  const shareDirRel = path.join(
    "work/projects",
    args.project_id,
    "share_packs",
    shareId
  );
  const shareDirAbs = path.join(args.workspace_dir, shareDirRel);
  const bundleDirRel = path.join(shareDirRel, "bundle");
  const bundleDirAbs = path.join(args.workspace_dir, bundleDirRel);

  await ensureDir(shareDirAbs);
  await ensureDir(bundleDirAbs);

  const artifactsDirAbs = path.join(
    args.workspace_dir,
    "work/projects",
    args.project_id,
    "artifacts"
  );

  const includedArtifacts: {
    artifact_id: string;
    type: string;
    visibility: "private_agent" | "team" | "managers" | "org";
    source_relpath: string;
    bundle_relpath: string;
  }[] = [];

  const includedArtifactIds: string[] = [];

  const artifactEntries = await fs.readdir(artifactsDirAbs, { withFileTypes: true });
  for (const ent of artifactEntries) {
    if (!ent.isFile()) continue;
    if (!ent.name.endsWith(".md")) continue;

    const sourceRel = path.join(
      "work/projects",
      args.project_id,
      "artifacts",
      ent.name
    );
    const sourceAbs = path.join(args.workspace_dir, sourceRel);
    const md = await fs.readFile(sourceAbs, { encoding: "utf8" });
    const validated = validateMarkdownArtifact(md);
    if (!validated.ok) {
      const msg = validated.issues.map((i) => i.message).join("; ");
      throw new Error(`Invalid artifact ${sourceRel}: ${msg}`);
    }

    if (!includeVis.has(validated.frontmatter.visibility as any)) continue;

    const artifactId = validated.frontmatter.id;
    const bundleRel = path.join(bundleDirRel, `${artifactId}.md`);
    const bundleAbs = path.join(args.workspace_dir, bundleRel);
    await fs.copyFile(sourceAbs, bundleAbs);

    includedArtifacts.push({
      artifact_id: artifactId,
      type: validated.frontmatter.type,
      visibility: validated.frontmatter.visibility,
      source_relpath: sourceRel,
      bundle_relpath: bundleRel
    });
    includedArtifactIds.push(artifactId);
    includedArtifactIds.sort();
  }

  // Include curated project memory by default.
  const memoryRel = path.join("work/projects", args.project_id, "memory.md");
  const memoryAbs = path.join(args.workspace_dir, memoryRel);
  const memoryBundleRel = path.join(bundleDirRel, "project_memory.md");
  const memoryBundleAbs = path.join(args.workspace_dir, memoryBundleRel);
  let includedFiles: { source_relpath: string; bundle_relpath: string }[] = [];
  try {
    await fs.copyFile(memoryAbs, memoryBundleAbs);
    includedFiles = [
      {
        source_relpath: memoryRel,
        bundle_relpath: memoryBundleRel
      }
    ];
  } catch {
    // If missing, workspace:validate should report it. Share pack can still exist.
  }

  const manifestRel = path.join(shareDirRel, "manifest.yaml");
  await writeYamlFile(path.join(args.workspace_dir, manifestRel), {
    schema_version: 1,
    type: "share_pack",
    id: shareId,
    created_at: createdAt,
    project_id: args.project_id,
    created_by: args.created_by,
    visibility: "managers",
    included_artifacts: includedArtifacts,
    included_files: includedFiles
  });

  return {
    share_pack_id: shareId,
    manifest_relpath: manifestRel,
    bundle_relpath: bundleDirRel,
    included_artifact_ids: includedArtifactIds
  };
}
