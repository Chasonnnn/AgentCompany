import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { nowIso } from "../core/time.js";
import { detectSensitiveText } from "../core/redaction.js";
import {
  listIndexedArtifacts,
  listIndexedReviewDecisions,
  listIndexedRuns,
  syncSqliteIndex
} from "../index/sqlite.js";
import { parseMemoryDeltaMarkdown, type MemorySensitivity, type MemoryScopeKind } from "../memory/memory_delta.js";
import { evaluatePolicy, type ActorRole, type Visibility } from "../policy/policy.js";
import type { JobContextRef } from "../schemas/job.js";
import { AgentYaml } from "../schemas/agent.js";
import {
  ContextPlanResult,
  ContextTraceEntry,
  type ContextLayer,
  PersistedContextPlan
} from "../schemas/context_plan.js";
import { pathExists, writeFileAtomic } from "../store/fs.js";
import { readYamlFile } from "../store/yaml.js";

type PlanCandidate = {
  layer: ContextLayer;
  source_kind: ContextTraceEntry["source_kind"];
  source_id: string;
  score: number;
  created_at?: string;
  reason: string;
  visibility?: Visibility;
  sensitivity?: MemorySensitivity;
  ref: JobContextRef;
};

export type PlanContextForJobArgs = {
  workspace_dir: string;
  project_id: string;
  worker_agent_id?: string;
  manager_actor_id: string;
  manager_role: ActorRole;
  manager_team_id?: string;
  job_kind?: "execution" | "heartbeat";
  goal: string;
  constraints?: string[];
  deliverables?: string[];
  context_refs?: JobContextRef[];
  max_refs?: number;
};

export type PlanContextForJobResult = {
  generated_at: string;
  max_refs: number;
  scope_kind: MemoryScopeKind;
  scope_ref: string;
  context_refs: JobContextRef[];
  layers_used: Array<"L0" | "L1" | "L2">;
  retrieval_trace: ContextTraceEntry[];
  filtered_by_policy_count: number;
  filtered_by_sensitivity_count: number;
  filtered_by_secret_count: number;
};

export type PersistContextPlanForRunArgs = {
  workspace_dir: string;
  project_id: string;
  run_id: string;
  context_pack_id: string;
  worker_agent_id?: string;
  manager_actor_id: string;
  manager_role: ActorRole;
  goal: string;
  job_kind: "execution" | "heartbeat";
  plan: PlanContextForJobResult;
};

function clampMaxRefs(jobKind: "execution" | "heartbeat", input?: number): number {
  const fallback = jobKind === "heartbeat" ? 8 : 32;
  const value = Number.isInteger(input) ? (input as number) : fallback;
  return Math.max(1, Math.min(value, 200));
}

function asEpoch(iso?: string): number {
  if (!iso) return 0;
  const ts = Date.parse(iso);
  return Number.isFinite(ts) ? ts : 0;
}

function asOptionalString(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const trimmed = input.trim();
  return trimmed.length ? trimmed : undefined;
}

function makeContextKey(ref: JobContextRef): string {
  return `${ref.kind}::${ref.value}`;
}

function mergeMatchCounts(
  target: Record<string, number>,
  source: Record<string, number>
): Record<string, number> {
  for (const [k, n] of Object.entries(source)) {
    target[k] = (target[k] ?? 0) + n;
  }
  return target;
}

async function resolveProducerTeamId(args: {
  workspace_dir: string;
  produced_by: string;
  cache: Map<string, string | undefined>;
}): Promise<string | undefined> {
  if (!args.produced_by.startsWith("agent_")) return undefined;
  if (args.cache.has(args.produced_by)) return args.cache.get(args.produced_by);
  const rel = path.join("org/agents", args.produced_by, "agent.yaml");
  const abs = path.join(args.workspace_dir, rel);
  try {
    const parsed = AgentYaml.parse(await readYamlFile(abs));
    args.cache.set(args.produced_by, parsed.team_id);
    return parsed.team_id;
  } catch {
    args.cache.set(args.produced_by, undefined);
    return undefined;
  }
}

function addTrace(
  trace: ContextTraceEntry[],
  candidate: Omit<PlanCandidate, "ref">,
  decision: ContextTraceEntry["decision"],
  reason: string
): void {
  trace.push({
    layer: candidate.layer,
    source_kind: candidate.source_kind,
    source_id: candidate.source_id,
    score: candidate.score,
    created_at: candidate.created_at,
    decision,
    reason,
    visibility: candidate.visibility,
    sensitivity: candidate.sensitivity
  });
}

