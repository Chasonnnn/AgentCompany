import fs from "node:fs/promises";
import path from "node:path";
import { initWorkspace } from "./init.js";
import { createTeam } from "../org/teams.js";
import { createAgent } from "../org/agents.js";
import { createProject } from "../work/projects.js";

export type DepartmentPresetKey =
  | "engineering"
  | "product"
  | "design"
  | "operations"
  | "qa"
  | "security"
  | "data";

export const DEPARTMENT_PRESETS: Record<
  DepartmentPresetKey,
  {
    label: string;
    manager_provider: string;
    worker_provider: string;
  }
> = {
  engineering: { label: "Engineering", manager_provider: "codex", worker_provider: "codex" },
  product: { label: "Product", manager_provider: "claude_code", worker_provider: "claude_code" },
  design: { label: "Design", manager_provider: "claude_code", worker_provider: "claude_code" },
  operations: { label: "Operations", manager_provider: "codex", worker_provider: "codex" },
  qa: { label: "QA", manager_provider: "codex", worker_provider: "codex" },
  security: { label: "Security", manager_provider: "codex", worker_provider: "codex" },
  data: { label: "Data", manager_provider: "claude_code", worker_provider: "claude_code" }
};

const CONTROLLED_ROOTS = ["company", "org", "work", "inbox", ".local"] as const;

export type BootstrapWorkspacePresetsArgs = {
  workspace_dir: string;
  company_name?: string;
  project_name?: string;
  departments?: string[];
  include_ceo?: boolean;
  include_director?: boolean;
  force?: boolean;
};

export type BootstrapDepartmentResult = {
  key: DepartmentPresetKey;
  team_id: string;
  manager_agent_id: string;
  worker_agent_id: string;
};

export type BootstrapWorkspacePresetsResult = {
  workspace_dir: string;
  company_name: string;
  project_id: string;
  departments: BootstrapDepartmentResult[];
  agents: {
    ceo_agent_id?: string;
    director_agent_id?: string;
  };
  default_session: {
    project_id: string;
    actor_id: string;
    actor_role: "human" | "ceo" | "director" | "manager" | "worker";
    actor_team_id?: string;
  };
};

function normalizeDepartmentKeys(raw: string[] | undefined): DepartmentPresetKey[] {
  const requested = (raw ?? ["engineering", "product"])
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  const deduped = [...new Set(requested)];
  const valid = deduped.filter((v): v is DepartmentPresetKey => v in DEPARTMENT_PRESETS);
  if (!valid.length) {
    throw new Error(
      `No valid department presets selected. Valid keys: ${Object.keys(DEPARTMENT_PRESETS).join(", ")}`
    );
  }
  return valid;
}

async function resetControlledWorkspaceState(workspaceDir: string): Promise<void> {
  for (const rel of CONTROLLED_ROOTS) {
    await fs.rm(path.join(workspaceDir, rel), { recursive: true, force: true });
  }
}

export async function bootstrapWorkspacePresets(
  args: BootstrapWorkspacePresetsArgs
): Promise<BootstrapWorkspacePresetsResult> {
  const workspaceDir = args.workspace_dir;
  const companyName = args.company_name?.trim() || "AgentCompany";
  const projectName = args.project_name?.trim() || "AgentCompany Ops";
  const includeCeo = args.include_ceo !== false;
  const includeDirector = args.include_director !== false;
  const deptKeys = normalizeDepartmentKeys(args.departments);

  if (args.force) {
    await resetControlledWorkspaceState(workspaceDir);
  }

  await initWorkspace({
    root_dir: workspaceDir,
    company_name: companyName,
    force: args.force
  });

  let ceoAgentId: string | undefined;
  let directorAgentId: string | undefined;

  if (includeCeo) {
    const ceo = await createAgent({
      workspace_dir: workspaceDir,
      name: "CEO",
      role: "ceo",
      provider: "manual"
    });
    ceoAgentId = ceo.agent_id;
  }

  if (includeDirector) {
    const director = await createAgent({
      workspace_dir: workspaceDir,
      name: "Director",
      role: "director",
      provider: "codex"
    });
    directorAgentId = director.agent_id;
  }

  const departments: BootstrapDepartmentResult[] = [];
  for (const key of deptKeys) {
    const preset = DEPARTMENT_PRESETS[key];
    const team = await createTeam({
      workspace_dir: workspaceDir,
      name: preset.label
    });
    const manager = await createAgent({
      workspace_dir: workspaceDir,
      name: `${preset.label} Manager`,
      role: "manager",
      provider: preset.manager_provider,
      team_id: team.team_id
    });
    const worker = await createAgent({
      workspace_dir: workspaceDir,
      name: `${preset.label} Worker`,
      role: "worker",
      provider: preset.worker_provider,
      team_id: team.team_id
    });
    departments.push({
      key,
      team_id: team.team_id,
      manager_agent_id: manager.agent_id,
      worker_agent_id: worker.agent_id
    });
  }

  const project = await createProject({
    workspace_dir: workspaceDir,
    name: projectName
  });

  const preferredDepartment = departments[0];
  const defaultActorId = directorAgentId ?? preferredDepartment.manager_agent_id ?? ceoAgentId ?? "human";
  const defaultActorRole: "human" | "ceo" | "director" | "manager" | "worker" = directorAgentId
    ? "director"
    : preferredDepartment
      ? "manager"
      : includeCeo
        ? "ceo"
        : "human";

  return {
    workspace_dir: workspaceDir,
    company_name: companyName,
    project_id: project.project_id,
    departments,
    agents: {
      ceo_agent_id: ceoAgentId,
      director_agent_id: directorAgentId
    },
    default_session: {
      project_id: project.project_id,
      actor_id: defaultActorId,
      actor_role: defaultActorRole,
      actor_team_id: preferredDepartment?.team_id
    }
  };
}
