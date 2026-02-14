import fs from "node:fs/promises";
import path from "node:path";
import { nowIso } from "../core/time.js";
import { detectSensitiveText } from "../core/redaction.js";
import { appendEventJsonl, newEnvelope } from "../runtime/events.js";
import { JobRecord, type JobRecord as JobRecordDoc } from "../schemas/job.js";
import { ResultSpec } from "../schemas/result.js";
import {
  MemoryCandidateReport,
  type MemoryCandidate,
  type SensitivePatternCounts
} from "../schemas/memory_candidate_report.js";
import { writeFileAtomic } from "../store/fs.js";
import { readYamlFile } from "../store/yaml.js";
import type { ActorRole } from "../policy/policy.js";

export type ExtractSessionCommitCandidatesArgs = {
  workspace_dir: string;
  project_id: string;
  job_id?: string;
  run_id?: string;
  actor_id: string;
  actor_role: ActorRole;
  actor_team_id?: string;
  limit?: number;
};

export type ExtractSessionCommitCandidatesResult = {
  report_relpath: string;
  count: number;
  blocked_secret_count: number;
  candidates: MemoryCandidate[];
};

function emptySensitivePatternCounts(): SensitivePatternCounts {
  return {
    OPENAI_API_KEY: 0,
    GITHUB_TOKEN: 0,
    SLACK_TOKEN: 0,
    BEARER_TOKEN: 0,
    GENERIC_CREDENTIAL_ASSIGNMENT: 0
  };
}

function mergeSensitiveCounts(
  target: SensitivePatternCounts,
  source: Record<string, number>
): SensitivePatternCounts {
  for (const [k, v] of Object.entries(source)) {
    if (!(k in target)) continue;
    const key = k as keyof SensitivePatternCounts;
    target[key] += v;
  }
  return target;
}

function clampLimit(limit?: number): number {
  const candidate = Number.isInteger(limit) ? (limit as number) : 20;
  return Math.max(1, Math.min(candidate, 100));
}

async function readJobRecord(args: {
  workspace_dir: string;
  project_id: string;
  job_id: string;
}): Promise<JobRecordDoc> {
  const abs = path.join(
    args.workspace_dir,
    "work/projects",
    args.project_id,
    "jobs",
    args.job_id,
    "job.yaml"
  );
  return JobRecord.parse(await readYamlFile(abs));
}

async function resolveJobByRunId(args: {
  workspace_dir: string;
  project_id: string;
  run_id: string;
}): Promise<JobRecordDoc | null> {
  const jobsDir = path.join(args.workspace_dir, "work/projects", args.project_id, "jobs");
  let entries: string[] = [];
  try {
    entries = (await fs.readdir(jobsDir)).sort();
  } catch {
    return null;
  }
  for (const jobId of entries) {
    try {
      const rec = await readJobRecord({
        workspace_dir: args.workspace_dir,
        project_id: args.project_id,
        job_id: jobId
      });
      if (rec.attempts.some((attempt) => attempt.run_id === args.run_id)) return rec;
    } catch {
      // best effort
    }
  }
  return null;
}

