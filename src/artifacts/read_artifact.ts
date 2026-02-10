import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { parseFrontMatter } from "./frontmatter.js";
import { Visibility } from "../schemas/common.js";
import { enforcePolicy } from "../policy/enforce.js";
import type { ActorRole } from "../policy/policy.js";
import { readYamlFile } from "../store/yaml.js";
import { AgentYaml } from "../schemas/agent.js";

const ArtifactReadFrontMatter = z.object({
  id: z.string().min(1),
  visibility: Visibility,
  produced_by: z.string().min(1),
  run_id: z.string().min(1).optional()
});

export type ReadArtifactArgs = {
  workspace_dir: string;
  project_id: string;
  artifact_id: string;
  actor_id: string;
  actor_role: ActorRole;
  actor_team_id?: string;
  run_id?: string;
};

export type ReadArtifactResult = {
  artifact_id: string;
  artifact_relpath: string;
  frontmatter: Record<string, unknown>;
  markdown: string;
};

async function resolveProducerTeamId(
  workspaceDir: string,
  producedBy: string
): Promise<string | undefined> {
  if (!producedBy.startsWith("agent_")) return undefined;
  const agentPath = path.join(workspaceDir, "org/agents", producedBy, "agent.yaml");
  try {
    const doc = AgentYaml.parse(await readYamlFile(agentPath));
    return doc.team_id;
  } catch {
    return undefined;
  }
}

export async function readArtifactWithPolicy(args: ReadArtifactArgs): Promise<ReadArtifactResult> {
  const rel = path.join(
    "work/projects",
    args.project_id,
    "artifacts",
    `${args.artifact_id}.md`
  );
  const abs = path.join(args.workspace_dir, rel);
  const markdown = await fs.readFile(abs, { encoding: "utf8" });

  const parsed = parseFrontMatter(markdown);
  if (!parsed.ok) throw new Error(`Invalid artifact front matter: ${parsed.error}`);
  const fm = ArtifactReadFrontMatter.parse(parsed.frontmatter);

  const producerTeamId = await resolveProducerTeamId(args.workspace_dir, fm.produced_by);
  const auditRunId = args.run_id ?? fm.run_id;

  await enforcePolicy({
    workspace_dir: args.workspace_dir,
    project_id: args.project_id,
    run_id: auditRunId,
    actor_id: args.actor_id,
    actor_role: args.actor_role,
    actor_team_id: args.actor_team_id,
    action: "read",
    resource: {
      resource_id: fm.id,
      visibility: fm.visibility,
      team_id: producerTeamId,
      producing_actor_id: fm.produced_by,
      kind: "artifact"
    }
  });

  if (!parsed.frontmatter || typeof parsed.frontmatter !== "object") {
    throw new Error("Artifact front matter is not an object");
  }
  return {
    artifact_id: fm.id,
    artifact_relpath: rel,
    frontmatter: parsed.frontmatter as Record<string, unknown>,
    markdown
  };
}
