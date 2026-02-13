import fs from "node:fs/promises";
import path from "node:path";
import {
  listIndexedArtifacts,
  listIndexedReviewDecisions,
  syncSqliteIndex,
  type IndexedReviewDecision
} from "../index/sqlite.js";
import { parseMemoryDeltaMarkdown } from "./memory_delta.js";
import { evaluatePolicy, type ActorRole } from "../policy/policy.js";
import { readYamlFile } from "../store/yaml.js";
import { AgentYaml } from "../schemas/agent.js";

export type MemoryDeltaStatus = "pending" | "approved" | "denied" | "all";

export type ListMemoryDeltasArgs = {
  workspace_dir: string;
  actor_id: string;
  actor_role: ActorRole;
  actor_team_id?: string;
  project_id?: string;
  status?: MemoryDeltaStatus;
  limit?: number;
};

export type ListedMemoryDeltaDecision = {
  review_id: string;
  decision: "approved" | "denied";
  actor_id: string;
  actor_role: string;
  created_at: string;
  notes: string | null;
};

export type ListedMemoryDelta = {
  artifact_id: string;
  title: string;
  project_id: string;
  run_id: string;
  created_at: string;
  visibility: "private_agent" | "team" | "managers" | "org";
  produced_by: string;
  scope_kind: "project_memory" | "agent_guidance";
  scope_ref: string;
  sensitivity: "public" | "internal" | "restricted";
  rationale: string;
  evidence: string[];
  source_schema_version: 1 | 2;
  status: "pending" | "approved" | "denied";
  decision: ListedMemoryDeltaDecision | null;
};

export type ListMemoryDeltasResult = {
  workspace_dir: string;
  project_id?: string;
  status: MemoryDeltaStatus;
  count: number;
  filtered_by_policy_count: number;
  items: ListedMemoryDelta[];
};

function clampLimit(limit?: number): number {
  return Math.max(1, Math.min(limit ?? 200, 5000));
}

function pickLatestDecisions(
  decisions: IndexedReviewDecision[]
): Map<string, IndexedReviewDecision> {
  const latest = new Map<string, IndexedReviewDecision>();
  for (const decision of decisions) {
    if (decision.subject_kind !== "memory_delta") continue;
    if (!latest.has(decision.subject_artifact_id)) {
      latest.set(decision.subject_artifact_id, decision);
    }
  }
  return latest;
}

function statusMatches(actual: "pending" | "approved" | "denied", filter: MemoryDeltaStatus): boolean {
  if (filter === "all") return true;
  return actual === filter;
}

async function resolveProducerTeamId(args: {
  workspace_dir: string;
  produced_by: string;
  cache: Map<string, string | undefined>;
}): Promise<string | undefined> {
  if (!args.produced_by.startsWith("agent_")) return undefined;
  if (args.cache.has(args.produced_by)) return args.cache.get(args.produced_by);

  const agentPath = path.join(args.workspace_dir, "org/agents", args.produced_by, "agent.yaml");
  try {
    const parsed = AgentYaml.parse(await readYamlFile(agentPath));
    args.cache.set(args.produced_by, parsed.team_id);
    return parsed.team_id;
  } catch {
    args.cache.set(args.produced_by, undefined);
    return undefined;
  }
}

export async function listMemoryDeltas(args: ListMemoryDeltasArgs): Promise<ListMemoryDeltasResult> {
  if (!String(args.actor_id ?? "").trim()) {
    throw new Error("actor_id is required");
  }
  const status = args.status ?? "all";
  const limit = clampLimit(args.limit);

  // Keep list output aligned with latest canonical workspace state.
  await syncSqliteIndex(args.workspace_dir);

  const [artifacts, decisions] = await Promise.all([
    listIndexedArtifacts({
      workspace_dir: args.workspace_dir,
      project_id: args.project_id,
      type: "memory_delta",
      limit: Math.max(limit * 5, 200)
    }),
    listIndexedReviewDecisions({
      workspace_dir: args.workspace_dir,
      project_id: args.project_id,
      limit: 5000
    })
  ]);

  const latestByArtifact = pickLatestDecisions(decisions);
  const items: ListedMemoryDelta[] = [];
  let filteredByPolicyCount = 0;
  const producerTeamCache = new Map<string, string | undefined>();

  for (const artifact of artifacts) {
    if (items.length >= limit) break;

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

    const latest = latestByArtifact.get(artifact.artifact_id);
    const itemStatus: "pending" | "approved" | "denied" = latest ? latest.decision : "pending";
    if (!statusMatches(itemStatus, status)) continue;

    const producerTeamId = await resolveProducerTeamId({
      workspace_dir: args.workspace_dir,
      produced_by: parsed.frontmatter.produced_by,
      cache: producerTeamCache
    });
    const policy = evaluatePolicy(
      {
        actor_id: args.actor_id,
        role: args.actor_role,
        team_id: args.actor_team_id
      },
      "read",
      {
        resource_id: parsed.frontmatter.id,
        visibility: parsed.frontmatter.visibility,
        team_id: producerTeamId,
        producing_actor_id: parsed.frontmatter.produced_by,
        kind: "memory_delta"
      }
    );
    if (!policy.allowed) {
      filteredByPolicyCount += 1;
      continue;
    }

    items.push({
      artifact_id: parsed.frontmatter.id,
      title: parsed.frontmatter.title,
      project_id: parsed.frontmatter.project_id,
      run_id: parsed.frontmatter.run_id,
      created_at: parsed.frontmatter.created_at,
      visibility: parsed.frontmatter.visibility,
      produced_by: parsed.frontmatter.produced_by,
      scope_kind: parsed.frontmatter.scope_kind,
      scope_ref: parsed.frontmatter.scope_ref,
      sensitivity: parsed.frontmatter.sensitivity,
      rationale: parsed.frontmatter.rationale,
      evidence: parsed.frontmatter.evidence,
      source_schema_version: parsed.frontmatter.source_schema_version,
      status: itemStatus,
      decision: latest
        ? {
            review_id: latest.review_id,
            decision: latest.decision,
            actor_id: latest.actor_id,
            actor_role: latest.actor_role,
            created_at: latest.created_at,
            notes: latest.notes
          }
        : null
    });
  }

  return {
    workspace_dir: args.workspace_dir,
    project_id: args.project_id,
    status,
    count: items.length,
    filtered_by_policy_count: filteredByPolicyCount,
    items
  };
}
