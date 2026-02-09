import path from "node:path";
import { newId } from "../core/ids.js";
import { nowIso } from "../core/time.js";
import { ensureDir, writeFileAtomic } from "../store/fs.js";
import { writeYamlFile } from "../store/yaml.js";

export type CreateAgentArgs = {
  workspace_dir: string;
  name: string;
  role: "ceo" | "director" | "manager" | "worker";
  provider: string;
  team_id?: string;
  id?: string;
  launcher?: Record<string, unknown>;
};

export async function createAgent(args: CreateAgentArgs): Promise<{ agent_id: string }> {
  const agentId = args.id ?? newId("agent");
  const agentDir = path.join(args.workspace_dir, "org/agents", agentId);
  await ensureDir(agentDir);

  await writeYamlFile(path.join(agentDir, "agent.yaml"), {
    schema_version: 1,
    type: "agent",
    id: agentId,
    name: args.name,
    role: args.role,
    provider: args.provider,
    team_id: args.team_id,
    created_at: nowIso(),
    launcher: args.launcher ?? {}
  });

  // Journals are append-only; v0 creates a file with basic structure.
  await writeFileAtomic(
    path.join(agentDir, "journal.md"),
    `# Agent Journal (Append-only)\n\n- created_at: ${nowIso()}\n- agent_id: ${agentId}\n\n## Entries\n`
  );

  return { agent_id: agentId };
}
