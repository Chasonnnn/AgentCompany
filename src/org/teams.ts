import path from "node:path";
import { newId } from "../core/ids.js";
import { nowIso } from "../core/time.js";
import { ensureDir, writeFileAtomic } from "../store/fs.js";
import { writeYamlFile } from "../store/yaml.js";

export type CreateTeamArgs = {
  workspace_dir: string;
  name: string;
  id?: string;
};

export async function createTeam(args: CreateTeamArgs): Promise<{ team_id: string }> {
  const teamId = args.id ?? newId("team");
  const teamDir = path.join(args.workspace_dir, "org/teams", teamId);
  await ensureDir(teamDir);

  await writeYamlFile(path.join(teamDir, "team.yaml"), {
    schema_version: 1,
    type: "team",
    id: teamId,
    name: args.name,
    created_at: nowIso()
  });

  await writeFileAtomic(
    path.join(teamDir, "memory.md"),
    `# Team Memory (Curated)\n\n## Principles\n\n## Decisions\n\n## Links\n`
  );

  return { team_id: teamId };
}

