import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { nowIso } from "../core/time.js";
import { createRun } from "../runtime/run.js";
import { executeCommandRun } from "../runtime/execute_command.js";
import { newEnvelope, appendEventJsonl } from "../runtime/events.js";
import { createProjectArtifactFile } from "../work/project_artifacts.js";
import { parseFrontMatter } from "../artifacts/frontmatter.js";
import { validateMarkdownArtifact, type ArtifactType } from "../artifacts/markdown.js";
import { writeFileAtomic, pathExists } from "../store/fs.js";
import { proposeMemoryDelta } from "../memory/propose_memory_delta.js";
import { recordAgentMistake } from "./mistake_loop.js";
import type { ActorRole } from "../policy/policy.js";

type CycleStatus = "recorded_only" | "already_guided" | "evaluation_failed" | "proposal_created";

export type RunSelfImproveCycleArgs = {
  workspace_dir: string;
  project_id: string;
  worker_agent_id: string;
  manager_actor_id: string;
  manager_role: ActorRole;
  mistake_key: string;
  summary: string;
  prevention_rule: string;
  proposal_threshold?: number;
  promote_threshold?: number;
  evidence_artifact_ids?: string[];
  task_id?: string;
  milestone_id?: string;
  evaluation_argv?: string[];
  evaluation_repo_id?: string;
  evaluation_workdir_rel?: string;
  evaluation_env?: Record<string, string>;
};

export type RunSelfImproveCycleResult = {
  status: CycleStatus;
  worker_agent_id: string;
  project_id: string;
  mistake_key: string;
  mistake_count: number;
  proposal_threshold: number;
  promoted_to_agents_md: boolean;
  run_id?: string;
  context_pack_id?: string;
  evaluation_exit_code?: number | null;
  evaluation_signal?: string | null;
  evaluation_artifact_id?: string;
  evaluation_artifact_relpath?: string;
  evaluation_artifact_type?: "manager_digest" | "failure_report";
  memory_delta_artifact_id?: string;
  memory_delta_artifact_relpath?: string;
  memory_delta_patch_relpath?: string;
  target_file?: string;
};

function defaultEvaluationArgv(): string[] {
  return [process.execPath, "-e", "console.log('self_improve_eval_noop')"];
}

function buildRuleLine(args: {
  mistake_key: string;
  prevention_rule: string;
  count: number;
  manager_actor_id: string;
}): string {
  return `- <!-- mistake:${args.mistake_key} --> [${args.mistake_key}] ${args.prevention_rule} (observed ${args.count} repeats; proposed by ${args.manager_actor_id})`;
}

async function readFileIfExists(absPath: string): Promise<string> {
  if (!(await pathExists(absPath))) return "";
  return fs.readFile(absPath, { encoding: "utf8" });
}

