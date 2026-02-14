import fs from "node:fs/promises";
import path from "node:path";
import type { Dirent } from "node:fs";
import { AgentYaml } from "../schemas/agent.js";
import { TeamYaml } from "../schemas/team.js";
import { readYamlFile } from "../store/yaml.js";
import { createAgent } from "../org/agents.js";
import { listConversations, createConversation, upsertConversation } from "./store.js";
import type { ConversationYaml } from "../schemas/conversation.js";

export const GLOBAL_MANAGER_AGENT_ID = "agent_global_manager";

function projectSecretaryAgentId(projectId: string): string {
  return `agent_secretary_${projectId}`;
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

async function listAgents(workspaceDir: string): Promise<AgentYaml[]> {
  const root = path.join(workspaceDir, "org", "agents");
  let entries: Dirent[] = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: AgentYaml[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      out.push(AgentYaml.parse(await readYamlFile(path.join(root, entry.name, "agent.yaml"))));
    } catch {
      // best-effort
    }
  }
  return out;
}

async function listTeams(workspaceDir: string): Promise<TeamYaml[]> {
  const root = path.join(workspaceDir, "org", "teams");
  let entries: Dirent[] = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: TeamYaml[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      out.push(TeamYaml.parse(await readYamlFile(path.join(root, entry.name, "team.yaml"))));
    } catch {
      // best-effort
    }
  }
  return out;
}

async function ensureGlobalManagerAgent(workspaceDir: string): Promise<string> {
  const p = path.join(workspaceDir, "org", "agents", GLOBAL_MANAGER_AGENT_ID, "agent.yaml");
  try {
    await fs.access(p);
    return GLOBAL_MANAGER_AGENT_ID;
  } catch {
    await createAgent({
      workspace_dir: workspaceDir,
      id: GLOBAL_MANAGER_AGENT_ID,
      name: "General Manager",
      display_title: "Global Assistant",
      model_hint: "codex",
      role: "manager",
      provider: "codex"
    });
    return GLOBAL_MANAGER_AGENT_ID;
  }
}

async function ensureProjectSecretaryAgent(workspaceDir: string, projectId: string): Promise<string> {
  const id = projectSecretaryAgentId(projectId);
  const p = path.join(workspaceDir, "org", "agents", id, "agent.yaml");
  try {
    await fs.access(p);
    return id;
  } catch {
    await createAgent({
      workspace_dir: workspaceDir,
      id,
      name: `Project Secretary ${projectId}`,
      display_title: "Executive Secretary",
      model_hint: "codex",
      role: "worker",
      provider: "codex"
    });
    return id;
  }
}

async function upsertDefaultConversation(
  workspaceDir: string,
  scope: "workspace" | "project",
  params: {
    id: string;
    project_id?: string;
    name: string;
    slug: string;
    kind: "home" | "channel" | "dm";
    visibility: "private_agent" | "team" | "managers" | "org";
    participants: { agent_ids: string[]; team_ids?: string[] };
    created_by: string;
    dm_peer_agent_id?: string;
  }
): Promise<ConversationYaml> {
  const rows = await listConversations({
    workspace_dir: workspaceDir,
    scope,
    project_id: params.project_id
  });
  const existing = rows.find((c) => c.id === params.id);
  if (existing) {
    const next: ConversationYaml = {
      ...existing,
      name: params.name,
      slug: params.slug,
      visibility: params.visibility,
      auto_generated: true,
      participants: {
        agent_ids: [...new Set(params.participants.agent_ids)],
        team_ids: [...new Set(params.participants.team_ids ?? [])]
      },
      dm_peer_agent_id: params.dm_peer_agent_id
    };
    return upsertConversation({ workspace_dir: workspaceDir, conversation: next });
  }
  return createConversation({
    workspace_dir: workspaceDir,
    scope,
    project_id: params.project_id,
    id: params.id,
    kind: params.kind,
    name: params.name,
    slug: params.slug,
    visibility: params.visibility,
    created_by: params.created_by,
    auto_generated: true,
    participants: params.participants,
    dm_peer_agent_id: params.dm_peer_agent_id
  });
}

export async function ensureWorkspaceDefaults(args: {
  workspace_dir: string;
  ceo_actor_id?: string;
  executive_manager_agent_id?: string;
}): Promise<{
  global_manager_agent_id: string;
  workspace_home_conversation_id: string;
  workspace_executive_office_conversation_id: string;
}> {
  const ceoActor = (args.ceo_actor_id ?? "human_ceo").trim() || "human_ceo";
  const gm = await ensureGlobalManagerAgent(args.workspace_dir);
  const executiveManagerId = args.executive_manager_agent_id?.trim() || gm;
  await upsertDefaultConversation(args.workspace_dir, "workspace", {
    id: "conv_workspace_home",
    name: "Workspace Home",
    slug: "home",
    kind: "home",
    visibility: "org",
    created_by: gm,
    participants: {
      agent_ids: [ceoActor, gm]
    }
  });
  await upsertDefaultConversation(args.workspace_dir, "workspace", {
    id: "conv_workspace_executive_office",
    name: "Executive Office",
    slug: "executive-office",
    kind: "channel",
    visibility: "org",
    created_by: executiveManagerId,
    participants: {
      agent_ids: [...new Set([ceoActor, executiveManagerId])]
    }
  });
  return {
    global_manager_agent_id: gm,
    workspace_home_conversation_id: "conv_workspace_home",
    workspace_executive_office_conversation_id: "conv_workspace_executive_office"
  };
}

