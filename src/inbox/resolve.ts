import fs from "node:fs/promises";
import path from "node:path";
import { newId } from "../core/ids.js";
import { nowIso } from "../core/time.js";
import { parseFrontMatter } from "../artifacts/frontmatter.js";
import { approveMemoryDelta } from "../memory/approve_memory_delta.js";
import { parseMemoryDeltaMarkdown } from "../memory/memory_delta.js";
import { approveMilestone } from "../milestones/approve_milestone.js";
import { parseMilestoneReportMarkdown } from "../milestones/milestone_report.js";
import { enforcePolicy, type EnforcePolicyArgs } from "../policy/enforce.js";
import { writeYamlFile } from "../store/yaml.js";
import { appendEventJsonl, newEnvelope } from "../runtime/events.js";
import { TaskFrontMatter } from "../work/task_markdown.js";
import type { ActorRole } from "../policy/policy.js";

export type ResolveDecision = "approved" | "denied";

export type ResolveInboxItemArgs = {
  workspace_dir: string;
  project_id: string;
  artifact_id: string;
  decision: ResolveDecision;
  actor_id: string;
  actor_role: ActorRole;
  actor_team_id?: string;
  notes?: string;
};

export type ResolveInboxItemResult = {
  review_id: string;
  decision: ResolveDecision;
  subject_kind: "memory_delta" | "milestone";
  project_id: string;
  artifact_id: string;
  task_id?: string;
  milestone_id?: string;
  task_status?: string;
  milestone_status?: string;
};

async function readArtifactMarkdown(args: {
  workspace_dir: string;
  project_id: string;
  artifact_id: string;
}): Promise<{ markdown: string; type: string }> {
  const abs = path.join(
    args.workspace_dir,
    "work/projects",
    args.project_id,
    "artifacts",
    `${args.artifact_id}.md`
  );
  const markdown = await fs.readFile(abs, { encoding: "utf8" });
  const parsed = parseFrontMatter(markdown);
  if (!parsed.ok) throw new Error(`Invalid artifact markdown: ${parsed.error}`);
  const type =
    parsed.frontmatter && typeof parsed.frontmatter === "object"
      ? (parsed.frontmatter as Record<string, unknown>).type
      : undefined;
  if (typeof type !== "string" || !type.trim()) {
    throw new Error(`Artifact ${args.artifact_id} is missing required frontmatter field: type`);
  }
  return { markdown, type };
}

async function readTaskFrontMatter(args: {
  workspace_dir: string;
  project_id: string;
  task_id: string;
}): Promise<TaskFrontMatter> {
  const taskPath = path.join(
    args.workspace_dir,
    "work/projects",
    args.project_id,
    "tasks",
    `${args.task_id}.md`
  );
  const taskMd = await fs.readFile(taskPath, { encoding: "utf8" });
  const parsed = parseFrontMatter(taskMd);
  if (!parsed.ok) throw new Error(parsed.error);
  return TaskFrontMatter.parse(parsed.frontmatter);
}

