import fs from "node:fs/promises";
import path from "node:path";
import type { Dirent } from "node:fs";
import { ProjectYaml } from "../schemas/project.js";
import { readYamlFile } from "../store/yaml.js";

export type ListedProject = {
  project_id: string;
  name: string;
  status: "active" | "archived";
  created_at: string;
};

export async function listProjects(args: { workspace_dir: string }): Promise<ListedProject[]> {
  const projectsRoot = path.join(args.workspace_dir, "work", "projects");
  let entries: Dirent[] = [];
  try {
    entries = await fs.readdir(projectsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: ListedProject[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projectId = entry.name;
    try {
      const parsed = ProjectYaml.parse(await readYamlFile(path.join(projectsRoot, projectId, "project.yaml")));
      out.push({
        project_id: parsed.id,
        name: parsed.name,
        status: parsed.status,
        created_at: parsed.created_at
      });
    } catch {
      // workspace validation reports malformed project docs; list stays best effort.
    }
  }

  out.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  return out;
}
