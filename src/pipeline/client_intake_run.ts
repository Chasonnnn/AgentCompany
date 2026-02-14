import fs from "node:fs/promises";
import path from "node:path";
import { createProject } from "../work/projects.js";
import { createProjectArtifactFile } from "../work/project_artifacts.js";
import { createTaskFile, addTaskMilestone } from "../work/tasks.js";
import { ensureProjectDefaults } from "../conversations/defaults.js";
import { listConversations } from "../conversations/store.js";
import { listAgents } from "../org/agents_list.js";
import { listTeams } from "../org/teams_list.js";
import { createHeartbeatActionProposal } from "../heartbeat/action_proposal.js";
import { writeFileAtomic } from "../store/fs.js";

export type RunClientIntakePipelineArgs = {
  workspace_dir: string;
  project_name: string;
  ceo_actor_id: string;
  executive_manager_agent_id: string;
  intake_text?: string;
  intake_file?: string;
  model?: string;
};

export type RunClientIntakePipelineResult = {
  project_id: string;
  artifacts: {
    intake_brief_artifact_id: string;
    executive_plan_artifact_id: string;
    meeting_transcript_artifact_id: string;
    approval_artifact_id: string;
  };
  department_plan_artifact_ids: Record<string, string>;
  director_task_ids: Record<string, string>;
  assigned_task_ids: string[];
  meeting_conversation_id: string;
};

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function withSectionContent(markdown: string, heading: string, content: string): string {
  const headingRe = new RegExp(`^${escapeRegExp(heading)}\\s*$`, "m");
  const match = headingRe.exec(markdown);
  if (!match) return markdown;
  const insertAt = match.index + match[0].length;
  return `${markdown.slice(0, insertAt)}\n\n${content.trim()}\n${markdown.slice(insertAt)}`;
}

async function patchArtifactSections(args: {
  workspace_dir: string;
  project_id: string;
  artifact_id: string;
  sections: Record<string, string>;
}): Promise<void> {
  const abs = path.join(
    args.workspace_dir,
    "work",
    "projects",
    args.project_id,
    "artifacts",
    `${args.artifact_id}.md`
  );
  let markdown = await fs.readFile(abs, { encoding: "utf8" });
  for (const [heading, content] of Object.entries(args.sections)) {
    markdown = withSectionContent(markdown, heading, content);
  }
  await writeFileAtomic(abs, markdown);
}

async function resolveIntakeText(args: RunClientIntakePipelineArgs): Promise<string> {
  const inline = args.intake_text?.trim();
  const fromFile = args.intake_file?.trim();
  if (inline && fromFile) {
    throw new Error("Provide only one of intake_text or intake_file");
  }
  if (fromFile) {
    return fs.readFile(fromFile, { encoding: "utf8" });
  }
  if (inline) return inline;
  return "Client intake draft pending detailed requirements.";
}

