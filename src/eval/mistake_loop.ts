import fs from "node:fs/promises";
import path from "node:path";
import { nowIso } from "../core/time.js";
import { pathExists } from "../store/fs.js";
import { readYamlFile, writeYamlFile } from "../store/yaml.js";
import { appendEventJsonl, newEnvelope } from "../runtime/events.js";
import type { ActorRole } from "../policy/policy.js";

type MistakeObservation = {
  at: string;
  observed_by: string;
  project_id?: string;
  run_id?: string;
  task_id?: string;
  milestone_id?: string;
  evidence_artifact_ids: string[];
};

type MistakeEntry = {
  key: string;
  count: number;
  last_seen_at: string;
  summary: string;
  prevention_rule: string;
  observations: MistakeObservation[];
};

type MistakeLogYaml = {
  schema_version: number;
  type: "agent_mistake_log";
  agent_id: string;
  updated_at: string;
  entries: MistakeEntry[];
};

export type RecordAgentMistakeArgs = {
  workspace_dir: string;
  worker_agent_id: string;
  manager_actor_id: string;
  manager_role: ActorRole;
  mistake_key: string;
  summary: string;
  prevention_rule: string;
  project_id?: string;
  run_id?: string;
  task_id?: string;
  milestone_id?: string;
  evidence_artifact_ids?: string[];
  promote_threshold?: number;
};

export type RecordAgentMistakeResult = {
  worker_agent_id: string;
  mistake_key: string;
  count: number;
  promoted_to_agents_md: boolean;
  log_relpath: string;
  agents_md_relpath: string;
};

function isManagerRole(role: ActorRole): boolean {
  return role === "human" || role === "ceo" || role === "director" || role === "manager";
}

function emptyLog(agentId: string): MistakeLogYaml {
  return {
    schema_version: 1,
    type: "agent_mistake_log",
    agent_id: agentId,
    updated_at: nowIso(),
    entries: []
  };
}

async function readLogOrDefault(absPath: string, agentId: string): Promise<MistakeLogYaml> {
  if (!(await pathExists(absPath))) return emptyLog(agentId);
  const raw = (await readYamlFile(absPath)) as Partial<MistakeLogYaml>;
  const entries = Array.isArray(raw.entries) ? raw.entries : [];
  return {
    schema_version: 1,
    type: "agent_mistake_log",
    agent_id: String(raw.agent_id ?? agentId),
    updated_at: String(raw.updated_at ?? nowIso()),
    entries: entries.map((e: any) => ({
      key: String(e.key ?? ""),
      count: Number.isFinite(e.count) ? Number(e.count) : 0,
      last_seen_at: String(e.last_seen_at ?? nowIso()),
      summary: String(e.summary ?? ""),
      prevention_rule: String(e.prevention_rule ?? ""),
      observations: Array.isArray(e.observations) ? e.observations : []
    }))
  };
}

async function appendEvaluationEvent(args: {
  workspace_dir: string;
  project_id?: string;
  run_id?: string;
  actor: string;
  type: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  if (!args.project_id || !args.run_id) return;
  const eventsAbs = path.join(
    args.workspace_dir,
    "work/projects",
    args.project_id,
    "runs",
    args.run_id,
    "events.jsonl"
  );
  if (!(await pathExists(eventsAbs))) return;
  await appendEventJsonl(
    eventsAbs,
    newEnvelope({
      schema_version: 1,
      ts_wallclock: nowIso(),
      run_id: args.run_id,
      session_ref: `local_${args.run_id}`,
      actor: args.actor,
      visibility: "managers",
      type: args.type,
      payload: args.payload
    })
  );
}

export async function recordAgentMistake(
  args: RecordAgentMistakeArgs
): Promise<RecordAgentMistakeResult> {
  if (!isManagerRole(args.manager_role)) {
    throw new Error("Only manager+ roles can record worker mistakes");
  }
  if (!args.mistake_key.trim()) throw new Error("mistake_key is required");
  if (!args.summary.trim()) throw new Error("summary is required");
  if (!args.prevention_rule.trim()) throw new Error("prevention_rule is required");

  const threshold = args.promote_threshold ?? 3;
  if (!Number.isInteger(threshold) || threshold < 1) {
    throw new Error("promote_threshold must be an integer >= 1");
  }

  const agentDir = path.join(args.workspace_dir, "org/agents", args.worker_agent_id);
  const logRel = path.join("org/agents", args.worker_agent_id, "mistakes.yaml");
  const logAbs = path.join(args.workspace_dir, logRel);
  const guidanceRel = path.join("org/agents", args.worker_agent_id, "AGENTS.md");

  const log = await readLogOrDefault(logAbs, args.worker_agent_id);
  const at = nowIso();
  const obs: MistakeObservation = {
    at,
    observed_by: args.manager_actor_id,
    project_id: args.project_id,
    run_id: args.run_id,
    task_id: args.task_id,
    milestone_id: args.milestone_id,
    evidence_artifact_ids: args.evidence_artifact_ids ?? []
  };

  const idx = log.entries.findIndex((e) => e.key === args.mistake_key);
  if (idx === -1) {
    log.entries.push({
      key: args.mistake_key,
      count: 1,
      last_seen_at: at,
      summary: args.summary,
      prevention_rule: args.prevention_rule,
      observations: [obs]
    });
  } else {
    const e = log.entries[idx];
    e.count += 1;
    e.last_seen_at = at;
    e.summary = args.summary;
    e.prevention_rule = args.prevention_rule;
    e.observations = [...e.observations, obs].slice(-20);
  }
  log.updated_at = at;

  await fs.mkdir(agentDir, { recursive: true });
  await writeYamlFile(logAbs, log);

  const entry = log.entries.find((e) => e.key === args.mistake_key)!;
  const promoted = false;

  await appendEvaluationEvent({
    workspace_dir: args.workspace_dir,
    project_id: args.project_id,
    run_id: args.run_id,
    actor: args.manager_actor_id,
    type: "evaluation.mistake_recorded",
    payload: {
      worker_agent_id: args.worker_agent_id,
      mistake_key: entry.key,
      count: entry.count,
      threshold,
      task_id: args.task_id ?? null,
      milestone_id: args.milestone_id ?? null,
      evidence_artifact_ids: args.evidence_artifact_ids ?? []
    }
  });
  return {
    worker_agent_id: args.worker_agent_id,
    mistake_key: entry.key,
    count: entry.count,
    promoted_to_agents_md: promoted,
    log_relpath: logRel,
    agents_md_relpath: guidanceRel
  };
}
