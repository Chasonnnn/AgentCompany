import { z } from "zod";
import { Visibility } from "../schemas/common.js";
import { parseFrontMatter } from "../artifacts/frontmatter.js";

export const MemoryScopeKind = z.enum(["project_memory", "agent_guidance"]);
export type MemoryScopeKind = z.infer<typeof MemoryScopeKind>;

export const MemorySensitivity = z.enum(["public", "internal", "restricted"]);
export type MemorySensitivity = z.infer<typeof MemorySensitivity>;

const MemoryDeltaFrontMatterV1 = z
  .object({
    schema_version: z.literal(1),
    type: z.literal("memory_delta"),
    id: z.string().min(1),
    created_at: z.string().min(1),
    title: z.string().min(1),
    visibility: Visibility,
    produced_by: z.string().min(1),
    run_id: z.string().min(1),
    context_pack_id: z.string().min(1),
    project_id: z.string().min(1),
    target_file: z.string().min(1),
    patch_file: z.string().min(1),
    evidence: z.array(z.string().min(1)).optional()
  })
  .strict();

const MemoryDeltaFrontMatterV2 = z
  .object({
    schema_version: z.literal(2),
    type: z.literal("memory_delta"),
    id: z.string().min(1),
    created_at: z.string().min(1),
    title: z.string().min(1),
    visibility: Visibility,
    produced_by: z.string().min(1),
    run_id: z.string().min(1),
    context_pack_id: z.string().min(1),
    project_id: z.string().min(1),
    target_file: z.string().min(1),
    patch_file: z.string().min(1),
    scope_kind: MemoryScopeKind,
    scope_ref: z.string().min(1),
    sensitivity: MemorySensitivity,
    rationale: z.string().min(1),
    evidence: z.array(z.string().min(1)).min(1)
  })
  .strict();

export type MemoryDeltaFrontMatter = {
  schema_version: number;
  source_schema_version: 1 | 2;
  type: "memory_delta";
  id: string;
  created_at: string;
  title: string;
  visibility: z.infer<typeof Visibility>;
  produced_by: string;
  run_id: string;
  context_pack_id: string;
  project_id: string;
  target_file: string;
  patch_file: string;
  scope_kind: MemoryScopeKind;
  scope_ref: string;
  sensitivity: MemorySensitivity;
  rationale: string;
  evidence: string[];
};

function normalizePath(input: string): string {
  return input.replace(/\\/g, "/");
}

function deriveScopeFromTargetFile(args: {
  project_id: string;
  target_file: string;
}): { scope_kind: MemoryScopeKind; scope_ref: string } {
  const normalized = normalizePath(args.target_file);
  const projectMemoryPath = normalizePath(`work/projects/${args.project_id}/memory.md`);
  if (normalized === projectMemoryPath) {
    return { scope_kind: "project_memory", scope_ref: args.project_id };
  }

  const agentMatch = normalized.match(/^org\/agents\/([^/]+)\/AGENTS\.md$/);
  if (agentMatch) {
    return { scope_kind: "agent_guidance", scope_ref: agentMatch[1]! };
  }

  return { scope_kind: "project_memory", scope_ref: args.project_id };
}

function normalizeV1Frontmatter(frontmatter: z.infer<typeof MemoryDeltaFrontMatterV1>): MemoryDeltaFrontMatter {
  const scope = deriveScopeFromTargetFile({
    project_id: frontmatter.project_id,
    target_file: frontmatter.target_file
  });
  return {
    ...frontmatter,
    source_schema_version: 1,
    scope_kind: scope.scope_kind,
    scope_ref: scope.scope_ref,
    sensitivity: "internal",
    rationale: "Legacy memory delta (schema v1): rationale not captured in artifact frontmatter.",
    evidence: frontmatter.evidence ?? []
  };
}

function normalizeV2Frontmatter(frontmatter: z.infer<typeof MemoryDeltaFrontMatterV2>): MemoryDeltaFrontMatter {
  return {
    ...frontmatter,
    source_schema_version: 2,
    evidence: [...frontmatter.evidence]
  };
}

export type ParsedMemoryDelta =
  | {
      ok: true;
      frontmatter: MemoryDeltaFrontMatter;
      body: string;
    }
  | { ok: false; error: string };

export function parseMemoryDeltaMarkdown(markdown: string): ParsedMemoryDelta {
  const parsed = parseFrontMatter(markdown);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  try {
    const raw =
      parsed.frontmatter && typeof parsed.frontmatter === "object"
        ? (parsed.frontmatter as Record<string, unknown>)
        : null;
    if (!raw) {
      return { ok: false, error: "memory_delta frontmatter must be an object" };
    }
    const schemaVersion = typeof raw.schema_version === "number" ? raw.schema_version : NaN;
    if (schemaVersion === 2) {
      const fm = normalizeV2Frontmatter(MemoryDeltaFrontMatterV2.parse(raw));
      return { ok: true, frontmatter: fm, body: parsed.body };
    }
    if (schemaVersion === 1) {
      const fm = normalizeV1Frontmatter(MemoryDeltaFrontMatterV1.parse(raw));
      return { ok: true, frontmatter: fm, body: parsed.body };
    }
    return {
      ok: false,
      error: `Unsupported memory_delta schema_version: ${Number.isFinite(schemaVersion) ? schemaVersion : "unknown"}`
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
