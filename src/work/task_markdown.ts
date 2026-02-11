import { z } from "zod";
import YAML from "yaml";
import { newId } from "../core/ids.js";
import { nowIso } from "../core/time.js";
import { Visibility } from "../schemas/common.js";
import { BudgetThreshold } from "../schemas/budget.js";
import { parseFrontMatter } from "../artifacts/frontmatter.js";

export const TaskStatus = z.enum([
  "draft",
  "ready",
  "in_progress",
  "blocked",
  "done",
  "canceled"
]);

export const MilestoneKind = z.enum(["coding", "research", "planning"]);

export const MilestoneStatus = z.enum(["draft", "ready", "in_progress", "blocked", "done"]);

export const MilestoneEvidence = z
  .object({
    requires_patch: z.boolean(),
    requires_tests: z.boolean()
  })
  .strict();

export const TaskMilestone = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    kind: MilestoneKind,
    status: MilestoneStatus,
    acceptance_criteria: z.array(z.string().min(1)),
    evidence: MilestoneEvidence.optional()
  })
  .strict();

export const TaskScope = z
  .object({
    repo_id: z.string().min(1).optional(),
    workdir_rel: z.string().min(1).optional(),
    paths: z.array(z.string().min(1)).optional(),
    requires_worktree_isolation: z.boolean().optional()
  })
  .strict();

export const TaskFrontMatter = z
  .object({
    schema_version: z.number().int().positive(),
    type: z.literal("task"),
    id: z.string().min(1),
    project_id: z.string().min(1),
    title: z.string().min(1),
    created_at: z.string().min(1),
    status: TaskStatus,
    visibility: Visibility,
    team_id: z.string().min(1).optional(),
    assignee_agent_id: z.string().min(1).optional(),
    scope: TaskScope.optional(),
    budget: BudgetThreshold.optional(),
    deliverables: z.array(z.string().min(1)).optional(),
    acceptance_criteria: z.array(z.string().min(1)).optional(),
    milestones: z.array(TaskMilestone)
  })
  .strict();

export type TaskFrontMatter = z.infer<typeof TaskFrontMatter>;

export type TaskValidationIssue = { code: string; message: string };

export type TaskValidationResult =
  | { ok: true; frontmatter: TaskFrontMatter }
  | { ok: false; issues: TaskValidationIssue[] };

const REQUIRED_HEADINGS: readonly string[] = ["## Contract", "## Milestones"];

function hasHeading(body: string, heading: string): boolean {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^\\s*${escaped}\\s*$`, "im");
  return re.test(body);
}

export function validateTaskMarkdown(markdown: string): TaskValidationResult {
  const parsed = parseFrontMatter(markdown);
  if (!parsed.ok) {
    return { ok: false, issues: [{ code: "frontmatter", message: parsed.error }] };
  }

  const issues: TaskValidationIssue[] = [];
  let fm: TaskFrontMatter;
  try {
    fm = TaskFrontMatter.parse(parsed.frontmatter);
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

  // Contract completeness: draft tasks can be incomplete; ready+ tasks must have basic contract fields.
  if (fm.status !== "draft") {
    if (!fm.deliverables?.length) {
      issues.push({
        code: "contract_incomplete",
        message: "deliverables must be non-empty when status is not draft"
      });
    }
    if (!fm.acceptance_criteria?.length) {
      issues.push({
        code: "contract_incomplete",
        message: "acceptance_criteria must be non-empty when status is not draft"
      });
    }
    if (!fm.milestones.length) {
      issues.push({
        code: "contract_incomplete",
        message: "milestones must be non-empty when status is not draft"
      });
    }
  }

  return issues.length === 0 ? { ok: true, frontmatter: fm } : { ok: false, issues };
}

export type NewTaskArgs = {
  project_id: string;
  title: string;
  visibility: z.infer<typeof Visibility>;
  team_id?: string;
  assignee_agent_id?: string;
  id?: string;
  created_at?: string;
};

export function newTaskMarkdown(args: NewTaskArgs): string {
  const fm: TaskFrontMatter = {
    schema_version: 1,
    type: "task",
    id: args.id ?? newId("task"),
    project_id: args.project_id,
    title: args.title,
    created_at: args.created_at ?? nowIso(),
    status: "draft",
    visibility: args.visibility,
    team_id: args.team_id,
    assignee_agent_id: args.assignee_agent_id,
    milestones: []
  };

  const fmText = YAML.stringify(fm, { aliasDuplicateObjects: false }).trimEnd();
  return `---\n${fmText}\n---\n\n# ${args.title}\n\n## Contract\n\n## Milestones\n`;
}

export type AddMilestoneArgs = {
  title: string;
  kind: z.infer<typeof MilestoneKind>;
  acceptance_criteria?: string[];
  status?: z.infer<typeof MilestoneStatus>;
  evidence?: z.infer<typeof MilestoneEvidence>;
  id?: string;
};

export type AddMilestoneResult =
  | { ok: true; markdown: string; milestone_id: string }
  | { ok: false; error: string };

export function addMilestoneToTaskMarkdown(
  markdown: string,
  args: AddMilestoneArgs
): AddMilestoneResult {
  const parsed = parseFrontMatter(markdown);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  let fm: TaskFrontMatter;
  try {
    fm = TaskFrontMatter.parse(parsed.frontmatter);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  const milestoneId = args.id ?? newId("ms");
  const evidenceDefault =
    args.kind === "coding"
      ? { requires_patch: true, requires_tests: true }
      : { requires_patch: false, requires_tests: false };

  fm.milestones = [
    ...fm.milestones,
    {
      id: milestoneId,
      title: args.title,
      kind: args.kind,
      status: args.status ?? "draft",
      acceptance_criteria: args.acceptance_criteria ?? [],
      evidence: args.evidence ?? evidenceDefault
    }
  ];

  const fmText = YAML.stringify(fm, { aliasDuplicateObjects: false }).trimEnd();
  const rebuilt = `---\n${fmText}\n---\n${parsed.body.startsWith("\n") ? parsed.body : `\n${parsed.body}`}`;
  return { ok: true, markdown: rebuilt, milestone_id: milestoneId };
}

export type SetMilestoneStatusResult =
  | { ok: true; markdown: string }
  | { ok: false; error: string };

export function setTaskMilestoneStatus(
  markdown: string,
  milestone_id: string,
  status: z.infer<typeof MilestoneStatus>
): SetMilestoneStatusResult {
  const parsed = parseFrontMatter(markdown);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  let fm: TaskFrontMatter;
  try {
    fm = TaskFrontMatter.parse(parsed.frontmatter);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  const idx = fm.milestones.findIndex((m) => m.id === milestone_id);
  if (idx === -1) return { ok: false, error: `Milestone not found: ${milestone_id}` };

  fm.milestones = fm.milestones.map((m) => (m.id === milestone_id ? { ...m, status } : m));

  if (fm.milestones.length > 0 && fm.milestones.every((m) => m.status === "done")) {
    if (fm.status !== "canceled") fm.status = "done";
  } else if (fm.status === "done") {
    // If a milestone is moved out of done, reflect that at the task level.
    fm.status = "in_progress";
  }

  const fmText = YAML.stringify(fm, { aliasDuplicateObjects: false }).trimEnd();
  const rebuilt = `---\n${fmText}\n---\n${parsed.body.startsWith("\n") ? parsed.body : `\n${parsed.body}`}`;
  return { ok: true, markdown: rebuilt };
}
