import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { applyPatch, createTwoFilesPatch } from "diff";
import { newId } from "../core/ids.js";
import { nowIso } from "../core/time.js";
import { writeFileAtomic } from "../store/fs.js";
import { Visibility } from "../schemas/common.js";
import { validateMarkdownArtifact } from "../artifacts/markdown.js";
import { insertUnderHeading } from "./insert_under_heading.js";

export type ProposeMemoryDeltaArgs = {
  workspace_dir: string;
  project_id: string;
  title: string;
  target_file?: string; // workspace-relative; defaults to work/projects/<project_id>/memory.md
  under_heading: string;
  insert_lines: string[];
  visibility: "private_agent" | "team" | "managers" | "org";
  produced_by: string;
  run_id: string;
  context_pack_id: string;
  evidence?: string[];
};

export type ProposeMemoryDeltaResult = {
  artifact_id: string;
  artifact_relpath: string;
  patch_relpath: string;
  target_file: string;
};

function ensureWorkspaceRelative(p: string): void {
  if (path.isAbsolute(p)) {
    throw new Error(`Path must be workspace-relative, not absolute: ${p}`);
  }
  const normalized = path.normalize(p);
  if (normalized.startsWith("..")) {
    throw new Error(`Path must not escape the workspace: ${p}`);
  }
}

export async function proposeMemoryDelta(
  args: ProposeMemoryDeltaArgs
): Promise<ProposeMemoryDeltaResult> {
  const targetRel =
    args.target_file ?? path.join("work/projects", args.project_id, "memory.md");
  ensureWorkspaceRelative(targetRel);

  const targetAbs = path.join(args.workspace_dir, targetRel);
  const before = await fs.readFile(targetAbs, { encoding: "utf8" });

  const inserted = insertUnderHeading({
    markdown: before,
    heading: args.under_heading,
    insert_lines: args.insert_lines
  });
  if (!inserted.ok) throw new Error(inserted.error);
  const after = inserted.markdown;

  const patchText = createTwoFilesPatch(
    `a/${targetRel}`,
    `b/${targetRel}`,
    before,
    after,
    "",
    ""
  );
  const applied = applyPatch(before, patchText);
  if (applied === false) throw new Error("Generated patch did not apply to original content");
  if (applied !== after) throw new Error("Generated patch applied but produced unexpected output");

  const artifactId = newId("art");
  const createdAt = nowIso();

  const artifactRel = path.join(
    "work/projects",
    args.project_id,
    "artifacts",
    `${artifactId}.md`
  );
  const patchRel = path.join(
    "work/projects",
    args.project_id,
    "artifacts",
    `${artifactId}.patch`
  );

  const fm: Record<string, unknown> = {
    schema_version: 1,
    type: "memory_delta",
    id: artifactId,
    created_at: createdAt,
    title: args.title,
    visibility: Visibility.parse(args.visibility),
    produced_by: args.produced_by,
    run_id: args.run_id,
    context_pack_id: args.context_pack_id,
    project_id: args.project_id,
    target_file: targetRel,
    patch_file: patchRel
  };
  if (args.evidence?.length) fm.evidence = args.evidence;

  const fmText = YAML.stringify(fm, { aliasDuplicateObjects: false }).trimEnd();
  const bodyLines: string[] = [
    `# ${args.title}`,
    "",
    "## Summary",
    "",
    "## Changes",
    "",
    `- target_file: \`${targetRel}\``,
    `- patch_file: \`${patchRel}\``,
    `- inserted_under: \`${args.under_heading}\``,
    "",
    "```text",
    ...args.insert_lines,
    "```",
    "",
    "## Evidence",
    ""
  ];
  if (args.evidence?.length) {
    for (const e of args.evidence) bodyLines.push(`- ${e}`);
  }

  const md = `---\n${fmText}\n---\n\n${bodyLines.join("\n")}\n`;

  const artifactValidation = validateMarkdownArtifact(md);
  if (!artifactValidation.ok) {
    const msg = artifactValidation.issues.map((i) => i.message).join("; ");
    throw new Error(`Generated memory delta artifact is invalid: ${msg}`);
  }

  await writeFileAtomic(path.join(args.workspace_dir, patchRel), patchText);
  await writeFileAtomic(path.join(args.workspace_dir, artifactRel), md);

  return {
    artifact_id: artifactId,
    artifact_relpath: artifactRel,
    patch_relpath: patchRel,
    target_file: targetRel
  };
}