async function readJsonIfExists(absPath: string): Promise<unknown | null> {
  try {
    const raw = await fs.readFile(absPath, { encoding: "utf8" });
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function buildCandidates(args: {
  record: JobRecordDoc;
  run_id: string;
  result: ReturnType<typeof ResultSpec.parse> | null;
  manager_digest: Record<string, unknown> | null;
}): MemoryCandidate[] {
  const evidence = new Set<string>([`run:${args.run_id}`, `job:${args.record.job.job_id}`]);
  for (const artifact of args.result?.artifacts ?? []) {
    if (artifact.artifact_id) evidence.add(artifact.artifact_id);
  }
  const evidenceList = [...evidence];
  const out: MemoryCandidate[] = [];

  if (args.result) {
    out.push({
      scope_kind: "project_memory",
      scope_ref: args.record.job.project_id,
      sensitivity: "internal",
      title: `Run insight (${args.result.status})`,
      insert_lines: [
        `- ${args.result.summary}`,
        `- files_changed=${args.result.files_changed.length}, commands_run=${args.result.commands_run.length}, errors=${args.result.errors.length}`
      ],
      rationale: `Derived from job ${args.record.job.job_id} result status=${args.result.status} for goal: ${args.record.job.goal}`,
      evidence: evidenceList,
      confidence: args.result.status === "succeeded" ? 0.72 : 0.58
    });

    if (args.result.files_changed.length > 0) {
      const touched = args.result.files_changed
        .slice(0, 5)
        .map((f) => f.path)
        .join(", ");
      out.push({
        scope_kind: "project_memory",
        scope_ref: args.record.job.project_id,
        sensitivity: "internal",
        title: "Frequently touched paths",
        insert_lines: [`- Recent run touched: ${touched}`],
        rationale: `Extracted from files_changed for job ${args.record.job.job_id}.`,
        evidence: evidenceList,
        confidence: 0.63
      });
    }

    if (args.result.errors.length > 0 && args.record.job.worker_agent_id) {
      const first = args.result.errors[0]!;
      out.push({
        scope_kind: "agent_guidance",
        scope_ref: args.record.job.worker_agent_id,
        sensitivity: "internal",
        title: `Avoid repeat error: ${first.code}`,
        insert_lines: [`- ${first.message}`],
        rationale: `Run ${args.run_id} reported ${first.code}; capture prevention guidance for the assigned worker.`,
        evidence: evidenceList,
        confidence: 0.6
      });
    }
  }

  const signals = args.manager_digest?.signals;
  if (signals && typeof signals === "object") {
    const keyvals = Object.entries(signals as Record<string, unknown>)
      .slice(0, 5)
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join(", ");
    if (keyvals) {
      out.push({
        scope_kind: "project_memory",
        scope_ref: args.record.job.project_id,
        sensitivity: "internal",
        title: "Manager signal summary",
        insert_lines: [`- ${keyvals}`],
        rationale: `Signal snapshot from manager digest for job ${args.record.job.job_id}.`,
        evidence: evidenceList,
        confidence: 0.54
      });
    }
  }

  return out;
}

export async function extractSessionCommitCandidates(
  args: ExtractSessionCommitCandidatesArgs
): Promise<ExtractSessionCommitCandidatesResult> {
  if (!args.job_id && !args.run_id) {
    throw new Error("Either job_id or run_id is required");
  }

  const record =
    args.job_id
      ? await readJobRecord({
          workspace_dir: args.workspace_dir,
          project_id: args.project_id,
          job_id: args.job_id
        })
      : await resolveJobByRunId({
          workspace_dir: args.workspace_dir,
          project_id: args.project_id,
          run_id: args.run_id!
        });

  if (!record) {
    throw new Error(`No job record found for run_id=${args.run_id}`);
  }

  const runId =
    args.run_id ??
    record.attempts.at(-1)?.run_id ??
    (() => {
      throw new Error(`Job ${record.job.job_id} has no attempts; cannot infer run_id`);
    })();

  const resultAbs = path.join(
    args.workspace_dir,
    "work/projects",
    args.project_id,
    "jobs",
    record.job.job_id,
    "result.json"
  );
  const digestAbs = path.join(
    args.workspace_dir,
    "work/projects",
    args.project_id,
    "jobs",
    record.job.job_id,
    "manager_digest.json"
  );
  const parsedResultRaw = await readJsonIfExists(resultAbs);
  const parsedDigestRaw = await readJsonIfExists(digestAbs);
  const parsedResult = parsedResultRaw ? ResultSpec.parse(parsedResultRaw) : null;
  const parsedDigest =
    parsedDigestRaw && typeof parsedDigestRaw === "object" && !Array.isArray(parsedDigestRaw)
      ? (parsedDigestRaw as Record<string, unknown>)
      : null;

  const limit = clampLimit(args.limit);
  const blockedMatchesByKind = emptySensitivePatternCounts();
  let blockedSecretCount = 0;
  const safeCandidates: MemoryCandidate[] = [];
  const built = buildCandidates({
    record,
    run_id: runId,
    result: parsedResult,
    manager_digest: parsedDigest
  });

  for (const candidate of built) {
    if (safeCandidates.length >= limit) break;
    const secretSummary = detectSensitiveText(
      `${candidate.title}\n${candidate.rationale}\n${candidate.insert_lines.join("\n")}\n${candidate.evidence.join("\n")}`
    );
    if (secretSummary.total_matches > 0) {
      blockedSecretCount += 1;
      mergeSensitiveCounts(blockedMatchesByKind, secretSummary.matches_by_kind);
      continue;
    }
    safeCandidates.push(candidate);
  }

  const report = MemoryCandidateReport.parse({
    schema_version: 1,
    type: "memory_candidate_report",
    generated_at: nowIso(),
    project_id: args.project_id,
    job_id: record.job.job_id,
    run_id: runId,
    actor_id: args.actor_id,
    actor_role: args.actor_role,
    actor_team_id: args.actor_team_id,
    blocked_secret_count: blockedSecretCount,
    blocked_matches_by_kind: blockedMatchesByKind,
    count: safeCandidates.length,
    candidates: safeCandidates
  });

  const reportRel = path.join("work/projects", args.project_id, "runs", runId, "outputs", "memory_candidates.json");
  const reportAbs = path.join(args.workspace_dir, reportRel);
  await writeFileAtomic(reportAbs, `${JSON.stringify(report, null, 2)}\n`);

  const eventsAbs = path.join(
    args.workspace_dir,
    "work/projects",
    args.project_id,
    "runs",
    runId,
    "events.jsonl"
  );
  try {
    await appendEventJsonl(
      eventsAbs,
      newEnvelope({
        schema_version: 1,
        ts_wallclock: nowIso(),
        run_id: runId,
        session_ref: `local_${runId}`,
        actor: args.actor_id,
        visibility: "managers",
        type: "memory.candidates.generated",
        payload: {
          job_id: record.job.job_id,
          report_relpath: reportRel,
          candidate_count: safeCandidates.length,
          blocked_secret_count: blockedSecretCount
        }
      })
    );
  } catch {
    // Best effort eventing; report file remains source of truth.
  }

  return {
    report_relpath: reportRel,
    count: safeCandidates.length,
    blocked_secret_count: blockedSecretCount,
    candidates: safeCandidates
  };
}
