import path from "node:path";
import { newId } from "../core/ids.js";
import { nowIso } from "../core/time.js";
import { ensureDir, writeFileAtomic } from "../store/fs.js";
import { writeYamlFile } from "../store/yaml.js";

export type CreateProjectArgs = {
  workspace_dir: string;
  name: string;
  id?: string;
};

export async function createProject(args: CreateProjectArgs): Promise<{ project_id: string }> {
  const projectId = args.id ?? newId("proj");
  const projDir = path.join(args.workspace_dir, "work/projects", projectId);
  await ensureDir(projDir);
  await ensureDir(path.join(projDir, "tasks"));
  await ensureDir(path.join(projDir, "artifacts"));
  await ensureDir(path.join(projDir, "context_packs"));
  await ensureDir(path.join(projDir, "runs"));
  await ensureDir(path.join(projDir, "share_packs"));

  await writeYamlFile(path.join(projDir, "project.yaml"), {
    schema_version: 1,
    type: "project",
    id: projectId,
    name: args.name,
    status: "active",
    created_at: nowIso()
  });

  await writeFileAtomic(
    path.join(projDir, "memory.md"),
    `# Project Memory (Curated)\n\n## Summary\n\n## Decisions\n\n## Links\n`
  );

  return { project_id: projectId };
}

