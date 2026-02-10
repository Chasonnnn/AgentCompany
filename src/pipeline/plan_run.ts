import fs from "node:fs/promises";
import path from "node:path";
import { scaffoldProjectIntake } from "./intake_scaffold.js";
import { fillArtifactWithProvider } from "./artifact_fill.js";
import { readYamlFile } from "../store/yaml.js";
import { AgentYaml } from "../schemas/agent.js";
import { TeamYaml } from "../schemas/team.js";

export type PlanningPipelineArgs = {
  workspace_dir: string;
  project_name: string;
  ceo_agent_id: string;
  director_agent_id: string;
  manager_agent_ids: string[];
  // CEO-provided brief text (plain text or markdown).
  intake_brief: string;
  // Optional model override passed through to provider drivers.
  model?: string;
};

export type PlanningPipelineResult = {
  project_id: string;
  intake_brief: {
    artifact_id: string;
    run_id: string;
    context_pack_id: string;
  };
  manager_proposals: Record<
    string,
    {
      artifact_id: string;
      run_id: string;
      context_pack_id: string;
    }
  >;
  workplan: {
    artifact_id: string;
    run_id: string;
    context_pack_id: string;
  };
};

async function readAgent(workspaceDir: string, agentId: string): Promise<AgentYaml> {
  const p = path.join(workspaceDir, "org/agents", agentId, "agent.yaml");
  return AgentYaml.parse(await readYamlFile(p));
}

async function readTeamName(workspaceDir: string, teamId?: string): Promise<string | undefined> {
  if (!teamId) return undefined;
  const p = path.join(workspaceDir, "org/teams", teamId, "team.yaml");
  try {
    return TeamYaml.parse(await readYamlFile(p)).name;
  } catch {
    return undefined;
  }
}

async function readProjectArtifactMarkdown(
  workspaceDir: string,
  projectId: string,
  artifactId: string
): Promise<string> {
  const p = path.join(workspaceDir, "work/projects", projectId, "artifacts", `${artifactId}.md`);
  return fs.readFile(p, { encoding: "utf8" });
}

function buildIntakePrompt(brief: string): string {
  return [
    "Use the CEO brief below to fill this intake artifact.",
    "Translate the brief into concrete bullet points under the required headings.",
    "",
    "CEO brief:",
    brief.trim()
  ].join("\n");
}

function buildManagerProposalPrompt(args: {
  project_name: string;
  manager_name: string;
  team_label: string;
  intake_brief_artifact_md: string;
}): string {
  return [
    `Project: ${args.project_name}`,
    `You are the department manager: ${args.manager_name} (${args.team_label}).`,
    "",
    "Write a departmental proposal aligned to the intake brief.",
    "In your Plan section, include:",
    "- Deliverables (artifact-backed where applicable)",
    "- Milestones (1-3 checkpoints)",
    "- Dependencies on other teams",
    "- Any repo/workstream scope assumptions",
    "",
    "In your Risks section, include risks and mitigations.",
    "",
    "Intake brief (reference):",
    args.intake_brief_artifact_md.trim()
  ].join("\n");
}

function buildDirectorWorkplanPrompt(args: {
  project_name: string;
  intake_brief_artifact_md: string;
  manager_proposals: Array<{ manager_label: string; proposal_md: string }>;
}): string {
  const proposals = args.manager_proposals
    .map((p) => `# ${p.manager_label}\n\n${p.proposal_md.trim()}`)
    .join("\n\n");

  return [
    `Project: ${args.project_name}`,
    "You are the Director. Synthesize a single org-level workplan from the intake brief and manager proposals.",
    "",
    "Requirements:",
    "- Breakdown: epics -> tasks -> milestones (clear, scoped, with acceptance criteria where possible).",
    "- Dependencies: cross-team dependencies and ordering constraints.",
    "- Estimates: rough time estimates with confidence and method; token/cost optional but label the source (reported vs estimated).",
    "- Optional: Mermaid Gantt if it improves clarity.",
    "",
    "Intake brief:",
    args.intake_brief_artifact_md.trim(),
    "",
    "Manager proposals:",
    proposals
  ].join("\n");
}

