import fs from "node:fs/promises";
import path from "node:path";
import type { Dirent } from "node:fs";
import { AgentYaml } from "../schemas/agent.js";
import { readYamlFile } from "../store/yaml.js";

export type ListedAgent = {
  agent_id: string;
  name: string;
  display_title?: string;
  avatar?: string;
  role: "ceo" | "director" | "manager" | "worker";
  provider: string;
  model_hint?: string;
  team_id?: string;
  created_at: string;
};

export async function listAgents(args: {
  workspace_dir: string;
  role?: "ceo" | "director" | "manager" | "worker";
  team_id?: string;
}): Promise<ListedAgent[]> {
  const root = path.join(args.workspace_dir, "org", "agents");
  let entries: Dirent[] = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: ListedAgent[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      const a = AgentYaml.parse(await readYamlFile(path.join(root, e.name, "agent.yaml")));
      if (args.role && a.role !== args.role) continue;
      if (args.team_id && a.team_id !== args.team_id) continue;
      out.push({
        agent_id: a.id,
        name: a.name,
        display_title: a.display_title,
        avatar: a.avatar,
        role: a.role,
        provider: a.provider,
        model_hint: a.model_hint,
        team_id: a.team_id,
        created_at: a.created_at
      });
    } catch {
      // best-effort
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
