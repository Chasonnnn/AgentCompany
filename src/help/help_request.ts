import { z } from "zod";
import YAML from "yaml";
import { newId } from "../core/ids.js";
import { nowIso } from "../core/time.js";
import { Visibility } from "../schemas/common.js";
import { parseFrontMatter } from "../artifacts/frontmatter.js";

export const HelpRequestFrontMatter = z
  .object({
    schema_version: z.number().int().positive(),
    type: z.literal("help_request"),
    id: z.string().min(1),
    created_at: z.string().min(1),
    title: z.string().min(1),
    visibility: Visibility,
    requester: z.string().min(1),
    target_manager: z.string().min(1),
    project_id: z.string().min(1).optional(),
    share_pack_id: z.string().min(1).optional()
  })
  .strict();

export type HelpRequestFrontMatter = z.infer<typeof HelpRequestFrontMatter>;

export type HelpRequestValidationIssue = { code: string; message: string };

export type HelpRequestValidationResult =
  | { ok: true; frontmatter: HelpRequestFrontMatter }
  | { ok: false; issues: HelpRequestValidationIssue[] };

const REQUIRED_HEADINGS: readonly string[] = ["## Question", "## Response"];

function hasHeading(body: string, heading: string): boolean {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^\\s*${escaped}\\s*$`, "im");
  return re.test(body);
}

export function validateHelpRequestMarkdown(markdown: string): HelpRequestValidationResult {
  const parsed = parseFrontMatter(markdown);
  if (!parsed.ok) {
    return { ok: false, issues: [{ code: "frontmatter", message: parsed.error }] };
  }

  const issues: HelpRequestValidationIssue[] = [];
  let fm: HelpRequestFrontMatter;
  try {
    fm = HelpRequestFrontMatter.parse(parsed.frontmatter);
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

  for (const h of REQUIRED_HEADINGS) {
    if (!hasHeading(parsed.body, h)) {
      issues.push({ code: "missing_heading", message: `Missing heading: ${h}` });
    }
  }

  return issues.length === 0 ? { ok: true, frontmatter: fm } : { ok: false, issues };
}

export type NewHelpRequestArgs = {
  title: string;
  visibility: z.infer<typeof Visibility>;
  requester: string;
  target_manager: string;
  project_id?: string;
  share_pack_id?: string;
  id?: string;
  created_at?: string;
};

export function newHelpRequestMarkdown(args: NewHelpRequestArgs): {
  help_request_id: string;
  markdown: string;
} {
  const id = args.id ?? newId("help");
  const createdAt = args.created_at ?? nowIso();
  const fm: HelpRequestFrontMatter = {
    schema_version: 1,
    type: "help_request",
    id,
    created_at: createdAt,
    title: args.title,
    visibility: args.visibility,
    requester: args.requester,
    target_manager: args.target_manager,
    project_id: args.project_id,
    share_pack_id: args.share_pack_id
  };

  const fmText = YAML.stringify(fm, { aliasDuplicateObjects: false }).trimEnd();
  const md = `---\n${fmText}\n---\n\n# ${args.title}\n\n## Question\n\n## Response\n`;
  return { help_request_id: id, markdown: md };
}