export async function planContextForJob(args: PlanContextForJobArgs): Promise<PlanContextForJobResult> {
  const jobKind = args.job_kind ?? "execution";
  const maxRefs = clampMaxRefs(jobKind, args.max_refs);
  const generatedAt = nowIso();
  const scopeKind: MemoryScopeKind = args.worker_agent_id ? "agent_guidance" : "project_memory";
  const scopeRef = args.worker_agent_id ?? args.project_id;
  const actor = {
    actor_id: args.manager_actor_id,
    role: args.manager_role,
    team_id: args.manager_team_id
  };

  await syncSqliteIndex(args.workspace_dir);

  const retrievalTrace: ContextTraceEntry[] = [];
  let filteredByPolicyCount = 0;
  let filteredBySensitivityCount = 0;
  let filteredBySecretCount = 0;
  const secretMatchCounts: Record<string, number> = {};
  const candidates: PlanCandidate[] = [];
  const producerTeamCache = new Map<string, string | undefined>();

  const l0Paths = [
    "AGENTS.md",
    "company/company.yaml",
    "company/policy.yaml",
    path.join("work/projects", args.project_id, "memory.md")
  ];
  if (args.worker_agent_id) {
    l0Paths.push(path.join("org/agents", args.worker_agent_id, "agent.yaml"));
    l0Paths.push(path.join("org/agents", args.worker_agent_id, "AGENTS.md"));
    l0Paths.push(path.join("org/agents", args.worker_agent_id, "role.md"));
    l0Paths.push(path.join("org/agents", args.worker_agent_id, "skills_index.md"));
    l0Paths.push(path.join("org/agents", args.worker_agent_id, "context_index.md"));
  }

  for (const rel of l0Paths.sort()) {
    const abs = path.join(args.workspace_dir, rel);
    if (!(await pathExists(abs))) continue;
    candidates.push({
      layer: "L0",
      source_kind: "file",
      source_id: rel,
      score: rel === "AGENTS.md" ? 1000 : 900,
      reason: "base_context",
      ref: {
        kind: "file",
        value: rel,
        description: "base governance/context reference"
      }
    });
  }

  for (const seed of args.context_refs ?? []) {
    const sourceId = `seed:${seed.kind}:${seed.value}`;
    candidates.push({
      layer: "L0",
      source_kind: "seed",
      source_id: sourceId,
      score: 10_000,
      reason: "seed_ref",
      ref: seed
    });
  }

  const [memoryArtifacts, reviewDecisions, trajectoryArtifacts, runs] = await Promise.all([
    listIndexedArtifacts({
      workspace_dir: args.workspace_dir,
      project_id: args.project_id,
      type: "memory_delta",
      limit: 5000
    }),
    listIndexedReviewDecisions({
      workspace_dir: args.workspace_dir,
      project_id: args.project_id,
      limit: 5000
    }),
    listIndexedArtifacts({
      workspace_dir: args.workspace_dir,
      project_id: args.project_id,
      limit: 5000
    }),
    listIndexedRuns({
      workspace_dir: args.workspace_dir,
      project_id: args.project_id,
      limit: 5000
    })
  ]);

  const latestDecisionByArtifact = new Map<
    string,
    { decision: "approved" | "denied"; created_at: string }
  >();
  for (const review of reviewDecisions) {
    if (review.subject_kind !== "memory_delta") continue;
    if (latestDecisionByArtifact.has(review.subject_artifact_id)) continue;
    latestDecisionByArtifact.set(review.subject_artifact_id, {
      decision: review.decision,
      created_at: review.created_at
    });
  }

  for (const artifact of memoryArtifacts) {
    const latest = latestDecisionByArtifact.get(artifact.artifact_id);
    if (!latest || latest.decision !== "approved") {
      addTrace(
        retrievalTrace,
        {
          layer: "L1",
          source_kind: "memory_delta",
          source_id: artifact.artifact_id,
          score: 800,
          created_at: asOptionalString(artifact.created_at),
          reason: "memory_not_approved"
        },
        "filtered_not_approved",
        "memory_delta_not_approved"
      );
      continue;
    }

    const rel = path.join("work/projects", artifact.project_id, "artifacts", `${artifact.artifact_id}.md`);
    const abs = path.join(args.workspace_dir, rel);
    let markdown = "";
    try {
      markdown = await fs.readFile(abs, { encoding: "utf8" });
    } catch {
      continue;
    }
    const parsed = parseMemoryDeltaMarkdown(markdown);
    if (!parsed.ok) continue;

    const producerTeamId = await resolveProducerTeamId({
      workspace_dir: args.workspace_dir,
      produced_by: parsed.frontmatter.produced_by,
      cache: producerTeamCache
    });
    const policy = evaluatePolicy(actor, "compose_context", {
      resource_id: parsed.frontmatter.id,
      visibility: parsed.frontmatter.visibility,
      team_id: producerTeamId,
      producing_actor_id: parsed.frontmatter.produced_by,
      kind: "memory_delta",
      sensitivity: parsed.frontmatter.sensitivity
    });
    if (!policy.allowed) {
      if (policy.rule_id === "compose.sensitivity.restricted") {
        filteredBySensitivityCount += 1;
      } else {
        filteredByPolicyCount += 1;
      }
      addTrace(
        retrievalTrace,
        {
          layer: "L1",
          source_kind: "memory_delta",
          source_id: parsed.frontmatter.id,
          score: 800,
          created_at: parsed.frontmatter.created_at,
          reason: "policy_filtered",
          visibility: parsed.frontmatter.visibility,
          sensitivity: parsed.frontmatter.sensitivity
        },
        policy.rule_id === "compose.sensitivity.restricted"
          ? "filtered_sensitivity"
          : "filtered_policy",
        policy.reason
      );
      continue;
    }

    const secretSummary = detectSensitiveText(
      `${parsed.frontmatter.title}\n${parsed.frontmatter.rationale}\n${parsed.body}`
    );
    if (secretSummary.total_matches > 0) {
      filteredBySecretCount += 1;
      mergeMatchCounts(secretMatchCounts, secretSummary.matches_by_kind);
      addTrace(
        retrievalTrace,
        {
          layer: "L1",
          source_kind: "memory_delta",
          source_id: parsed.frontmatter.id,
          score: 800,
          created_at: parsed.frontmatter.created_at,
          reason: "secret_filtered",
          visibility: parsed.frontmatter.visibility,
          sensitivity: parsed.frontmatter.sensitivity
        },
        "filtered_secret",
        "secret_detected"
      );
      continue;
    }

    candidates.push({
      layer: "L1",
      source_kind: "memory_delta",
      source_id: parsed.frontmatter.id,
      score: 800 + Math.max(0, asEpoch(parsed.frontmatter.created_at) / 1_000_000_000_000),
      created_at: parsed.frontmatter.created_at,
      reason: "approved_memory_delta",
      visibility: parsed.frontmatter.visibility,
      sensitivity: parsed.frontmatter.sensitivity,
      ref: {
        kind: "artifact",
        value: parsed.frontmatter.id,
        description: `memory ${parsed.frontmatter.scope_kind}/${parsed.frontmatter.sensitivity}: ${parsed.frontmatter.title}`
      }
    });
  }

  for (const artifact of trajectoryArtifacts) {
    if (artifact.type !== "manager_digest" && artifact.type !== "failure_report") continue;
    const producerTeamId = await resolveProducerTeamId({
      workspace_dir: args.workspace_dir,
      produced_by: String(artifact.produced_by ?? ""),
      cache: producerTeamCache
    });
    const policy = evaluatePolicy(actor, "compose_context", {
      resource_id: artifact.artifact_id,
      visibility: artifact.visibility as Visibility,
      team_id: producerTeamId,
      producing_actor_id: asOptionalString(artifact.produced_by),
      kind: artifact.type
    });
    if (!policy.allowed) {
      filteredByPolicyCount += 1;
      addTrace(
        retrievalTrace,
        {
          layer: "L2",
          source_kind: "artifact",
          source_id: artifact.artifact_id,
          score: 400,
          created_at: asOptionalString(artifact.created_at),
          reason: "policy_filtered",
          visibility: artifact.visibility as Visibility
        },
        "filtered_policy",
        policy.reason
      );
      continue;
    }
    const secretSummary = detectSensitiveText(`${String(artifact.title ?? "")}\n${artifact.artifact_id}`);
    if (secretSummary.total_matches > 0) {
      filteredBySecretCount += 1;
      mergeMatchCounts(secretMatchCounts, secretSummary.matches_by_kind);
      addTrace(
        retrievalTrace,
        {
          layer: "L2",
          source_kind: "artifact",
          source_id: artifact.artifact_id,
          score: 400,
          created_at: asOptionalString(artifact.created_at),
          reason: "secret_filtered",
          visibility: artifact.visibility as Visibility
        },
        "filtered_secret",
        "secret_detected"
      );
      continue;
    }

    candidates.push({
      layer: "L2",
      source_kind: "artifact",
      source_id: artifact.artifact_id,
      score: 400 + Math.max(0, asEpoch(asOptionalString(artifact.created_at)) / 1_000_000_000_000),
      created_at: asOptionalString(artifact.created_at),
      reason: `trajectory_${artifact.type}`,
      visibility: artifact.visibility as Visibility,
      ref: {
        kind: "artifact",
        value: artifact.artifact_id,
        description: `trajectory ${artifact.type}: ${String(artifact.title ?? "")}`
      }
    });
  }

  for (const run of runs) {
    if (!run.context_cycles_count || run.context_cycles_count <= 0) continue;
    candidates.push({
      layer: "L2",
      source_kind: "run",
      source_id: run.run_id,
      score: 300 + Math.max(0, asEpoch(asOptionalString(run.created_at)) / 1_000_000_000_000),
      created_at: asOptionalString(run.created_at),
      reason: "recent_context_cycles",
      ref: {
        kind: "note",
        value: `run=${run.run_id} context_cycles=${run.context_cycles_count}`,
        description: `recent context-cycle signal (${run.context_cycles_source ?? "unknown"})`
      }
    });
  }

  const layerPriority: Record<ContextLayer, number> = { L0: 0, L1: 1, L2: 2 };
  candidates.sort((a, b) => {
    const lp = layerPriority[a.layer] - layerPriority[b.layer];
    if (lp !== 0) return lp;
    if (a.score !== b.score) return b.score - a.score;
    const ts = asEpoch(b.created_at) - asEpoch(a.created_at);
    if (ts !== 0) return ts;
    return a.source_id.localeCompare(b.source_id);
  });

  const selected: JobContextRef[] = [];
  const selectedLayers = new Set<"L0" | "L1" | "L2">();
  const seenRefs = new Set<string>();

  for (const candidate of candidates) {
    const key = makeContextKey(candidate.ref);
    if (seenRefs.has(key)) continue;
    const secretSummary = detectSensitiveText(
      `${candidate.ref.kind}\n${candidate.ref.value}\n${candidate.ref.description ?? ""}`
    );
    if (secretSummary.total_matches > 0) {
      filteredBySecretCount += 1;
      mergeMatchCounts(secretMatchCounts, secretSummary.matches_by_kind);
      addTrace(retrievalTrace, candidate, "filtered_secret", "secret_detected");
      continue;
    }
    if (selected.length >= maxRefs) {
      addTrace(retrievalTrace, candidate, "filtered_limit", "max_refs_reached");
      continue;
    }

    selected.push(candidate.ref);
    selectedLayers.add(candidate.layer);
    seenRefs.add(key);
    addTrace(retrievalTrace, candidate, "included", candidate.reason);
  }

  const normalized = ContextPlanResult.parse({
    context_refs: selected,
    layers_used: [...selectedLayers].sort(),
    retrieval_trace: retrievalTrace,
    filtered_by_policy_count: filteredByPolicyCount,
    filtered_by_sensitivity_count: filteredBySensitivityCount,
    filtered_by_secret_count: filteredBySecretCount
  });

  return {
    generated_at: generatedAt,
    max_refs: maxRefs,
    scope_kind: scopeKind,
    scope_ref: scopeRef,
    ...normalized
  };
}

