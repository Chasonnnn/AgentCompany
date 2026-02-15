import { listAgents } from "../org/agents_list.js";
import { listTeams } from "../org/teams_list.js";
import { listProjects } from "../work/projects_list.js";
import { bootstrapWorkspacePresets, type BootstrapDepartmentResult } from "./bootstrap_presets.js";

export type EnterpriseDepartmentStatus = {
  department_key: string;
  department_label: string;
  team_id: string;
  director_count: number;
  worker_count: number;
};

export type EnsureEnterpriseDefaultsResult = {
  workspace_dir: string;
  bootstrapped: boolean;
  ready: boolean;
  reason:
    | "already_ready"
    | "bootstrapped_empty_workspace"
    | "skipped_existing_non_enterprise_topology";
  org_mode: "enterprise";
  project_count: number;
  departments: EnterpriseDepartmentStatus[];
  agents: {
    ceo_agent_id?: string;
    executive_manager_agent_id?: string;
  };
  bootstrap_project_id?: string;
};

async function summarizeEnterpriseTopology(workspaceDir: string): Promise<{
  project_count: number;
  departments: EnterpriseDepartmentStatus[];
  executive_manager_agent_id?: string;
  ceo_agent_id?: string;
  ready: boolean;
}> {
  const [projects, teams, agents] = await Promise.all([
    listProjects({ workspace_dir: workspaceDir }),
    listTeams({ workspace_dir: workspaceDir }),
    listAgents({ workspace_dir: workspaceDir })
  ]);
  const executiveManager = agents.find(
    (agent) => agent.role === "manager" && agent.display_title === "Executive Manager"
  );
  const ceo = agents.find((agent) => agent.role === "ceo");
  const departments = teams
    .filter((team) => Boolean(team.department_key))
    .map((team) => {
      const directorCount = agents.filter(
        (agent) => agent.role === "director" && agent.team_id === team.team_id
      ).length;
      const workerCount = agents.filter(
        (agent) => agent.role === "worker" && agent.team_id === team.team_id
      ).length;
      return {
        department_key: team.department_key ?? team.team_id,
        department_label: team.department_label ?? team.name,
        team_id: team.team_id,
        director_count: directorCount,
        worker_count: workerCount
      };
    });
  const ready =
    executiveManager !== undefined &&
    departments.length > 0 &&
    departments.every((dept) => dept.director_count >= 1 && dept.worker_count >= 1);
  return {
    project_count: projects.length,
    departments,
    executive_manager_agent_id: executiveManager?.agent_id,
    ceo_agent_id: ceo?.agent_id,
    ready
  };
}

function toDepartmentStatusFromBootstrap(rows: BootstrapDepartmentResult[]): EnterpriseDepartmentStatus[] {
  return rows.map((row) => ({
    department_key: row.department_key,
    department_label: row.department_label,
    team_id: row.team_id,
    director_count: 1,
    worker_count: row.worker_agent_ids.length
  }));
}

export async function ensureEnterpriseDefaults(args: {
  workspace_dir: string;
  company_name?: string;
  project_name?: string;
  executive_manager_name?: string;
  departments?: string[];
  workers_per_dept?: number;
}): Promise<EnsureEnterpriseDefaultsResult> {
  const current = await summarizeEnterpriseTopology(args.workspace_dir);
  if (current.ready) {
    return {
      workspace_dir: args.workspace_dir,
      bootstrapped: false,
      ready: true,
      reason: "already_ready",
      org_mode: "enterprise",
      project_count: current.project_count,
      departments: current.departments,
      agents: {
        ceo_agent_id: current.ceo_agent_id,
        executive_manager_agent_id: current.executive_manager_agent_id
      }
    };
  }

  if (current.project_count === 0 && current.departments.length === 0) {
    const boot = await bootstrapWorkspacePresets({
      workspace_dir: args.workspace_dir,
      company_name: args.company_name,
      project_name: args.project_name,
      org_mode: "enterprise",
      executive_manager_name: args.executive_manager_name,
      departments: args.departments,
      workers_per_dept: args.workers_per_dept
    });
    return {
      workspace_dir: args.workspace_dir,
      bootstrapped: true,
      ready: true,
      reason: "bootstrapped_empty_workspace",
      org_mode: "enterprise",
      project_count: 1,
      departments: toDepartmentStatusFromBootstrap(boot.departments),
      agents: {
        ceo_agent_id: boot.agents.ceo_agent_id,
        executive_manager_agent_id: boot.agents.executive_manager_agent_id
      },
      bootstrap_project_id: boot.project_id
    };
  }

  return {
    workspace_dir: args.workspace_dir,
    bootstrapped: false,
    ready: false,
    reason: "skipped_existing_non_enterprise_topology",
    org_mode: "enterprise",
    project_count: current.project_count,
    departments: current.departments,
    agents: {
      ceo_agent_id: current.ceo_agent_id,
      executive_manager_agent_id: current.executive_manager_agent_id
    }
  };
}
