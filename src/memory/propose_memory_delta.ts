import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { applyPatch, createTwoFilesPatch } from "diff";
import { newId } from "../core/ids.js";
import { nowIso } from "../core/time.js";
import { assertNoSensitiveText } from "../core/redaction.js";
import { writeFileAtomic } from "../store/fs.js";
import { Visibility } from "../schemas/common.js";
import { validateMarkdownArtifact } from "../artifacts/markdown.js";
import { insertUnderHeading } from "./insert_under_heading.js";
import { MemoryScopeKind, MemorySensitivity } from "./memory_delta.js";

export type ProposeMemoryDeltaArgs = {
  workspace_dir: string;
  project_id: string;
  title: string;
  scope_kind: "project_memory" | "agent_guidance";
  scope_ref?: string;
  sensitivity: "public" | "internal" | "restricted";
  rationale: string;
  under_heading: string;
  insert_lines: string[];
  visibility: "private_agent" | "team" | "managers" | "org";
  produced_by: string;
  run_id: string;
  context_pack_id: string;
  evidence: string[];
};

export type ProposeMemoryDeltaResult = {
  artifact_id: string;
  artifact_relpath: string;
  patch_relpath: string;
  target_file: string;
  scope_kind: "project_memory" | "agent_guidance";
  scope_ref: string;
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

function resolveTargetFile(args: {
  project_id: string;
  scope_kind: "project_memory" | "agent_guidance";
  scope_ref?: string;
}): { target_relpath: string; scope_ref: string } {
  if (args.scope_kind === "project_memory") {
    if (args.scope_ref && args.scope_ref !== args.project_id) {
      throw new Error(
        `scope_ref must match project_id for project_memory scope (expected ${args.project_id}, got ${args.scope_ref})`
      );
    }
    return {
      target_relpath: path.join("work/projects", args.project_id, "memory.md"),
      scope_ref: args.project_id
    };
  }
  const scopeRef = String(args.scope_ref ?? "").trim();
  if (!scopeRef) {
    throw new Error("scope_ref is required for agent_guidance scope");
  }
  return {
    target_relpath: path.join("org/agents", scopeRef, "AGENTS.md"),
    scope_ref: scopeRef
  };
}

export async function proposeMemoryDelta(
  args: ProposeMemoryDeltaArgs
): Promise<ProposeMemoryDeltaResult> {
  const scopeKind = MemoryScopeKind.parse(args.scope_kind);
  const sensitivity = MemorySensitivity.parse(args.sensitivity);
  const visibility = Visibility.parse(args.visibility);
  const rationale = String(args.rationale ?? "").trim();
  if (!rationale) throw new Error("rationale is required");
  if (!Array.isArray(args.evidence) || args.evidence.length === 0) {
    throw new Error("evidence must contain at least one artifact id");
  }
  const evidence = args.evidence.map((e) => String(e).trim()).filter(Boolean);
  if (evidence.length === 0) {
    throw new Error("evidence must contain at least one non-empty artifact id");
  }
  if (sensitivity === "restricted" && visibility === "org") {
    throw new Error("restricted memory deltas cannot use org visibility");
  }

  assertNoSensitiveText(args.title, "memory_delta.title");
  assertNoSensitiveText(rationale, "memory_delta.rationale");
  assertNoSensitiveText(args.insert_lines.join("\n"), "memory_delta.insert_lines");

  const scope = resolveTargetFile({
    project_id: args.project_id,
    scope_kind: scopeKind,
    scope_ref: args.scope_ref
  });
  const targetRel = scope.target_relpath;
  ensureWorkspaceRelative(targetRel);

  const targetAbs = path.join(args.workspace_dir, targetRel);
  try {
    await fs.access(targetAbs);
  } catch {
    throw new Error(`Target memory file does not exist: ${targetRel}`);
  }
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
  assertNoSensitiveText(patchText, "memory_delta.patch");

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
    schema_version: 2,
    type: "memory_delta",
    id: artifactId,
    created_at: createdAt,
    title: args.title,
    visibility,
    produced_by: args.produced_by,
    run_id: args.run_id,
    context_pack_id: args.context_pack_id,
    project_id: args.project_id,
    target_file: targetRel,
    patch_file: patchRel,
    scope_kind: scopeKind,
    scope_ref: scope.scope_ref,
    sensitivity,
    rationale,
    evidence
  };

  const fmText = YAML.stringify(fm, { aliasDuplicateObjects: false }).trimEnd();
  const bodyLines: string[] = [
    `# ${args.title}`,
    "",
    "## Summary",
    "",
    `- rationale: ${rationale}`,
    `- scope_kind: \`${scopeKind}\``,
    `- scope_ref: \`${scope.scope_ref}\``,
    `- sensitivity: \`${sensitivity}\``,
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
  for (const e of evidence) bodyLines.push(`- ${e}`);

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
    target_file: targetRel,
    scope_kind: scopeKind,
    scope_ref: scope.scope_ref
  };
}
