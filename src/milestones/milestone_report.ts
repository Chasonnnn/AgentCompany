import { z } from "zod";
import YAML from "yaml";
import { newId } from "../core/ids.js";
import { nowIso } from "../core/time.js";
import { Visibility } from "../schemas/common.js";
import { parseFrontMatter } from "../artifacts/frontmatter.js";

export const MilestoneReportFrontMatter = z
  .object({
    schema_version: z.number().int().positive(),
    type: z.literal("milestone_report"),
    id: z.string().min(1),
    created_at: z.string().min(1),
    title: z.string().min(1),
    visibility: Visibility,
    produced_by: z.string().min(1),
    run_id: z.string().min(1),
    context_pack_id: z.string().min(1),
    project_id: z.string().min(1),
    task_id: z.string().min(1),
    milestone_id: z.string().min(1),
    evidence_artifacts: z.array(z.string().min(1)),
    tests_artifacts: z.array(z.string().min(1)).optional()
  })
  .strict();

export type MilestoneReportFrontMatter = z.infer<typeof MilestoneReportFrontMatter>;

export type ParsedMilestoneReport =
  | { ok: true; frontmatter: MilestoneReportFrontMatter; body: string }
  | { ok: false; error: string };

export function parseMilestoneReportMarkdown(markdown: string): ParsedMilestoneReport {
  const parsed = parseFrontMatter(markdown);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  try {
    const fm = MilestoneReportFrontMatter.parse(parsed.frontmatter);
    return { ok: true, frontmatter: fm, body: parsed.body };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export type NewMilestoneReportArgs = {
  title: string;
  visibility: z.infer<typeof Visibility>;
  produced_by: string;
  run_id: string;
  context_pack_id: string;
  project_id: string;
  task_id: string;
  milestone_id: string;
  evidence_artifacts?: string[];
  tests_artifacts?: string[];
  id?: string;
  created_at?: string;
};

export function newMilestoneReportMarkdown(args: NewMilestoneReportArgs): {
  artifact_id: string;
  markdown: string;
} {
  const artifactId = args.id ?? newId("art");
  const createdAt = args.created_at ?? nowIso();
  const fm: MilestoneReportFrontMatter = {
    schema_version: 1,
    type: "milestone_report",
    id: artifactId,
    created_at: createdAt,
    title: args.title,
    visibility: args.visibility,
    produced_by: args.produced_by,
    run_id: args.run_id,
    context_pack_id: args.context_pack_id,
    project_id: args.project_id,
    task_id: args.task_id,
    milestone_id: args.milestone_id,
    evidence_artifacts: args.evidence_artifacts ?? [],
    tests_artifacts: args.tests_artifacts
  };

  const fmText = YAML.stringify(fm, { aliasDuplicateObjects: false }).trimEnd();
  const md = `---\n${fmText}\n---\n\n# ${args.title}\n\n## Summary\n\n## Evidence\n\n## Next\n`;
  return { artifact_id: artifactId, markdown: md };
}