export async function ensureProjectDefaults(args: {
  workspace_dir: string;
  project_id: string;
  ceo_actor_id?: string;
  executive_manager_agent_id?: string;
}): Promise<{
  global_manager_agent_id: string;
  project_secretary_agent_id: string;
  conversation_ids: string[];
}> {
  const ceoActor = (args.ceo_actor_id ?? "human_ceo").trim() || "human_ceo";
  const executiveManagerId = args.executive_manager_agent_id?.trim() || undefined;
  const ws = await ensureWorkspaceDefaults({
    workspace_dir: args.workspace_dir,
    ceo_actor_id: ceoActor,
    executive_manager_agent_id: executiveManagerId
  });
  const secretaryId = await ensureProjectSecretaryAgent(args.workspace_dir, args.project_id);
  const agents = await listAgents(args.workspace_dir);
  const teams = await listTeams(args.workspace_dir);
  const ceoAgentIds = agents.filter((a) => a.role === "ceo").map((a) => a.id);
  const directorAgentIds = agents.filter((a) => a.role === "director").map((a) => a.id);
  const managerAgentIds = agents.filter((a) => a.role === "manager").map((a) => a.id);
  const chosenExecutiveManager =
    executiveManagerId ??
    agents.find((a) => a.role === "manager" && a.display_title === "Executive Manager")?.id ??
    ws.global_manager_agent_id;

  const topParticipants = [
    ...new Set([ceoActor, ...ceoAgentIds, ws.global_manager_agent_id, chosenExecutiveManager, secretaryId])
  ];
  const conversationIds: string[] = [];

  const home = await upsertDefaultConversation(args.workspace_dir, "project", {
    id: `conv_${args.project_id}_home`,
    project_id: args.project_id,
    name: "Home",
    slug: "home",
    kind: "home",
    visibility: "org",
    created_by: ws.global_manager_agent_id,
    participants: {
      agent_ids: topParticipants
    }
  });
  conversationIds.push(home.id);

  const executiveOffice = await upsertDefaultConversation(args.workspace_dir, "project", {
    id: `conv_${args.project_id}_executive_office`,
    project_id: args.project_id,
    name: "Executive Office",
    slug: "executive-office",
    kind: "channel",
    visibility: "org",
    created_by: chosenExecutiveManager,
    participants: {
      agent_ids: [...new Set([ceoActor, chosenExecutiveManager, secretaryId])]
    }
  });
  conversationIds.push(executiveOffice.id);

  const planningCouncil = await upsertDefaultConversation(args.workspace_dir, "project", {
    id: `conv_${args.project_id}_planning_council`,
    project_id: args.project_id,
    name: "Planning Council",
    slug: "planning-council",
    kind: "channel",
    visibility: "org",
    created_by: chosenExecutiveManager,
    participants: {
      agent_ids: [...new Set([ceoActor, chosenExecutiveManager, ...directorAgentIds])]
    }
  });
  conversationIds.push(planningCouncil.id);

  const exec = await upsertDefaultConversation(args.workspace_dir, "project", {
    id: `conv_${args.project_id}_executive_meeting`,
    project_id: args.project_id,
    name: "Executive Meeting",
    slug: "executive-meeting",
    kind: "channel",
    visibility: "org",
    created_by: ws.global_manager_agent_id,
    participants: {
      agent_ids: [...new Set([...topParticipants, ...directorAgentIds, ...managerAgentIds])]
    }
  });
  conversationIds.push(exec.id);

  for (const team of teams) {
    const teamMemberIds = agents.filter((a) => a.team_id === team.id).map((a) => a.id);
    const conv = await upsertDefaultConversation(args.workspace_dir, "project", {
      id: `conv_${args.project_id}_team_${team.id}`,
      project_id: args.project_id,
      name: team.name,
      slug: slugify(team.name),
      kind: "channel",
      visibility: "team",
      created_by: chosenExecutiveManager,
      participants: {
        agent_ids: [...new Set([...teamMemberIds, chosenExecutiveManager].filter(Boolean))],
        team_ids: [team.id]
      }
    });
    conversationIds.push(conv.id);
  }

  return {
    global_manager_agent_id: ws.global_manager_agent_id,
    project_secretary_agent_id: secretaryId,
    conversation_ids: conversationIds
  };
}
