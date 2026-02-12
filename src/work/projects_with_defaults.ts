import { createProject } from "./projects.js";
import { linkProjectRepo, readProjectRepoLinks } from "./project_repo_links.js";
import { ensureProjectDefaults } from "../conversations/defaults.js";

export async function createProjectWithDefaults(args: {
  workspace_dir: string;
  name: string;
  ceo_actor_id?: string;
  repo_ids?: string[];
}): Promise<{
  project_id: string;
  global_manager_agent_id: string;
  project_secretary_agent_id: string;
  conversation_ids: string[];
  repo_links: { repo_id: string; label?: string }[];
}> {
  const created = await createProject({
    workspace_dir: args.workspace_dir,
    name: args.name
  });
  const defaults = await ensureProjectDefaults({
    workspace_dir: args.workspace_dir,
    project_id: created.project_id,
    ceo_actor_id: args.ceo_actor_id
  });

  for (const repoIdRaw of args.repo_ids ?? []) {
    const repoId = repoIdRaw.trim();
    if (!repoId) continue;
    await linkProjectRepo({
      workspace_dir: args.workspace_dir,
      project_id: created.project_id,
      repo_id: repoId
    });
  }
  const links = await readProjectRepoLinks({
    workspace_dir: args.workspace_dir,
    project_id: created.project_id
  });

  return {
    project_id: created.project_id,
    global_manager_agent_id: defaults.global_manager_agent_id,
    project_secretary_agent_id: defaults.project_secretary_agent_id,
    conversation_ids: defaults.conversation_ids,
    repo_links: links.repos
  };
}