export async function runPlanningPipeline(args: PlanningPipelineArgs): Promise<PlanningPipelineResult> {
  if (!args.intake_brief.trim()) {
    throw new Error("intake_brief must be non-empty");
  }
  if (args.manager_agent_ids.length === 0) {
    throw new Error("manager_agent_ids must be non-empty");
  }

  const scaffold = await scaffoldProjectIntake({
    workspace_dir: args.workspace_dir,
    project_name: args.project_name,
    ceo_agent_id: args.ceo_agent_id,
    director_agent_id: args.director_agent_id,
    manager_agent_ids: args.manager_agent_ids
  });

  const intakeFill = await fillArtifactWithProvider({
    workspace_dir: args.workspace_dir,
    project_id: scaffold.project_id,
    artifact_id: scaffold.artifacts.intake_brief_artifact_id,
    agent_id: args.ceo_agent_id,
    model: args.model,
    prompt: buildIntakePrompt(args.intake_brief)
  });
  if (!intakeFill.ok) {
    throw new Error(`Failed to fill intake brief: ${intakeFill.error}`);
  }
  const intakeMd = await readProjectArtifactMarkdown(
    args.workspace_dir,
    scaffold.project_id,
    scaffold.artifacts.intake_brief_artifact_id
  );

  const proposalResults: PlanningPipelineResult["manager_proposals"] = {};
  const proposalsForDirector: Array<{ manager_label: string; proposal_md: string }> = [];

  for (const managerId of args.manager_agent_ids) {
    const agent = await readAgent(args.workspace_dir, managerId);
    const teamName = await readTeamName(args.workspace_dir, agent.team_id);
    const teamLabel = teamName ? `team=${teamName}` : agent.team_id ? `team_id=${agent.team_id}` : "no_team";

    const proposalArtifactId = scaffold.artifacts.manager_proposal_artifact_ids[managerId];
    if (!proposalArtifactId) {
      throw new Error(`Internal error: missing proposal artifact id for manager ${managerId}`);
    }

    const fill = await fillArtifactWithProvider({
      workspace_dir: args.workspace_dir,
      project_id: scaffold.project_id,
      artifact_id: proposalArtifactId,
      agent_id: managerId,
      model: args.model,
      prompt: buildManagerProposalPrompt({
        project_name: args.project_name,
        manager_name: agent.name,
        team_label: teamLabel,
        intake_brief_artifact_md: intakeMd
      })
    });
    if (!fill.ok) {
      throw new Error(`Failed to fill proposal for manager ${managerId}: ${fill.error}`);
    }

    proposalResults[managerId] = {
      artifact_id: proposalArtifactId,
      run_id: fill.run_id,
      context_pack_id: fill.context_pack_id
    };

    const proposalMd = await readProjectArtifactMarkdown(
      args.workspace_dir,
      scaffold.project_id,
      proposalArtifactId
    );
    proposalsForDirector.push({
      manager_label: `Manager Proposal: ${agent.name} (${teamLabel})`,
      proposal_md: proposalMd
    });
  }

  const workplanFill = await fillArtifactWithProvider({
    workspace_dir: args.workspace_dir,
    project_id: scaffold.project_id,
    artifact_id: scaffold.artifacts.workplan_artifact_id,
    agent_id: args.director_agent_id,
    model: args.model,
    prompt: buildDirectorWorkplanPrompt({
      project_name: args.project_name,
      intake_brief_artifact_md: intakeMd,
      manager_proposals: proposalsForDirector
    })
  });
  if (!workplanFill.ok) {
    throw new Error(`Failed to fill workplan: ${workplanFill.error}`);
  }

  return {
    project_id: scaffold.project_id,
    intake_brief: {
      artifact_id: scaffold.artifacts.intake_brief_artifact_id,
      run_id: intakeFill.run_id,
      context_pack_id: intakeFill.context_pack_id
    },
    manager_proposals: proposalResults,
    workplan: {
      artifact_id: scaffold.artifacts.workplan_artifact_id,
      run_id: workplanFill.run_id,
      context_pack_id: workplanFill.context_pack_id
    }
  };
}

