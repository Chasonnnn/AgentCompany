import fs from "node:fs/promises";
import path from "node:path";
import type { Dirent } from "node:fs";
import { TeamYaml } from "../schemas/team.js";
import { readYamlFile } from "../store/yaml.js";

export type ListedTeam = {
  team_id: string;
  name: string;
  department_key?: string;
  department_label?: string;
  charter?: string;
  created_at: string;
};

export async function listTeams(args: { workspace_dir: string }): Promise<ListedTeam[]> {
  const root = path.join(args.workspace_dir, "org", "teams");
  let entries: Dirent[] = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: ListedTeam[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      const doc = TeamYaml.parse(await readYamlFile(path.join(root, e.name, "team.yaml")));
      out.push({
        team_id: doc.id,
        name: doc.name,
        department_key: doc.department_key,
        department_label: doc.department_label,
        charter: doc.charter,
        created_at: doc.created_at
      });
    } catch {
      // best-effort
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