async function appendDecisionEvent(args: {
  workspace_dir: string;
  project_id: string;
  run_id: string;
  actor_id: string;
  created_at: string;
  review_id: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  const eventsAbs = path.join(
    args.workspace_dir,
    "work/projects",
    args.project_id,
    "runs",
    args.run_id,
    "events.jsonl"
  );
  try {
    await fs.access(eventsAbs);
    await appendEventJsonl(
      eventsAbs,
      newEnvelope({
        schema_version: 1,
        ts_wallclock: args.created_at,
        run_id: args.run_id,
        session_ref: `local_${args.run_id}`,
        actor: args.actor_id,
        visibility: "managers",
        type: "approval.decided",
        payload: {
          review_id: args.review_id,
          ...args.payload
        }
      })
    );
  } catch {
    // If the source run is missing, keep the durable review artifact only.
  }
}

async function writeDeniedReview(args: {
  workspace_dir: string;
  actor_id: string;
  actor_role: ActorRole;
  decision: "denied";
  subject: {
    kind: "memory_delta" | "milestone";
    artifact_id: string;
    project_id: string;
    target_file?: string;
    patch_file?: string;
  };
  policy: Awaited<ReturnType<typeof enforcePolicy>>;
  notes?: string;
}): Promise<{ review_id: string; created_at: string }> {
  const reviewId = newId("rev");
  const createdAt = nowIso();
  await writeYamlFile(path.join(args.workspace_dir, "inbox/reviews", `${reviewId}.yaml`), {
    schema_version: 1,
    type: "review",
    id: reviewId,
    created_at: createdAt,
    actor_id: args.actor_id,
    actor_role: args.actor_role,
    decision: args.decision,
    subject: args.subject,
    policy: args.policy,
    notes: args.notes ?? ""
  });
  return { review_id: reviewId, created_at: createdAt };
}

function denyPolicyArgs(args: {
  workspace_dir: string;
  project_id: string;
  run_id: string;
  actor_id: string;
  actor_role: ActorRole;
  actor_team_id?: string;
  resource_id: string;
  visibility: "private_agent" | "team" | "managers" | "org";
  kind: string;
  team_id?: string;
}): EnforcePolicyArgs {
  return {
    workspace_dir: args.workspace_dir,
    project_id: args.project_id,
    run_id: args.run_id,
    actor_id: args.actor_id,
    actor_role: args.actor_role,
    actor_team_id: args.actor_team_id,
    action: "approve",
    resource: {
      resource_id: args.resource_id,
      visibility: args.visibility,
      kind: args.kind,
      team_id: args.team_id
    }
  };
}

async function denyMemoryDelta(
  args: ResolveInboxItemArgs,
  markdown: string
): Promise<ResolveInboxItemResult> {
  const parsed = parseMemoryDeltaMarkdown(markdown);
  if (!parsed.ok) throw new Error(parsed.error);
  const fm = parsed.frontmatter;
  if (fm.project_id !== args.project_id) {
    throw new Error(
      `Memory delta project_id mismatch (expected ${args.project_id}, got ${fm.project_id})`
    );
  }

  const policy = await enforcePolicy(
    denyPolicyArgs({
      workspace_dir: args.workspace_dir,
      project_id: args.project_id,
      run_id: fm.run_id,
      actor_id: args.actor_id,
      actor_role: args.actor_role,
      actor_team_id: args.actor_team_id,
      resource_id: fm.id,
      visibility: fm.visibility,
      kind: "memory_delta"
    })
  );

  const review = await writeDeniedReview({
    workspace_dir: args.workspace_dir,
    actor_id: args.actor_id,
    actor_role: args.actor_role,
    decision: "denied",
    subject: {
      kind: "memory_delta",
      artifact_id: fm.id,
      project_id: fm.project_id,
      target_file: fm.target_file,
      patch_file: fm.patch_file
    },
    policy,
    notes: args.notes
  });

  await appendDecisionEvent({
    workspace_dir: args.workspace_dir,
    project_id: args.project_id,
    run_id: fm.run_id,
    actor_id: args.actor_id,
    created_at: review.created_at,
    review_id: review.review_id,
    payload: {
      decision: "denied",
      subject_kind: "memory_delta",
      artifact_id: fm.id,
      target_file: fm.target_file,
      patch_file: fm.patch_file,
      policy
    }
  });

  return {
    review_id: review.review_id,
    decision: "denied",
    subject_kind: "memory_delta",
    project_id: args.project_id,
    artifact_id: fm.id
  };
}

async function denyMilestone(
  args: ResolveInboxItemArgs,
  markdown: string
): Promise<ResolveInboxItemResult> {
  const parsed = parseMilestoneReportMarkdown(markdown);
  if (!parsed.ok) throw new Error(parsed.error);
  const fm = parsed.frontmatter;
  if (fm.project_id !== args.project_id) {
    throw new Error(`Milestone report project_id mismatch`);
  }

  const taskFm = await readTaskFrontMatter({
    workspace_dir: args.workspace_dir,
    project_id: args.project_id,
    task_id: fm.task_id
  });
  const milestone = taskFm.milestones.find((m) => m.id === fm.milestone_id);
  if (!milestone) throw new Error(`Milestone not found: ${fm.milestone_id}`);

  const policy = await enforcePolicy(
    denyPolicyArgs({
      workspace_dir: args.workspace_dir,
      project_id: args.project_id,
      run_id: fm.run_id,
      actor_id: args.actor_id,
      actor_role: args.actor_role,
      actor_team_id: args.actor_team_id,
      resource_id: fm.id,
      visibility: fm.visibility,
      kind: "milestone_report",
      team_id: taskFm.team_id
    })
  );

  const review = await writeDeniedReview({
    workspace_dir: args.workspace_dir,
    actor_id: args.actor_id,
    actor_role: args.actor_role,
    decision: "denied",
    subject: {
      kind: "milestone",
      artifact_id: fm.id,
      project_id: args.project_id
    },
    policy,
    notes: args.notes
  });

  await appendDecisionEvent({
    workspace_dir: args.workspace_dir,
    project_id: args.project_id,
    run_id: fm.run_id,
    actor_id: args.actor_id,
    created_at: review.created_at,
    review_id: review.review_id,
    payload: {
      decision: "denied",
      subject_kind: "milestone",
      task_id: fm.task_id,
      milestone_id: fm.milestone_id,
      report_artifact_id: fm.id,
      policy
    }
  });

  return {
    review_id: review.review_id,
    decision: "denied",
    subject_kind: "milestone",
    project_id: args.project_id,
    artifact_id: fm.id,
    task_id: fm.task_id,
    milestone_id: fm.milestone_id,
    task_status: taskFm.status,
    milestone_status: milestone.status
  };
}

export async function resolveInboxItem(args: ResolveInboxItemArgs): Promise<ResolveInboxItemResult> {
  const artifact = await readArtifactMarkdown(args);

  if (artifact.type === "memory_delta") {
    if (args.decision === "approved") {
      const approved = await approveMemoryDelta({
        workspace_dir: args.workspace_dir,
        project_id: args.project_id,
        artifact_id: args.artifact_id,
        actor_id: args.actor_id,
        actor_role: args.actor_role,
        actor_team_id: args.actor_team_id,
        notes: args.notes
      });
      return {
        review_id: approved.review_id,
        decision: approved.decision,
        subject_kind: "memory_delta",
        project_id: args.project_id,
        artifact_id: args.artifact_id
      };
    }
    return denyMemoryDelta(args, artifact.markdown);
  }

  if (artifact.type === "milestone_report") {
    const parsed = parseMilestoneReportMarkdown(artifact.markdown);
    if (!parsed.ok) throw new Error(parsed.error);
    if (args.decision === "approved") {
      const approved = await approveMilestone({
        workspace_dir: args.workspace_dir,
        project_id: args.project_id,
        task_id: parsed.frontmatter.task_id,
        milestone_id: parsed.frontmatter.milestone_id,
        report_artifact_id: args.artifact_id,
        actor_id: args.actor_id,
        actor_role: args.actor_role,
        actor_team_id: args.actor_team_id,
        notes: args.notes
      });
      return {
        review_id: approved.review_id,
        decision: approved.decision,
        subject_kind: "milestone",
        project_id: args.project_id,
        artifact_id: args.artifact_id,
        task_id: parsed.frontmatter.task_id,
        milestone_id: parsed.frontmatter.milestone_id,
        task_status: approved.task_status,
        milestone_status: approved.milestone_status
      };
    }
    return denyMilestone(args, artifact.markdown);
  }

  throw new Error(
    `Unsupported artifact type for inbox resolution: ${artifact.type} (artifact ${args.artifact_id})`
  );
}