export async function runClientIntakePipeline(
  args: RunClientIntakePipelineArgs
): Promise<RunClientIntakePipelineResult> {
  const workspaceDir = args.workspace_dir.trim();
  const projectName = args.project_name.trim();
  const ceoActorId = args.ceo_actor_id.trim();
  const executiveManagerId = args.executive_manager_agent_id.trim();
  if (!workspaceDir) throw new Error("workspace_dir is required");
  if (!projectName) throw new Error("project_name is required");
  if (!ceoActorId) throw new Error("ceo_actor_id is required");
  if (!executiveManagerId) throw new Error("executive_manager_agent_id is required");

  const intakeText = await resolveIntakeText(args);
  const project = await createProject({
    workspace_dir: workspaceDir,
    name: projectName
  });
  await ensureProjectDefaults({
    workspace_dir: workspaceDir,
    project_id: project.project_id,
    ceo_actor_id: ceoActorId,
    executive_manager_agent_id: executiveManagerId
  });

  const [conversations, agents, teams] = await Promise.all([
    listConversations({
      workspace_dir: workspaceDir,
      scope: "project",
      project_id: project.project_id
    }),
    listAgents({ workspace_dir: workspaceDir }),
    listTeams({ workspace_dir: workspaceDir })
  ]);
  const meetingConversation = conversations.find((c) => c.slug === "planning-council") ?? conversations[0];
  if (!meetingConversation) {
    throw new Error("planning-council conversation was not created");
  }

  const intake = await createProjectArtifactFile({
    workspace_dir: workspaceDir,
    project_id: project.project_id,
    type: "intake_brief",
    title: `Client Intake: ${projectName}`,
    visibility: "org",
    produced_by: ceoActorId,
    run_id: "run_manual",
    context_pack_id: "ctx_manual"
  });
  await patchArtifactSections({
    workspace_dir: workspaceDir,
    project_id: project.project_id,
    artifact_id: intake.artifact_id,
    sections: {
      "## Summary": intakeText,
      "## Success Criteria": [
        "- Executive manager produces a comprehensive cross-department plan.",
        "- Department directors provide scoped plans with risks/dependencies.",
        "- CEO approves before worker execution begins."
      ].join("\n"),
      "## Constraints": [
        "- Enforce policy, budget, and secret-risk hard stops.",
        "- Keep planning artifacts canonical and auditable."
      ].join("\n")
    }
  });

  const executivePlan = await createProjectArtifactFile({
    workspace_dir: workspaceDir,
    project_id: project.project_id,
    type: "executive_plan",
    title: `Executive Plan: ${projectName}`,
    visibility: "managers",
    produced_by: executiveManagerId,
    run_id: "run_manual",
    context_pack_id: "ctx_manual"
  });

  const departmentDirectors = agents.filter((a) => a.role === "director" && a.team_id);
  const teamById = new Map(teams.map((t) => [t.team_id, t]));
  const departmentPlanArtifactIds: Record<string, string> = {};
  const directorTaskIds: Record<string, string> = {};
  const assignedTaskIds: string[] = [];
  const planSummaryLines: string[] = [];
  const transcriptDiscussion: string[] = [];
  const transcriptDecisions: string[] = [];
  const transcriptOpenQuestions: string[] = [];

  for (const director of departmentDirectors) {
    const team = director.team_id ? teamById.get(director.team_id) : undefined;
    const departmentKey = team?.department_key ?? team?.name.toLowerCase().replace(/\s+/g, "_") ?? director.agent_id;
    const departmentLabel = team?.department_label ?? team?.name ?? departmentKey;

    const departmentPlan = await createProjectArtifactFile({
      workspace_dir: workspaceDir,
      project_id: project.project_id,
      type: "department_plan",
      title: `${departmentLabel} Department Plan`,
      visibility: "managers",
      produced_by: director.agent_id,
      run_id: "run_manual",
      context_pack_id: "ctx_manual"
    });
    departmentPlanArtifactIds[departmentKey] = departmentPlan.artifact_id;

    await patchArtifactSections({
      workspace_dir: workspaceDir,
      project_id: project.project_id,
      artifact_id: departmentPlan.artifact_id,
      sections: {
        "## Scope": `- Department: ${departmentLabel}\n- Director: ${director.name}\n- Project: ${projectName}`,
        "## Deliverables": [
          "- Department implementation roadmap",
          "- Dependency and risk checklist",
          "- Director-to-worker task split proposal"
        ].join("\n"),
        "## Risks": [
          "- Requirement ambiguity across departments",
          "- Cross-team dependency slippage"
        ].join("\n"),
        "## Dependencies": [
          "- Executive plan approval by CEO",
          "- Coordination with planning council decisions"
        ].join("\n")
      }
    });

    const directorTask = await createTaskFile({
      workspace_dir: workspaceDir,
      project_id: project.project_id,
      title: `${departmentLabel}: Director Planning and Task Contract`,
      visibility: "managers",
      team_id: director.team_id,
      assignee_agent_id: director.agent_id
    });
    const milestone = await addTaskMilestone({
      workspace_dir: workspaceDir,
      project_id: project.project_id,
      task_id: directorTask.task_id,
      milestone: {
        title: "Produce department delivery contract",
        kind: "planning",
        status: "ready",
        acceptance_criteria: [
          `Department plan artifact exists: ${departmentPlan.artifact_id}`,
          "Dependencies and risks are documented"
        ]
      }
    });

    directorTaskIds[departmentKey] = directorTask.task_id;
    assignedTaskIds.push(directorTask.task_id);
    planSummaryLines.push(`- ${departmentLabel}: artifact \`${departmentPlan.artifact_id}\`, task \`${directorTask.task_id}\``);
    transcriptDiscussion.push(`- ${departmentLabel}: provided scoped plan and dependency notes.`);
    transcriptDecisions.push(
      `- ${departmentLabel}: director task \`${directorTask.task_id}\` created (milestone \`${milestone.milestone_id}\`).`
    );
    transcriptOpenQuestions.push(
      `- ${departmentLabel}: confirm integration sequencing with other departments.`
    );
  }

  await patchArtifactSections({
    workspace_dir: workspaceDir,
    project_id: project.project_id,
    artifact_id: executivePlan.artifact_id,
    sections: {
      "## Executive Summary": [
        `Project: ${projectName}`,
        `Executive manager: ${executiveManagerId}`,
        "High-level plan synthesized from CEO intake and director department plans."
      ].join("\n"),
      "## Department Plans": planSummaryLines.length ? planSummaryLines.join("\n") : "- No department plans found.",
      "## Dependencies": [
        "- Cross-department dependencies tracked in planning council.",
        "- Director-level assignments proceed after CEO approval."
      ].join("\n"),
      "## Approval": [
        "- Required approver: CEO",
        "- Status: pending",
        "- Worker execution tasks are blocked until approval."
      ].join("\n")
    }
  });

  const transcript = await createProjectArtifactFile({
    workspace_dir: workspaceDir,
    project_id: project.project_id,
    type: "meeting_transcript",
    title: `Planning Council Transcript: ${projectName}`,
    visibility: "managers",
    produced_by: executiveManagerId,
    run_id: "run_manual",
    context_pack_id: "ctx_manual"
  });
  await patchArtifactSections({
    workspace_dir: workspaceDir,
    project_id: project.project_id,
    artifact_id: transcript.artifact_id,
    sections: {
      "## Attendees": [
        `- CEO: ${ceoActorId}`,
        `- Executive Manager: ${executiveManagerId}`,
        ...departmentDirectors.map((d) => `- Director: ${d.agent_id}`)
      ].join("\n"),
      "## Discussion": transcriptDiscussion.length ? transcriptDiscussion.join("\n") : "- No discussion entries.",
      "## Decisions": transcriptDecisions.length ? transcriptDecisions.join("\n") : "- No decisions recorded.",
      "## Open Questions": transcriptOpenQuestions.length ? transcriptOpenQuestions.join("\n") : "- None."
    }
  });

  const approval = await createHeartbeatActionProposal({
    workspace_dir: workspaceDir,
    project_id: project.project_id,
    title: `CEO Approval Required: ${projectName} Executive Plan`,
    summary:
      "Executive plan package is ready for CEO approval before director-to-worker execution begins.",
    produced_by: executiveManagerId,
    run_id: "run_manual",
    context_pack_id: "ctx_manual",
    proposed_action: {
      kind: "create_approval_item",
      idempotency_key: `approval:executive-plan:${project.project_id}:${executivePlan.artifact_id}`,
      risk: "medium",
      needs_approval: true,
      project_id: project.project_id,
      title: `Approve executive plan ${executivePlan.artifact_id}`,
      rationale: `executive_plan_artifact_id=${executivePlan.artifact_id}`,
      proposed_action: {
        kind: "noop",
        idempotency_key: `approval:executive-plan:${project.project_id}:${executivePlan.artifact_id}:noop`,
        risk: "low",
        needs_approval: false,
        reason: "Approval marker only"
      }
    },
    rationale: `executive_plan_artifact_id=${executivePlan.artifact_id}`,
    visibility: "managers"
  });

  return {
    project_id: project.project_id,
    artifacts: {
      intake_brief_artifact_id: intake.artifact_id,
      executive_plan_artifact_id: executivePlan.artifact_id,
      meeting_transcript_artifact_id: transcript.artifact_id,
      approval_artifact_id: approval.artifact_id
    },
    department_plan_artifact_ids: departmentPlanArtifactIds,
    director_task_ids: directorTaskIds,
    assigned_task_ids: assignedTaskIds,
    meeting_conversation_id: meetingConversation.id
  };
}

