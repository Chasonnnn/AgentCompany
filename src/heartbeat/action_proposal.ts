import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { nowIso } from "../core/time.js";
import { newId } from "../core/ids.js";
import { writeFileAtomic } from "../store/fs.js";
import { parseFrontMatter } from "../artifacts/frontmatter.js";
import { HeartbeatAction } from "../schemas/heartbeat.js";
import { Visibility } from "../schemas/common.js";

const HeartbeatActionProposalFrontmatter = z
  .object({
    schema_version: z.number().int().positive(),
    type: z.literal("heartbeat_action_proposal"),
    id: z.string().min(1),
    created_at: z.string().min(1),
    title: z.string().min(1),
    visibility: Visibility,
    produced_by: z.string().min(1),
    run_id: z.string().min(1),
    context_pack_id: z.string().min(1),
    project_id: z.string().min(1),
    proposed_action: HeartbeatAction,
    rationale: z.string().min(1).optional()
  })
  .strict();

export type HeartbeatActionProposalFrontmatter = z.infer<typeof HeartbeatActionProposalFrontmatter>;

export type ParseHeartbeatActionProposalResult =
  | {
      ok: true;
      frontmatter: HeartbeatActionProposalFrontmatter;
      body: string;
      markdown: string;
    }
  | { ok: false; error: string };

export function parseHeartbeatActionProposalMarkdown(markdown: string): ParseHeartbeatActionProposalResult {
  const parsed = parseFrontMatter(markdown);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const fm = HeartbeatActionProposalFrontmatter.safeParse(parsed.frontmatter);
  if (!fm.success) {
    const issue = fm.error.issues[0];
    return {
      ok: false,
      error: issue ? `${issue.path.join(".")}: ${issue.message}` : "Invalid heartbeat action proposal"
    };
  }

  return {
    ok: true,
    frontmatter: fm.data,
    body: parsed.body,
    markdown
  };
}

export async function createHeartbeatActionProposal(args: {
  workspace_dir: string;
  project_id: string;
  title: string;
  summary: string;
  produced_by: string;
  run_id: string;
  context_pack_id: string;
  proposed_action: z.infer<typeof HeartbeatAction>;
  rationale?: string;
  visibility?: z.infer<typeof Visibility>;
}): Promise<{ artifact_id: string; relpath: string; abs_path: string }> {
  const artifactId = newId("art");
  const frontmatter = HeartbeatActionProposalFrontmatter.parse({
    schema_version: 1,
    type: "heartbeat_action_proposal",
    id: artifactId,
    created_at: nowIso(),
    title: args.title,
    visibility: args.visibility ?? "managers",
    produced_by: args.produced_by,
    run_id: args.run_id,
    context_pack_id: args.context_pack_id,
    project_id: args.project_id,
    proposed_action: args.proposed_action,
    rationale: args.rationale
  });

  const fmText = YAML.stringify(frontmatter, { aliasDuplicateObjects: false }).trimEnd();
  const body = [
    `# ${frontmatter.title}`,
    "",
    "## Summary",
    "",
    args.summary.trim(),
    "",
    "## Proposed Action",
    "",
    "```json",
    JSON.stringify(frontmatter.proposed_action, null, 2),
    "```",
    "",
    "## Policy",
    "",
    "Requires manager approval before execution."
  ].join("\n");

  const markdown = `---\n${fmText}\n---\n\n${body}\n`;
  const relpath = path.join("work", "projects", args.project_id, "artifacts", `${artifactId}.md`);
  const absPath = path.join(args.workspace_dir, relpath);
  await writeFileAtomic(absPath, markdown);
  return {
    artifact_id: artifactId,
    relpath,
    abs_path: absPath
  };
}
