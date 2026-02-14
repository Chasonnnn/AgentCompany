import fs from "node:fs/promises";
import path from "node:path";
import { initWorkspace } from "./init.js";
import { createTeam } from "../org/teams.js";
import { createAgent } from "../org/agents.js";
import { createProject } from "../work/projects.js";
import { ensureProjectDefaults, ensureWorkspaceDefaults } from "../conversations/defaults.js";
import { writeHeartbeatConfig } from "../runtime/heartbeat_store.js";

export type OrgMode = "enterprise" | "standard";

export type DepartmentPresetKey =
  | "frontend"
  | "backend"
  | "agent_resources"
  | "marketing"
  | "infra"
  | "data"
  | "engineering"
  | "product"
  | "design"
  | "operations"
  | "qa"
  | "security";

type DepartmentPreset = {
  label: string;
  director_provider: string;
  worker_provider: string;
  charter: string;
};

export const DEPARTMENT_PRESETS: Record<DepartmentPresetKey, DepartmentPreset> = {
  frontend: {
    label: "Frontend",
    director_provider: "codex",
    worker_provider: "codex",
    charter: "Own UX architecture, UI implementation quality, and release readiness."
  },
  backend: {
    label: "Backend",
    director_provider: "codex",
    worker_provider: "codex",
    charter: "Own service contracts, API implementation, and data integrity."
  },
  agent_resources: {
    label: "Agent Resources",
    director_provider: "codex",
    worker_provider: "codex",
    charter: "Own agent skills, role guidance, and reusable delivery accelerators."
  },
  marketing: {
    label: "Marketing",
    director_provider: "claude_code",
    worker_provider: "claude_code",
    charter: "Own positioning, messaging, and launch collateral."
  },
  infra: {
    label: "Infrastructure",
    director_provider: "codex",
    worker_provider: "codex",
    charter: "Own environments, runtime reliability, and deployment workflows."
  },
  data: {
    label: "Data",
    director_provider: "claude_code",
    worker_provider: "claude_code",
    charter: "Own analytics models, instrumentation, and decision support metrics."
  },
  engineering: {
    label: "Engineering",
    director_provider: "codex",
    worker_provider: "codex",
    charter: "Own product engineering execution and technical delivery."
  },
  product: {
    label: "Product",
    director_provider: "claude_code",
    worker_provider: "claude_code",
    charter: "Own roadmap shaping, requirements, and product quality bar."
  },
  design: {
    label: "Design",
    director_provider: "claude_code",
    worker_provider: "claude_code",
    charter: "Own interaction design and visual language consistency."
  },
  operations: {
    label: "Operations",
    director_provider: "codex",
    worker_provider: "codex",
    charter: "Own operational health, support handoffs, and process resilience."
  },
  qa: {
    label: "QA",
    director_provider: "codex",
    worker_provider: "codex",
    charter: "Own verification quality and release confidence."
  },
  security: {
    label: "Security",
    director_provider: "codex",
    worker_provider: "codex",
    charter: "Own policy/security controls and risk hardening."
  }
};

const ENTERPRISE_DEFAULT_DEPARTMENTS: DepartmentPresetKey[] = [
  "frontend",
  "backend",
  "agent_resources",
  "marketing",
  "infra",
  "data"
];

const STANDARD_DEFAULT_DEPARTMENTS: DepartmentPresetKey[] = ["engineering", "product"];

const CONTROLLED_ROOTS = ["company", "org", "work", "inbox", ".local"] as const;

export type BootstrapWorkspacePresetsArgs = {
  workspace_dir: string;
  company_name?: string;
  project_name?: string;
  org_mode?: OrgMode;
  departments?: string[];
  include_ceo?: boolean;
  include_director?: boolean;
  executive_manager_name?: string;
  workers_per_dept?: number;
  force?: boolean;
};

export type BootstrapDepartmentResult = {
  department_key: DepartmentPresetKey;
  department_label: string;
  team_id: string;
  director_agent_id: string;
  worker_agent_ids: string[];
};

export type BootstrapWorkspacePresetsResult = {
  workspace_dir: string;
  company_name: string;
  project_id: string;
  org_mode: OrgMode;
  departments: BootstrapDepartmentResult[];
  agents: {
    ceo_agent_id?: string;
    director_agent_id?: string;
    executive_manager_agent_id?: string;
  };
  default_session: {
    project_id: string;
    actor_id: string;
    actor_role: "human" | "ceo" | "director" | "manager" | "worker";
    actor_team_id?: string;
  };
};

