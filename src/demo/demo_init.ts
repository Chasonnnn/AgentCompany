import { initWorkspace } from "../workspace/init.js";
import { createTeam } from "../org/teams.js";
import { createAgent } from "../org/agents.js";
import { createProject } from "../work/projects.js";
import { createTaskFile, addTaskMilestone } from "../work/tasks.js";

export type DemoInitArgs = {
  workspace_dir: string;
  company_name: string;
  force?: boolean;
};

export type DemoInitResult = {
  teams: { payments_team_id: string; growth_team_id: string };
  agents: {
    ceo_agent_id: string;
    director_agent_id: string;
    payments_manager_agent_id: string;
    payments_worker_agent_id: string;
    growth_manager_agent_id: string;
    growth_worker_agent_id: string;
  };
  project_id: string;
  tasks: {
    payments_task_id: string;
    payments_milestone_id: string;
    growth_task_id: string;
    growth_milestone_id: string;
  };
};

export async function demoInit(args: DemoInitArgs): Promise<DemoInitResult> {
  await initWorkspace({
    root_dir: args.workspace_dir,
    company_name: args.company_name,
    force: args.force
  });

  const payments = await createTeam({ workspace_dir: args.workspace_dir, name: "Payments" });
  const growth = await createTeam({ workspace_dir: args.workspace_dir, name: "Growth" });

  const ceo = await createAgent({
    workspace_dir: args.workspace_dir,
    name: "CEO",
    role: "ceo",
    provider: "manual"
  });
  const director = await createAgent({
    workspace_dir: args.workspace_dir,
    name: "Director",
    role: "director",
    provider: "codex"
  });

  const paymentsMgr = await createAgent({
    workspace_dir: args.workspace_dir,
    name: "Payments Manager",
    role: "manager",
    provider: "codex",
    team_id: payments.team_id
  });
  const paymentsWorker = await createAgent({
    workspace_dir: args.workspace_dir,
    name: "Payments Worker",
    role: "worker",
    provider: "codex",
    team_id: payments.team_id
  });

  const growthMgr = await createAgent({
    workspace_dir: args.workspace_dir,
    name: "Growth Manager",
    role: "manager",
    provider: "claude_code",
    team_id: growth.team_id
  });
  const growthWorker = await createAgent({
    workspace_dir: args.workspace_dir,
    name: "Growth Worker",
    role: "worker",
    provider: "claude_code",
    team_id: growth.team_id
  });

  const proj = await createProject({ workspace_dir: args.workspace_dir, name: "v0 Demo Project" });

  const paymentsTask = await createTaskFile({
    workspace_dir: args.workspace_dir,
    project_id: proj.project_id,
    title: "Payments: Milestone demo task",
    visibility: "team",
    team_id: payments.team_id,
    assignee_agent_id: paymentsWorker.agent_id
  });
  const paymentsMs = await addTaskMilestone({
    workspace_dir: args.workspace_dir,
    project_id: proj.project_id,
    task_id: paymentsTask.task_id,
    milestone: {
      title: "Payments milestone 1",
      kind: "coding",
      status: "ready",
      acceptance_criteria: ["Patch + tests evidence + milestone report"]
    }
  });

  const growthTask = await createTaskFile({
    workspace_dir: args.workspace_dir,
    project_id: proj.project_id,
    title: "Growth: Milestone demo task",
    visibility: "team",
    team_id: growth.team_id,
    assignee_agent_id: growthWorker.agent_id
  });
  const growthMs = await addTaskMilestone({
    workspace_dir: args.workspace_dir,
    project_id: proj.project_id,
    task_id: growthTask.task_id,
    milestone: {
      title: "Growth milestone 1",
      kind: "coding",
      status: "ready",
      acceptance_criteria: ["Patch + tests evidence + milestone report"]
    }
  });

  return {
    teams: { payments_team_id: payments.team_id, growth_team_id: growth.team_id },
    agents: {
      ceo_agent_id: ceo.agent_id,
      director_agent_id: director.agent_id,
      payments_manager_agent_id: paymentsMgr.agent_id,
      payments_worker_agent_id: paymentsWorker.agent_id,
      growth_manager_agent_id: growthMgr.agent_id,
      growth_worker_agent_id: growthWorker.agent_id
    },
    project_id: proj.project_id,
    tasks: {
      payments_task_id: paymentsTask.task_id,
      payments_milestone_id: paymentsMs.milestone_id,
      growth_task_id: growthTask.task_id,
      growth_milestone_id: growthMs.milestone_id
    }
  };
}

