import path from "node:path";
import { newId } from "../core/ids.js";
import { nowIso } from "../core/time.js";
import { ensureDir, writeFileAtomic } from "../store/fs.js";
import { writeYamlFile } from "../store/yaml.js";

export type CreateAgentArgs = {
  workspace_dir: string;
  name: string;
  display_title?: string;
  avatar?: string;
  model_hint?: string;
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
    display_title: args.display_title,
    avatar: args.avatar,
    model_hint: args.model_hint,
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

  await writeFileAtomic(
    path.join(agentDir, "AGENTS.md"),
    [
      `# AGENTS.md - ${agentId}`,
      "",
      "## Operating Rules",
      "- Follow the assigned task contract and milestone acceptance criteria.",
      "- Produce required evidence artifacts for coding milestones (patch/commit + tests).",
      "- Report blockers early with concrete evidence.",
      "",
      "## Recurring Mistakes To Avoid",
      ""
    ].join("\n")
  );

  await writeFileAtomic(
    path.join(agentDir, "role.md"),
    [
      `# Role - ${args.name}`,
      "",
      `- role: ${args.role}`,
      `- display_title: ${args.display_title ?? args.role}`,
      `- provider: ${args.provider}`,
      args.team_id ? `- team_id: ${args.team_id}` : "- team_id: unassigned",
      "",
      "## Duties",
      "- Execute assigned work scoped to this role and team.",
      "- Keep artifacts, tasks, and evidence auditable.",
      "",
      "## Boundaries",
      "- Do not bypass policy, approval, or memory governance paths.",
      "- Do not assign or launch cross-team work without explicit approval.",
      "",
      "## Escalation",
      "- Raise blockers, policy denials, budget risks, and secret-risk findings to manager/CEO."
    ].join("\n")
  );

  await writeFileAtomic(
    path.join(agentDir, "skills_index.md"),
    [
      `# Skills Index - ${args.name}`,
      "",
      "## Approved Skills",
      "- Core workspace navigation and task execution",
      "- Artifact authoring and validation",
      "- Policy-aware collaboration and escalation",
      "",
      "## Approved References",
      "- company/company.yaml",
      "- company/policy.yaml",
      "- org/teams/<team>/memory.md",
      "- work/projects/<project>/memory.md",
      "",
      "## Forbidden",
      "- Direct memory mutation outside propose/approve workflows",
      "- Cross-team access without policy-checked approval"
    ].join("\n")
  );

  return { agent_id: agentId };
}