function normalizeOrgMode(raw?: string): OrgMode {
  if (raw === "standard") return "standard";
  return "enterprise";
}

function normalizeDepartmentKeys(raw: string[] | undefined, orgMode: OrgMode): DepartmentPresetKey[] {
  const defaults = orgMode === "enterprise" ? ENTERPRISE_DEFAULT_DEPARTMENTS : STANDARD_DEFAULT_DEPARTMENTS;
  const requested = (raw ?? defaults)
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

function normalizeWorkersPerDept(raw?: number): number {
  if (raw == null) return 1;
  if (!Number.isFinite(raw)) return 1;
  return Math.max(1, Math.floor(raw));
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
  const orgMode = normalizeOrgMode(args.org_mode);
  const includeCeo = args.include_ceo !== false;
  const includeDirector = args.include_director !== false;
  const executiveManagerName = args.executive_manager_name?.trim() || "Executive Manager";
  const workersPerDept = normalizeWorkersPerDept(args.workers_per_dept);
  const deptKeys = normalizeDepartmentKeys(args.departments, orgMode);

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
  let executiveManagerAgentId: string | undefined;

  if (includeCeo) {
    const ceo = await createAgent({
      workspace_dir: workspaceDir,
      name: "CEO",
      role: "ceo",
      provider: "manual"
    });
    ceoAgentId = ceo.agent_id;
  }

  if (orgMode === "enterprise") {
    const executiveManager = await createAgent({
      workspace_dir: workspaceDir,
      name: executiveManagerName,
      display_title: "Executive Manager",
      role: "manager",
      provider: "codex"
    });
    executiveManagerAgentId = executiveManager.agent_id;
  } else if (includeDirector) {
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
      name: preset.label,
      department_key: key,
      department_label: preset.label,
      charter: preset.charter
    });
    const director = await createAgent({
      workspace_dir: workspaceDir,
      name: `${preset.label} Director`,
      role: "director",
      provider: preset.director_provider,
      team_id: team.team_id
    });
    const workers: string[] = [];
    for (let i = 0; i < workersPerDept; i += 1) {
      const worker = await createAgent({
        workspace_dir: workspaceDir,
        name: workersPerDept === 1 ? `${preset.label} Worker` : `${preset.label} Worker ${i + 1}`,
        role: "worker",
        provider: preset.worker_provider,
        team_id: team.team_id
      });
      workers.push(worker.agent_id);
    }
    departments.push({
      department_key: key,
      department_label: preset.label,
      team_id: team.team_id,
      director_agent_id: director.agent_id,
      worker_agent_ids: workers
    });
  }

  const project = await createProject({
    workspace_dir: workspaceDir,
    name: projectName
  });
  await ensureWorkspaceDefaults({
    workspace_dir: workspaceDir,
    ceo_actor_id: ceoAgentId ?? "human_ceo",
    executive_manager_agent_id: executiveManagerAgentId
  });
  await ensureProjectDefaults({
    workspace_dir: workspaceDir,
    project_id: project.project_id,
    ceo_actor_id: ceoAgentId ?? "human_ceo",
    executive_manager_agent_id: executiveManagerAgentId
  });

  if (orgMode === "enterprise" && executiveManagerAgentId) {
    await writeHeartbeatConfig({
      workspace_dir: workspaceDir,
      config: {
        hierarchy_mode: "enterprise_v1",
        executive_manager_agent_id: executiveManagerAgentId,
        allow_director_to_spawn_workers: true
      }
    });
  }

  const preferredDepartment = departments[0];
  const defaultActorId =
    orgMode === "enterprise"
      ? executiveManagerAgentId ?? preferredDepartment?.director_agent_id ?? ceoAgentId ?? "human"
      : directorAgentId ?? preferredDepartment?.director_agent_id ?? ceoAgentId ?? "human";
  const defaultActorRole: "human" | "ceo" | "director" | "manager" | "worker" =
    orgMode === "enterprise"
      ? "manager"
      : directorAgentId || preferredDepartment
        ? "director"
        : includeCeo
          ? "ceo"
          : "human";

  return {
    workspace_dir: workspaceDir,
    company_name: companyName,
    project_id: project.project_id,
    org_mode: orgMode,
    departments,
    agents: {
      ceo_agent_id: ceoAgentId,
      director_agent_id: directorAgentId,
      executive_manager_agent_id: executiveManagerAgentId
    },
    default_session: {
      project_id: project.project_id,
      actor_id: defaultActorId,
      actor_role: defaultActorRole,
      actor_team_id: preferredDepartment?.team_id
    }
  };
}
