import { z } from "zod";
import { Visibility } from "../schemas/common.js";
import { parseFrontMatter } from "../artifacts/frontmatter.js";

export const MemoryDeltaFrontMatter = z
  .object({
    schema_version: z.number().int().positive(),
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

export type MemoryDeltaFrontMatter = z.infer<typeof MemoryDeltaFrontMatter>;

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
    const fm = MemoryDeltaFrontMatter.parse(parsed.frontmatter);
    return { ok: true, frontmatter: fm, body: parsed.body };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

