import { z } from "zod";
import { nowIso } from "../core/time.js";
import { newId } from "../core/ids.js";
import { Visibility } from "../schemas/common.js";
import { parseFrontMatter } from "./frontmatter.js";
import YAML from "yaml";

export const ArtifactType = z.enum([
  "intake_brief",
  "clarifications_qa",
  "proposal",
  "workplan",
  "milestone_report",
  "manager_digest",
  "memory_delta",
  "failure_report"
]);

export type ArtifactType = z.infer<typeof ArtifactType>;

export const ArtifactFrontMatter = z.object({
  schema_version: z.number().int().positive(),
  type: ArtifactType,
  id: z.string().min(1),
  created_at: z.string().min(1),
  title: z.string().min(1),
  visibility: Visibility,
  produced_by: z.string().min(1),
  run_id: z.string().min(1),
  context_pack_id: z.string().min(1)
});

export type ArtifactFrontMatter = z.infer<typeof ArtifactFrontMatter>;

const REQUIRED_HEADINGS: Record<ArtifactType, readonly string[]> = {
  intake_brief: ["## Summary", "## Success Criteria", "## Constraints"],
  clarifications_qa: ["## Questions", "## Answers"],
  proposal: ["## Summary", "## Plan", "## Risks"],
  workplan: ["## Summary", "## Breakdown", "## Dependencies", "## Estimates"],
  milestone_report: ["## Summary", "## Evidence", "## Next"],
  manager_digest: ["## Summary", "## Decisions", "## Risks"],
  memory_delta: ["## Summary", "## Changes", "## Evidence"],
  failure_report: ["## Summary", "## Cause", "## Next Steps"]
};

export type ArtifactValidationIssue = { code: string; message: string };

export type ArtifactValidationResult =
  | { ok: true; frontmatter: ArtifactFrontMatter }
  | { ok: false; issues: ArtifactValidationIssue[] };

function hasHeading(body: string, heading: string): boolean {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^\\s*${escaped}\\s*$`, "im");
  return re.test(body);
}

export function validateMarkdownArtifact(markdown: string): ArtifactValidationResult {
  const parsed = parseFrontMatter(markdown);
  if (!parsed.ok) {
    return { ok: false, issues: [{ code: "frontmatter", message: parsed.error }] };
  }

  const issues: ArtifactValidationIssue[] = [];
  let fm: ArtifactFrontMatter;
  try {
    fm = ArtifactFrontMatter.parse(parsed.frontmatter);
  } catch (e) {
    if (e instanceof z.ZodError) {
      for (const i of e.issues) {
        issues.push({ code: "frontmatter_schema", message: `${i.path.join(".")}: ${i.message}` });
      }
    } else {
      issues.push({ code: "frontmatter_schema", message: (e as Error).message });
    }
    return { ok: false, issues };
  }

  for (const h of REQUIRED_HEADINGS[fm.type]) {
    if (!hasHeading(parsed.body, h)) {
      issues.push({ code: "missing_heading", message: `Missing heading: ${h}` });
    }
  }

  return issues.length === 0 ? { ok: true, frontmatter: fm } : { ok: false, issues };
}

export type NewArtifactArgs = {
  type: ArtifactType;
  title: string;
  visibility: z.infer<typeof Visibility>;
  produced_by: string;
  run_id: string;
  context_pack_id: string;
  id?: string;
  created_at?: string;
};

export function newArtifactMarkdown(args: NewArtifactArgs): string {
  const fm: ArtifactFrontMatter = {
    schema_version: 1,
    type: args.type,
    id: args.id ?? newId("art"),
    created_at: args.created_at ?? nowIso(),
    title: args.title,
    visibility: args.visibility,
    produced_by: args.produced_by,
    run_id: args.run_id,
    context_pack_id: args.context_pack_id
  };

  const fmText = YAML.stringify(fm, { aliasDuplicateObjects: false }).trimEnd();
  const headings = REQUIRED_HEADINGS[args.type].join("\n\n");

  return `---\n${fmText}\n---\n\n# ${args.title}\n\n${headings}\n`;
}

