import fs from "node:fs/promises";
import path from "node:path";
import { newId } from "../core/ids.js";
import { nowIso } from "../core/time.js";
import { ensureDir, writeFileAtomic } from "../store/fs.js";
import { writeYamlFile } from "../store/yaml.js";
import { validateMarkdownArtifact } from "../artifacts/markdown.js";
import { redactJsonValue, redactSensitiveText } from "./redaction.js";

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
  included_run_ids: string[];
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
  const includedRunIds = new Set<string>();

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
    const redacted = redactSensitiveText(md);
    await writeFileAtomic(bundleAbs, redacted.text);

    includedArtifacts.push({
      artifact_id: artifactId,
      type: validated.frontmatter.type,
      visibility: validated.frontmatter.visibility,
      source_relpath: sourceRel,
      bundle_relpath: bundleRel
    });
    if (validated.frontmatter.run_id && validated.frontmatter.run_id.trim()) {
      includedRunIds.add(validated.frontmatter.run_id.trim());
    }
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
    const rawMemory = await fs.readFile(memoryAbs, { encoding: "utf8" });
    const redactedMemory = redactSensitiveText(rawMemory);
    await writeFileAtomic(memoryBundleAbs, redactedMemory.text);
    includedFiles = [
      {
        source_relpath: memoryRel,
        bundle_relpath: memoryBundleRel
      }
    ];
  } catch {
    // If missing, workspace:validate should report it. Share pack can still exist.
  }

  const includedRuns: Array<{
    run_id: string;
    source_relpath: string;
    bundle_relpath: string;
    included_event_count: number;
  }> = [];
  const runEventsBundleDirRel = path.join(bundleDirRel, "run_events");
  const runEventsBundleDirAbs = path.join(args.workspace_dir, runEventsBundleDirRel);
  await ensureDir(runEventsBundleDirAbs);
  const sortedRunIds = [...includedRunIds].sort();
  for (const runId of sortedRunIds) {
    const sourceRel = path.join("work/projects", args.project_id, "runs", runId, "events.jsonl");
    const sourceAbs = path.join(args.workspace_dir, sourceRel);
    let rawEvents = "";
    try {
      rawEvents = await fs.readFile(sourceAbs, { encoding: "utf8" });
    } catch {
      continue;
    }

    const outLines: string[] = [];
    for (const rawLine of rawEvents.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as { visibility?: unknown };
        const visibility = typeof parsed.visibility === "string" ? parsed.visibility : null;
        if (visibility !== null && !includeVis.has(visibility as "managers" | "org")) continue;
        const redacted = redactJsonValue(parsed);
        outLines.push(JSON.stringify(redacted.value));
      } catch {
        outLines.push(redactSensitiveText(line).text);
      }
    }
    if (outLines.length === 0) continue;
    const bundleRel = path.join(runEventsBundleDirRel, `${runId}.events.jsonl`);
    const bundleAbs = path.join(args.workspace_dir, bundleRel);
    await writeFileAtomic(bundleAbs, `${outLines.join("\n")}\n`);
    includedRuns.push({
      run_id: runId,
      source_relpath: sourceRel,
      bundle_relpath: bundleRel,
      included_event_count: outLines.length
    });
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
    included_files: includedFiles,
    included_runs: includedRuns
  });

  return {
    share_pack_id: shareId,
    manifest_relpath: manifestRel,
    bundle_relpath: bundleDirRel,
    included_artifact_ids: includedArtifactIds,
    included_run_ids: includedRuns.map((r) => r.run_id)
  };
}
