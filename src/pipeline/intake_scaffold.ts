import fs from "node:fs/promises";
import path from "node:path";
import { createProject } from "../work/projects.js";
import { createTaskFile, addTaskMilestone } from "../work/tasks.js";
import { createProjectArtifactFile } from "../work/project_artifacts.js";
import { insertUnderHeading } from "../memory/insert_under_heading.js";
import { readYamlFile } from "../store/yaml.js";
import { AgentYaml } from "../schemas/agent.js";
import { writeFileAtomic } from "../store/fs.js";

export type IntakeScaffoldArgs = {
  workspace_dir: string;
  project_name: string;
  ceo_agent_id: string;
  director_agent_id: string;
  manager_agent_ids: string[];
};

export type IntakeScaffoldResult = {
  project_id: string;
  artifacts: {
    intake_brief_artifact_id: string;
    workplan_artifact_id: string;
    manager_proposal_artifact_ids: Record<string, string>;
  };
  tasks: {
    director_task_id: string;
    director_milestone_id: string;
    manager_task_ids: Record<string, string>;
    manager_milestone_ids: Record<string, string>;
  };
};

async function readAgent(workspaceDir: string, agentId: string): Promise<AgentYaml> {
  const p = path.join(workspaceDir, "org/agents", agentId, "agent.yaml");
  return AgentYaml.parse(await readYamlFile(p));
}

async function annotateTask(
  taskPath: string,
  linesToInsert: string[]
): Promise<void> {
  const md = await fs.readFile(taskPath, { encoding: "utf8" });
  const inserted = insertUnderHeading({
    markdown: md,
    heading: "## Milestones",
    insert_lines: linesToInsert
  });
  if (!inserted.ok) throw new Error(inserted.error);
  await writeFileAtomic(taskPath, inserted.markdown);
}

export async function scaffoldProjectIntake(
  args: IntakeScaffoldArgs
): Promise<IntakeScaffoldResult> {
  const proj = await createProject({ workspace_dir: args.workspace_dir, name: args.project_name });

  const intake = await createProjectArtifactFile({
    workspace_dir: args.workspace_dir,
    project_id: proj.project_id,
    type: "intake_brief",
    title: `Intake: ${args.project_name}`,
    visibility: "org",
    produced_by: args.ceo_agent_id,
    run_id: "run_manual",
    context_pack_id: "ctx_manual"
  });

  const managerTaskIds: Record<string, string> = {};
  const managerMilestoneIds: Record<string, string> = {};
  const managerProposalArtifacts: Record<string, string> = {};

  for (const managerId of args.manager_agent_ids) {
    const agent = await readAgent(args.workspace_dir, managerId);
    const teamId = agent.team_id;
    const task = await createTaskFile({
      workspace_dir: args.workspace_dir,
      project_id: proj.project_id,
      title: `${agent.name}: Proposal for ${args.project_name}`,
      visibility: "managers",
      team_id: teamId,
      assignee_agent_id: managerId
    });
    const ms = await addTaskMilestone({
      workspace_dir: args.workspace_dir,
      project_id: proj.project_id,
      task_id: task.task_id,
      milestone: {
        title: "Write departmental proposal",
        kind: "planning",
        status: "ready",
        acceptance_criteria: ["A validated proposal.md artifact exists in project artifacts"]
      }
    });

    const proposal = await createProjectArtifactFile({
      workspace_dir: args.workspace_dir,
      project_id: proj.project_id,
      type: "proposal",
      title: `Proposal: ${agent.name} (${args.project_name})`,
      visibility: "managers",
      produced_by: managerId,
      run_id: "run_manual",
      context_pack_id: "ctx_manual"
    });

    const taskPath = path.join(
      args.workspace_dir,
      "work/projects",
      proj.project_id,
      "tasks",
      `${task.task_id}.md`
    );
    await annotateTask(taskPath, [
      `- milestone_id: \`${ms.milestone_id}\``,
      `- required_artifact: proposal \`${proposal.artifact_id}\` (${proposal.artifact_relpath})`
    ]);

    managerTaskIds[managerId] = task.task_id;
    managerMilestoneIds[managerId] = ms.milestone_id;
    managerProposalArtifacts[managerId] = proposal.artifact_id;
  }

  const directorTask = await createTaskFile({
    workspace_dir: args.workspace_dir,
    project_id: proj.project_id,
    title: `Director: Synthesize workplan for ${args.project_name}`,
    visibility: "org",
    assignee_agent_id: args.director_agent_id
  });
  const directorMs = await addTaskMilestone({
    workspace_dir: args.workspace_dir,
    project_id: proj.project_id,
    task_id: directorTask.task_id,
    milestone: {
      title: "Synthesize workplan",
      kind: "planning",
      status: "ready",
      acceptance_criteria: ["A validated workplan.md artifact exists in project artifacts"]
    }
  });
  const workplan = await createProjectArtifactFile({
    workspace_dir: args.workspace_dir,
    project_id: proj.project_id,
    type: "workplan",
    title: `Workplan: ${args.project_name}`,
    visibility: "org",
    produced_by: args.director_agent_id,
    run_id: "run_manual",
    context_pack_id: "ctx_manual"
  });
  const directorTaskPath = path.join(
    args.workspace_dir,
    "work/projects",
    proj.project_id,
    "tasks",
    `${directorTask.task_id}.md`
  );
  await annotateTask(directorTaskPath, [
    `- milestone_id: \`${directorMs.milestone_id}\``,
    `- required_artifact: workplan \`${workplan.artifact_id}\` (${workplan.artifact_relpath})`
  ]);

  return {
    project_id: proj.project_id,
    artifacts: {
      intake_brief_artifact_id: intake.artifact_id,
      workplan_artifact_id: workplan.artifact_id,
      manager_proposal_artifact_ids: managerProposalArtifacts
    },
    tasks: {
      director_task_id: directorTask.task_id,
      director_milestone_id: directorMs.milestone_id,
      manager_task_ids: managerTaskIds,
      manager_milestone_ids: managerMilestoneIds
    }
  };
}
