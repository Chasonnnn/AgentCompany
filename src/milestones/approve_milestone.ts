import fs from "node:fs/promises";
import path from "node:path";
import { newId } from "../core/ids.js";
import { nowIso } from "../core/time.js";
import { writeFileAtomic } from "../store/fs.js";
import { writeYamlFile } from "../store/yaml.js";
import { type ActorRole } from "../policy/policy.js";
import { enforcePolicy } from "../policy/enforce.js";
import { appendEventJsonl, newEnvelope } from "../runtime/events.js";
import { parseFrontMatter } from "../artifacts/frontmatter.js";
import { TaskFrontMatter, setTaskMilestoneStatus } from "../work/task_markdown.js";
import { parseMilestoneReportMarkdown } from "./milestone_report.js";

export type ApproveMilestoneArgs = {
  workspace_dir: string;
  project_id: string;
  task_id: string;
  milestone_id: string;
  report_artifact_id: string;
  actor_id: string;
  actor_role: ActorRole;
  actor_team_id?: string;
  notes?: string;
};

export type ApproveMilestoneResult = {
  review_id: string;
  decision: "approved";
  task_status: string;
  milestone_status: string;
};

function artifactExistsWithExtension(
  artifactsDir: string,
  artifactId: string,
  exts: readonly string[]
): Promise<boolean> {
  return (async () => {
    for (const ext of exts) {
      try {
        await fs.access(path.join(artifactsDir, `${artifactId}${ext}`));
        return true;
      } catch {
        // keep trying
      }
    }
    return false;
  })();
}

export async function approveMilestone(args: ApproveMilestoneArgs): Promise<ApproveMilestoneResult> {
  const taskPath = path.join(
    args.workspace_dir,
    "work/projects",
    args.project_id,
    "tasks",
    `${args.task_id}.md`
  );
  const artifactsDir = path.join(args.workspace_dir, "work/projects", args.project_id, "artifacts");
  const reportPath = path.join(artifactsDir, `${args.report_artifact_id}.md`);

  const taskMd = await fs.readFile(taskPath, { encoding: "utf8" });
  const taskParsed = parseFrontMatter(taskMd);
  if (!taskParsed.ok) throw new Error(taskParsed.error);
  const taskFm = TaskFrontMatter.parse(taskParsed.frontmatter);

  const milestone = taskFm.milestones.find((m) => m.id === args.milestone_id);
  if (!milestone) throw new Error(`Milestone not found: ${args.milestone_id}`);
  if (milestone.status === "done") throw new Error("Milestone is already done");

  const reportMd = await fs.readFile(reportPath, { encoding: "utf8" });
  const reportParsed = parseMilestoneReportMarkdown(reportMd);
  if (!reportParsed.ok) throw new Error(reportParsed.error);
  if (reportParsed.frontmatter.project_id !== args.project_id) {
    throw new Error("Milestone report project_id mismatch");
  }
  if (reportParsed.frontmatter.task_id !== args.task_id) {
    throw new Error("Milestone report task_id mismatch");
  }
  if (reportParsed.frontmatter.milestone_id !== args.milestone_id) {
    throw new Error("Milestone report milestone_id mismatch");
  }

  const policy = await enforcePolicy({
    workspace_dir: args.workspace_dir,
    project_id: args.project_id,
    run_id: reportParsed.frontmatter.run_id,
    actor_id: args.actor_id,
    actor_role: args.actor_role,
    actor_team_id: args.actor_team_id,
    action: "approve",
    resource: {
      resource_id: reportParsed.frontmatter.id,
      visibility: reportParsed.frontmatter.visibility,
      kind: "milestone_report",
      team_id: taskFm.team_id
    }
  });

  const requiresPatch = milestone.evidence?.requires_patch ?? (milestone.kind === "coding");
  const requiresTests = milestone.evidence?.requires_tests ?? (milestone.kind === "coding");

  if (requiresPatch) {
    const ok = await Promise.all(
      reportParsed.frontmatter.evidence_artifacts.map((id) =>
        artifactExistsWithExtension(artifactsDir, id, [".patch"])
      )
    ).then((arr) => arr.some(Boolean));
    if (!ok) throw new Error("Missing required patch evidence (.patch) for milestone approval");
  }

  if (requiresTests) {
    const tests = reportParsed.frontmatter.tests_artifacts ?? [];
    const ok = await Promise.all(
      tests.map((id) => artifactExistsWithExtension(artifactsDir, id, [".txt", ".json"]))
    ).then((arr) => arr.some(Boolean));
    if (!ok) throw new Error("Missing required tests evidence (.txt or .json) for milestone approval");
  }

  // Update task file: mark milestone done (and task done if all milestones done).
  const updated = setTaskMilestoneStatus(taskMd, args.milestone_id, "done");
  if (!updated.ok) throw new Error(updated.error);
  await writeFileAtomic(taskPath, updated.markdown);

  // Record approval as append-only review.
  const reviewId = newId("rev");
  const createdAt = nowIso();
  await writeYamlFile(path.join(args.workspace_dir, "inbox/reviews", `${reviewId}.yaml`), {
    schema_version: 1,
    type: "review",
    id: reviewId,
    created_at: createdAt,
    actor_id: args.actor_id,
    actor_role: args.actor_role,
    decision: "approved",
    subject: {
      kind: "milestone",
      artifact_id: reportParsed.frontmatter.id,
      project_id: args.project_id
    },
    policy,
    notes: args.notes ?? ""
  });

  // Append to run events if the run exists in this project.
  const runId = reportParsed.frontmatter.run_id;
  const eventsAbs = path.join(
    args.workspace_dir,
    "work/projects",
    args.project_id,
    "runs",
    runId,
    "events.jsonl"
  );
  try {
    await fs.access(eventsAbs);
    await appendEventJsonl(
      eventsAbs,
      newEnvelope({
        schema_version: 1,
        ts_wallclock: createdAt,
        run_id: runId,
        session_ref: `local_${runId}`,
        actor: args.actor_id,
        visibility: "managers",
        type: "approval.decided",
        payload: {
          review_id: reviewId,
          decision: "approved",
          subject_kind: "milestone",
          task_id: args.task_id,
          milestone_id: args.milestone_id,
          report_artifact_id: reportParsed.frontmatter.id,
          policy
        }
      })
    );
  } catch {
    // ok
  }

  const newTaskMd = await fs.readFile(taskPath, { encoding: "utf8" });
  const newTaskParsed = parseFrontMatter(newTaskMd);
  if (!newTaskParsed.ok) throw new Error(newTaskParsed.error);
  const newTaskFm = TaskFrontMatter.parse(newTaskParsed.frontmatter);
  const newMilestone = newTaskFm.milestones.find((m) => m.id === args.milestone_id);
  if (!newMilestone) throw new Error("Milestone disappeared after update");

  return {
    review_id: reviewId,
    decision: "approved",
    task_status: newTaskFm.status,
    milestone_status: newMilestone.status
  };
}