async function appendRunEvent(args: {
  workspace_dir: string;
  project_id: string;
  run_id: string;
  actor: string;
  visibility: "private_agent" | "team" | "managers" | "org";
  type: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  const eventsAbs = path.join(
    args.workspace_dir,
    "work/projects",
    args.project_id,
    "runs",
    args.run_id,
    "events.jsonl"
  );
  await appendEventJsonl(
    eventsAbs,
    newEnvelope({
      schema_version: 1,
      ts_wallclock: nowIso(),
      run_id: args.run_id,
      session_ref: `local_${args.run_id}`,
      actor: args.actor,
      visibility: args.visibility,
      type: args.type,
      payload: args.payload
    })
  );
}

function renderEvaluationBody(args: {
  title: string;
  type: ArtifactType;
  count: number;
  proposal_threshold: number;
  mistake_key: string;
  summary: string;
  prevention_rule: string;
  worker_agent_id: string;
  manager_actor_id: string;
  run_id: string;
  evaluation_argv: string[];
  evaluation_exit_code: number | null;
  evaluation_signal: string | null;
  evidence_artifact_ids: string[];
  proposed_memory_delta_artifact_id?: string;
}): string {
  const evalState =
    args.evaluation_exit_code === 0 && args.evaluation_signal === null
      ? "passed"
      : `failed (exit_code=${args.evaluation_exit_code ?? "null"}, signal=${args.evaluation_signal ?? "null"})`;
  const base = [
    `# ${args.title}`,
    "",
    "## Summary",
    "",
    `- worker_agent_id: \`${args.worker_agent_id}\``,
    `- manager_actor_id: \`${args.manager_actor_id}\``,
    `- mistake_key: \`${args.mistake_key}\``,
    `- mistake_count: ${args.count} (threshold=${args.proposal_threshold})`,
    `- evaluation: ${evalState}`,
    `- run_id: \`${args.run_id}\``,
    "",
    "## Decisions",
    "",
    `- summary: ${args.summary}`,
    `- prevention_rule: ${args.prevention_rule}`,
    `- evaluation_argv: \`${args.evaluation_argv.join(" ")}\``
  ];

  if (args.proposed_memory_delta_artifact_id) {
    base.push(
      `- proposed_memory_delta_artifact_id: \`${args.proposed_memory_delta_artifact_id}\``
    );
  } else {
    base.push("- proposed_memory_delta_artifact_id: (none)");
  }

  if (args.evidence_artifact_ids.length) {
    base.push("- evidence:");
    for (const id of args.evidence_artifact_ids) base.push(`  - \`${id}\``);
  } else {
    base.push("- evidence: (none)");
  }

  if (args.type === "manager_digest") {
    base.push("", "## Risks", "", "- Ensure manager review approves the pending memory delta before apply.");
    return `${base.join("\n")}\n`;
  }

  base.push("", "## Cause", "", "- Evaluation command did not pass quality gates.");
  base.push("", "## Next Steps", "", "- Inspect run outputs and fix failing checks before proposing changes.");
  return `${base.join("\n")}\n`;
}

async function overwriteArtifactMarkdown(args: {
  workspace_dir: string;
  artifact_relpath: string;
  markdown_body: string;
}): Promise<void> {
  const abs = path.join(args.workspace_dir, args.artifact_relpath);
  const seed = await fs.readFile(abs, { encoding: "utf8" });
  const parsed = parseFrontMatter(seed);
  if (!parsed.ok) throw new Error(`Invalid generated artifact frontmatter: ${parsed.error}`);
  const fm = YAML.stringify(parsed.frontmatter, { aliasDuplicateObjects: false }).trimEnd();
  const markdown = `---\n${fm}\n---\n\n${args.markdown_body.trimEnd()}\n`;
  const validation = validateMarkdownArtifact(markdown);
  if (!validation.ok) {
    const msg = validation.issues.map((i) => i.message).join("; ");
    throw new Error(`Generated evaluation artifact is invalid: ${msg}`);
  }
  await writeFileAtomic(abs, markdown);
}

export async function runSelfImproveCycle(
  args: RunSelfImproveCycleArgs
): Promise<RunSelfImproveCycleResult> {
  const proposalThreshold = args.proposal_threshold ?? 3;
  if (!Number.isInteger(proposalThreshold) || proposalThreshold < 1) {
    throw new Error("proposal_threshold must be an integer >= 1");
  }
  const promoteThreshold = args.promote_threshold ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isInteger(promoteThreshold) || promoteThreshold < 1) {
    throw new Error("promote_threshold must be an integer >= 1");
  }

  const detected = await recordAgentMistake({
    workspace_dir: args.workspace_dir,
    worker_agent_id: args.worker_agent_id,
    manager_actor_id: args.manager_actor_id,
    manager_role: args.manager_role,
    mistake_key: args.mistake_key,
    summary: args.summary,
    prevention_rule: args.prevention_rule,
    project_id: args.project_id,
    task_id: args.task_id,
    milestone_id: args.milestone_id,
    evidence_artifact_ids: args.evidence_artifact_ids,
    promote_threshold: promoteThreshold
  });

  const guidanceAbs = path.join(args.workspace_dir, detected.agents_md_relpath);
  const guidance = await readFileIfExists(guidanceAbs);
  const marker = `mistake:${args.mistake_key}`;
  const alreadyGuided = guidance.includes(marker);

  if (detected.count < proposalThreshold) {
    return {
      status: "recorded_only",
      worker_agent_id: args.worker_agent_id,
      project_id: args.project_id,
      mistake_key: args.mistake_key,
      mistake_count: detected.count,
      proposal_threshold: proposalThreshold,
      promoted_to_agents_md: detected.promoted_to_agents_md
    };
  }
  if (alreadyGuided) {
    return {
      status: "already_guided",
      worker_agent_id: args.worker_agent_id,
      project_id: args.project_id,
      mistake_key: args.mistake_key,
      mistake_count: detected.count,
      proposal_threshold: proposalThreshold,
      promoted_to_agents_md: detected.promoted_to_agents_md
    };
  }

  const run = await createRun({
    workspace_dir: args.workspace_dir,
    project_id: args.project_id,
    agent_id: args.manager_actor_id,
    provider: "self_improve"
  });
  const evalArgv = args.evaluation_argv?.length ? args.evaluation_argv : defaultEvaluationArgv();

  const evalResult = await executeCommandRun({
    workspace_dir: args.workspace_dir,
    project_id: args.project_id,
    run_id: run.run_id,
    argv: evalArgv,
    repo_id: args.evaluation_repo_id,
    workdir_rel: args.evaluation_workdir_rel,
    env: args.evaluation_env,
    task_id: args.task_id,
    milestone_id: args.milestone_id
  });

  const evaluationArtifactType: "manager_digest" | "failure_report" =
    evalResult.exit_code === 0 && evalResult.signal === null ? "manager_digest" : "failure_report";
  const evaluationArtifact = await createProjectArtifactFile({
    workspace_dir: args.workspace_dir,
    project_id: args.project_id,
    type: evaluationArtifactType,
    title:
      evaluationArtifactType === "manager_digest"
        ? `Self-improvement evaluation (${args.mistake_key})`
        : `Self-improvement failure (${args.mistake_key})`,
    visibility: "managers",
    produced_by: args.manager_actor_id,
    run_id: run.run_id,
    context_pack_id: run.context_pack_id
  });

  await appendRunEvent({
    workspace_dir: args.workspace_dir,
    project_id: args.project_id,
    run_id: run.run_id,
    actor: args.manager_actor_id,
    visibility: "managers",
    type: "artifact.produced",
    payload: {
      artifact_id: evaluationArtifact.artifact_id,
      relpath: evaluationArtifact.artifact_relpath,
      artifact_type: evaluationArtifactType
    }
  });

  if (evaluationArtifactType === "failure_report") {
    await overwriteArtifactMarkdown({
      workspace_dir: args.workspace_dir,
      artifact_relpath: evaluationArtifact.artifact_relpath,
      markdown_body: renderEvaluationBody({
        title: `Self-improvement failure (${args.mistake_key})`,
        type: "failure_report",
        count: detected.count,
        proposal_threshold: proposalThreshold,
        mistake_key: args.mistake_key,
        summary: args.summary,
        prevention_rule: args.prevention_rule,
        worker_agent_id: args.worker_agent_id,
        manager_actor_id: args.manager_actor_id,
        run_id: run.run_id,
        evaluation_argv: evalArgv,
        evaluation_exit_code: evalResult.exit_code,
        evaluation_signal: evalResult.signal,
        evidence_artifact_ids: args.evidence_artifact_ids ?? []
      })
    });
    await appendRunEvent({
      workspace_dir: args.workspace_dir,
      project_id: args.project_id,
      run_id: run.run_id,
      actor: args.manager_actor_id,
      visibility: "managers",
      type: "evaluation.self_improve_cycle",
      payload: {
        status: "evaluation_failed",
        mistake_key: args.mistake_key,
        mistake_count: detected.count,
        proposal_threshold: proposalThreshold,
        evaluation_artifact_id: evaluationArtifact.artifact_id,
        evaluation_exit_code: evalResult.exit_code,
        evaluation_signal: evalResult.signal
      }
    });
    return {
      status: "evaluation_failed",
      worker_agent_id: args.worker_agent_id,
      project_id: args.project_id,
      mistake_key: args.mistake_key,
      mistake_count: detected.count,
      proposal_threshold: proposalThreshold,
      promoted_to_agents_md: detected.promoted_to_agents_md,
      run_id: run.run_id,
      context_pack_id: run.context_pack_id,
      evaluation_exit_code: evalResult.exit_code,
      evaluation_signal: evalResult.signal,
      evaluation_artifact_id: evaluationArtifact.artifact_id,
      evaluation_artifact_relpath: evaluationArtifact.artifact_relpath,
      evaluation_artifact_type: evaluationArtifactType
    };
  }

  const insertLine = buildRuleLine({
    mistake_key: args.mistake_key,
    prevention_rule: args.prevention_rule,
    count: detected.count,
    manager_actor_id: args.manager_actor_id
  });
  const targetFile = path.join("org/agents", args.worker_agent_id, "AGENTS.md");
  const proposal = await proposeMemoryDelta({
    workspace_dir: args.workspace_dir,
    project_id: args.project_id,
    title: `Self-improvement rule for ${args.worker_agent_id}: ${args.mistake_key}`,
    target_file: targetFile,
    under_heading: "## Recurring Mistakes To Avoid",
    insert_lines: [insertLine],
    visibility: "managers",
    produced_by: args.manager_actor_id,
    run_id: run.run_id,
    context_pack_id: run.context_pack_id,
    evidence: [evaluationArtifact.artifact_id, ...(args.evidence_artifact_ids ?? [])]
  });

  await appendRunEvent({
    workspace_dir: args.workspace_dir,
    project_id: args.project_id,
    run_id: run.run_id,
    actor: args.manager_actor_id,
    visibility: "managers",
    type: "artifact.produced",
    payload: {
      artifact_id: proposal.artifact_id,
      relpath: proposal.artifact_relpath,
      artifact_type: "memory_delta"
    }
  });

  await overwriteArtifactMarkdown({
    workspace_dir: args.workspace_dir,
    artifact_relpath: evaluationArtifact.artifact_relpath,
    markdown_body: renderEvaluationBody({
      title: `Self-improvement evaluation (${args.mistake_key})`,
      type: "manager_digest",
      count: detected.count,
      proposal_threshold: proposalThreshold,
      mistake_key: args.mistake_key,
      summary: args.summary,
      prevention_rule: args.prevention_rule,
      worker_agent_id: args.worker_agent_id,
      manager_actor_id: args.manager_actor_id,
      run_id: run.run_id,
      evaluation_argv: evalArgv,
      evaluation_exit_code: evalResult.exit_code,
      evaluation_signal: evalResult.signal,
      evidence_artifact_ids: args.evidence_artifact_ids ?? [],
      proposed_memory_delta_artifact_id: proposal.artifact_id
    })
  });

  await appendRunEvent({
    workspace_dir: args.workspace_dir,
    project_id: args.project_id,
    run_id: run.run_id,
    actor: args.manager_actor_id,
    visibility: "managers",
    type: "evaluation.self_improve_cycle",
    payload: {
      status: "proposal_created",
      mistake_key: args.mistake_key,
      mistake_count: detected.count,
      proposal_threshold: proposalThreshold,
      evaluation_artifact_id: evaluationArtifact.artifact_id,
      memory_delta_artifact_id: proposal.artifact_id,
      target_file: proposal.target_file
    }
  });

  return {
    status: "proposal_created",
    worker_agent_id: args.worker_agent_id,
    project_id: args.project_id,
    mistake_key: args.mistake_key,
    mistake_count: detected.count,
    proposal_threshold: proposalThreshold,
    promoted_to_agents_md: detected.promoted_to_agents_md,
    run_id: run.run_id,
    context_pack_id: run.context_pack_id,
    evaluation_exit_code: evalResult.exit_code,
    evaluation_signal: evalResult.signal,
    evaluation_artifact_id: evaluationArtifact.artifact_id,
    evaluation_artifact_relpath: evaluationArtifact.artifact_relpath,
    evaluation_artifact_type: evaluationArtifactType,
    memory_delta_artifact_id: proposal.artifact_id,
    memory_delta_artifact_relpath: proposal.artifact_relpath,
    memory_delta_patch_relpath: proposal.patch_relpath,
    target_file: proposal.target_file
  };
}