export async function persistContextPlanForRun(args: PersistContextPlanForRunArgs): Promise<{
  context_plan_relpath: string;
  context_plan_hash: string;
}> {
  const rel = path.join(
    "work/projects",
    args.project_id,
    "context_packs",
    args.context_pack_id,
    "bundle",
    "context_plan.json"
  );
  const abs = path.join(args.workspace_dir, rel);
  const persisted = PersistedContextPlan.parse({
    schema_version: 1,
    type: "context_plan",
    generated_at: args.plan.generated_at,
    run_id: args.run_id,
    context_pack_id: args.context_pack_id,
    project_id: args.project_id,
    worker_agent_id: args.worker_agent_id,
    manager_actor_id: args.manager_actor_id,
    manager_role: args.manager_role,
    scope: {
      goal: args.goal,
      job_kind: args.job_kind,
      max_refs: args.plan.max_refs,
      scope_kind: args.plan.scope_kind,
      scope_ref: args.plan.scope_ref
    },
    result: {
      context_refs: args.plan.context_refs,
      layers_used: args.plan.layers_used,
      retrieval_trace: args.plan.retrieval_trace,
      filtered_by_policy_count: args.plan.filtered_by_policy_count,
      filtered_by_sensitivity_count: args.plan.filtered_by_sensitivity_count,
      filtered_by_secret_count: args.plan.filtered_by_secret_count
    }
  });
  const json = `${JSON.stringify(persisted, null, 2)}\n`;
  const hash = createHash("sha256").update(json).digest("hex");
  await writeFileAtomic(abs, json);
  return {
    context_plan_relpath: rel,
    context_plan_hash: hash
  };
}
