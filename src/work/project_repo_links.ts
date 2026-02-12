import path from "node:path";
import { nowIso } from "../core/time.js";
import { ensureDir } from "../store/fs.js";
import { readYamlFile, writeYamlFile } from "../store/yaml.js";
import { ProjectRepoLinksYaml, type ProjectRepoLinksYaml as ProjectRepoLinksYamlType } from "../schemas/project_repo_links.js";

function repoLinksPath(workspaceDir: string, projectId: string): string {
  return path.join(workspaceDir, "work", "projects", projectId, "repos.yaml");
}

function defaultDoc(projectId: string): ProjectRepoLinksYamlType {
  return {
    schema_version: 1,
    type: "project_repo_links",
    project_id: projectId,
    updated_at: nowIso(),
    repos: []
  };
}

export async function readProjectRepoLinks(args: {
  workspace_dir: string;
  project_id: string;
}): Promise<ProjectRepoLinksYamlType> {
  const p = repoLinksPath(args.workspace_dir, args.project_id);
  try {
    return ProjectRepoLinksYaml.parse(await readYamlFile(p));
  } catch {
    return defaultDoc(args.project_id);
  }
}

export async function linkProjectRepo(args: {
  workspace_dir: string;
  project_id: string;
  repo_id: string;
  label?: string;
}): Promise<ProjectRepoLinksYamlType> {
  const p = repoLinksPath(args.workspace_dir, args.project_id);
  await ensureDir(path.dirname(p));

  const current = await readProjectRepoLinks({
    workspace_dir: args.workspace_dir,
    project_id: args.project_id
  });
  const deduped = current.repos.filter((r) => r.repo_id !== args.repo_id);
  deduped.push({
    repo_id: args.repo_id,
    label: args.label?.trim() || undefined
  });
  const next: ProjectRepoLinksYamlType = {
    ...current,
    updated_at: nowIso(),
    repos: deduped.sort((a, b) => a.repo_id.localeCompare(b.repo_id))
  };
  await writeYamlFile(p, next);
  return next;
}
