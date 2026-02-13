import fs from "node:fs/promises";
import path from "node:path";
import { nowIso } from "../core/time.js";
import { newId } from "../core/ids.js";
import { ensureDir, pathExists, writeFileAtomic } from "../store/fs.js";
import { readYamlFile, writeYamlFile } from "../store/yaml.js";
import { AgentYaml } from "../schemas/agent.js";
import { JobRecord, JobSpec, type JobAttempt } from "../schemas/job.js";
import { ResultSpec, type ResultError, type ResultSpec as ResultSpecType } from "../schemas/result.js";
import { HeartbeatWorkerReport, type HeartbeatWorkerReport as HeartbeatWorkerReportType } from "../schemas/heartbeat.js";
import { listAgents } from "../org/agents_list.js";
import {
  buildCodexReformatPrompt,
  buildFallbackNeedsInputResult,
  buildStrictJsonRepairPrompt,
  extractGenericJsonObjectCandidate,
  extractResultCandidate,
  validateResultCandidate
} from "./result_normalize.js";
import { buildManagerDigest } from "./manager_digest.js";
import { buildInitialAttemptPrompt, runWorkerAttempt, type WorkerIdentity } from "./worker_adapter.js";
import { reportProviderBackpressure, type BackpressureClass } from "./launch_lane.js";

type ActiveJob = {
  workspace_dir: string;
  project_id: string;
  job_id: string;
  status: "queued" | "running" | "completed" | "canceled";
  abort_controller: AbortController;
  promise: Promise<void>;
  error?: string;
};

const ACTIVE_JOBS = new Map<string, ActiveJob>();

function activeJobKey(workspaceDir: string, projectId: string, jobId: string): string {
  return `${path.resolve(workspaceDir)}::${projectId}::${jobId}`;
}

function jobsDir(workspaceDir: string, projectId: string): string {
  return path.join(workspaceDir, "work/projects", projectId, "jobs");
}

function jobDir(workspaceDir: string, projectId: string, jobId: string): string {
  return path.join(jobsDir(workspaceDir, projectId), jobId);
}

function jobRecordPath(workspaceDir: string, projectId: string, jobId: string): string {
  return path.join(jobDir(workspaceDir, projectId, jobId), "job.yaml");
}

function jobResultPath(workspaceDir: string, projectId: string, jobId: string): string {
  return path.join(jobDir(workspaceDir, projectId, jobId), "result.json");
}

function jobManagerDigestPath(workspaceDir: string, projectId: string, jobId: string): string {
  return path.join(jobDir(workspaceDir, projectId, jobId), "manager_digest.json");
}

function jobHeartbeatReportPath(workspaceDir: string, projectId: string, jobId: string): string {
  return path.join(jobDir(workspaceDir, projectId, jobId), "heartbeat_report.json");
}

function isProviderForWorkerKind(provider: string, workerKind: JobSpec["worker_kind"]): boolean {
  const p = provider.toLowerCase();
  if (workerKind === "codex") return p.startsWith("codex");
  if (workerKind === "claude") return p.startsWith("claude");
  return p.startsWith("gemini");
}

function classifyWorkerFailure(args: { error?: string; output?: string }): BackpressureClass | null {
  const text = `${args.error ?? ""}\n${args.output ?? ""}`.toLowerCase();
  if (!text.trim()) return null;
  if (
    text.includes("rate limit") ||
    text.includes("too many requests") ||
    text.includes("429") ||
    text.includes("quota exceeded") ||
    text.includes("backoff")
  ) {
    return "rate_limit";
  }
  if (
    text.includes("not logged in") ||
    text.includes("authentication") ||
    text.includes("unauthorized") ||
    text.includes("forbidden")
  ) {
    return "auth";
  }
  if (
    text.includes("waiting for approval") ||
    text.includes("permission prompt") ||
    text.includes("interactive")
  ) {
    return "interactive";
  }
  if (
    text.includes("econnreset") ||
    text.includes("etimedout") ||
    text.includes("network") ||
    text.includes("socket hang up")
  ) {
    return "transient";
  }
  return null;
}

async function readWorkerIdentity(workspaceDir: string, agentId: string): Promise<WorkerIdentity> {
  const p = path.join(workspaceDir, "org/agents", agentId, "agent.yaml");
  const agent = AgentYaml.parse(await readYamlFile(p));
  return {
    agent_id: agent.id,
    provider: agent.provider,
    model_hint: agent.model_hint,
    launcher: agent.launcher
  };
}

async function resolveWorkerForJob(job: JobSpec): Promise<WorkerIdentity | null> {
  if (job.worker_agent_id) {
    const worker = await readWorkerIdentity(job.workspace_dir, job.worker_agent_id).catch(() => null);
    if (!worker) return null;
    return isProviderForWorkerKind(worker.provider, job.worker_kind) ? worker : null;
  }

  const agents = await listAgents({ workspace_dir: job.workspace_dir });
  const candidate = agents
    .filter((a) => a.role === "worker" || a.role === "manager")
    .find((a) => isProviderForWorkerKind(a.provider, job.worker_kind));
  if (!candidate) return null;
  return readWorkerIdentity(job.workspace_dir, candidate.agent_id);
}

async function resolveCodexReformatterWorker(job: JobSpec): Promise<WorkerIdentity | null> {
  const agents = await listAgents({ workspace_dir: job.workspace_dir });
  const codexCandidate = agents
    .filter((a) => a.role === "worker" || a.role === "manager")
    .find((a) => isProviderForWorkerKind(a.provider, "codex"));
  if (codexCandidate) return readWorkerIdentity(job.workspace_dir, codexCandidate.agent_id);
  const claudeCandidate = agents
    .filter((a) => a.role === "worker" || a.role === "manager")
    .find((a) => isProviderForWorkerKind(a.provider, "claude"));
  const candidate = claudeCandidate;
  if (!candidate) return null;
  return readWorkerIdentity(job.workspace_dir, candidate.agent_id);
}

function workerKindFromProvider(provider: string): JobSpec["worker_kind"] {
  const p = provider.toLowerCase();
  if (p.startsWith("codex")) return "codex";
  if (p.startsWith("claude")) return "claude";
  return "gemini";
}

function providerSupportsNativeSchema(provider: string): boolean {
  const p = provider.toLowerCase();
  return p.startsWith("codex") || p.startsWith("claude");
}

async function writeJobRecord(record: JobRecord): Promise<void> {
  const p = jobRecordPath(record.job.workspace_dir, record.job.project_id, record.job.job_id);
  await ensureDir(path.dirname(p));
  await writeYamlFile(p, record);
}

async function readJobRecord(args: {
  workspace_dir: string;
  project_id: string;
  job_id: string;
}): Promise<JobRecord> {
  const p = jobRecordPath(args.workspace_dir, args.project_id, args.job_id);
  return JobRecord.parse(await readYamlFile(p));
}

function attemptErrorFromValidation(errs: ResultError[]): string {
  return errs.map((e) => `${e.code}: ${e.message}`).join("; ");
}

function buildHeartbeatRepairPrompt(args: {
  job: JobSpec;
  attempt_run_id: string;
  previous_output: string;
  validation_errors: ResultError[];
}): string {
  const errors = args.validation_errors.map((e) => `- ${e.code}: ${e.message}`).join("\n");
  const preview = args.previous_output.slice(0, 8000);
  return [
    "Return JSON only. Do not include markdown fences.",
    "The JSON must match HeartbeatWorkerReport schema.",
    JSON.stringify(
      {
        schema_version: 1,
        type: "heartbeat_worker_report",
        status: "ok|actions",
        token: "HEARTBEAT_OK (required only when status=ok)",
        summary: "string",
        actions: [
          {
            kind: "launch_job|add_comment|create_approval_item|noop",
            idempotency_key: "string",
            risk: "low|medium|high",
            needs_approval: true
          }
        ]
      },
      null,
      2
    ),
    "",
    `job_id: ${args.job.job_id}`,
    `attempt_run_id: ${args.attempt_run_id}`,
    "",
    "Validation issues to fix:",
    errors || "- Unknown parse/shape failure",
    "",
    "Previous output:",
    preview
  ].join("\n");
}

function heartbeatReportToResult(args: {
  job_id: string;
  attempt_run_id: string;
  report: HeartbeatWorkerReportType;
}): ResultSpecType {
  return ResultSpec.parse({
    schema_version: 1,
    type: "result",
    job_id: args.job_id,
    attempt_run_id: args.attempt_run_id,
    status: "succeeded",
    summary: args.report.summary,
    files_changed: [],
    commands_run: [],
    artifacts: [],
    next_actions:
      args.report.status === "actions"
        ? args.report.actions.map((a) => ({
            action: `${a.kind}:${a.idempotency_key}`,
            rationale: a.summary
          }))
        : [],
    errors: []
  });
}

async function finalizeJob(args: {
  record: JobRecord;
  result: ResultSpecType;
  signals?: Record<string, unknown>;
}): Promise<void> {
  const resultPath = jobResultPath(args.record.job.workspace_dir, args.record.job.project_id, args.record.job.job_id);
  const digestPath = jobManagerDigestPath(
    args.record.job.workspace_dir,
    args.record.job.project_id,
    args.record.job.job_id
  );
  const relResult = path.join("jobs", args.record.job.job_id, "result.json");
  await writeFileAtomic(resultPath, `${JSON.stringify(args.result, null, 2)}\n`);
  const digest = buildManagerDigest({ result: args.result, signals: args.signals });
  await writeFileAtomic(digestPath, `${JSON.stringify(digest, null, 2)}\n`);
  args.record.status = args.result.status === "canceled" ? "canceled" : "completed";
  args.record.updated_at = nowIso();
  args.record.final_result_relpath = relResult;
  await writeJobRecord(args.record);
}

export type SubmitJobResult = {
  workspace_dir: string;
  project_id: string;
  job_id: string;
  status: "queued" | "running" | "completed" | "canceled";
};

export type JobPollResult = {
  workspace_dir: string;
  project_id: string;
  job_id: string;
  status: "queued" | "running" | "completed" | "canceled";
  cancellation_requested: boolean;
  current_attempt: number;
  attempts: JobAttempt[];
  final_result_relpath?: string;
};

export type JobCollectResult = JobPollResult & {
  result?: ResultSpecType;
  manager_digest?: Record<string, unknown>;
  heartbeat_report?: HeartbeatWorkerReportType;
};

export async function submitJob(args: { job: JobSpec }): Promise<SubmitJobResult> {
  const job = JobSpec.parse({
    ...args.job,
    job_id: args.job.job_id?.trim() ? args.job.job_id : newId("job")
  });
  const key = activeJobKey(job.workspace_dir, job.project_id, job.job_id);
  if (ACTIVE_JOBS.has(key)) {
    const active = ACTIVE_JOBS.get(key)!;
    return {
      workspace_dir: job.workspace_dir,
      project_id: job.project_id,
      job_id: job.job_id,
      status: active.status
    };
  }

  const createdAt = nowIso();
  const rec = JobRecord.parse({
    schema_version: 1,
    type: "job_record",
    job,
    created_at: createdAt,
    updated_at: createdAt,
    status: "queued",
    cancellation_requested: false,
    current_attempt: 0,
    attempts: []
  });
  await writeJobRecord(rec);

  const controller = new AbortController();
  const active: ActiveJob = {
    workspace_dir: job.workspace_dir,
    project_id: job.project_id,
    job_id: job.job_id,
    status: "queued",
    abort_controller: controller,
    promise: Promise.resolve()
  };
  ACTIVE_JOBS.set(key, active);

  active.promise = (async () => {
    let record = rec;
    try {
      active.status = "running";
      record.status = "running";
      record.updated_at = nowIso();
      await writeJobRecord(record);

      const primaryWorker = await resolveWorkerForJob(job);
      if (!primaryWorker) {
        const blocked = ResultSpec.parse({
          schema_version: 1,
          type: "result",
          job_id: job.job_id,
          attempt_run_id: "none",
          status: "blocked",
          summary: `No eligible ${job.worker_kind} worker agent found for this job.`,
          files_changed: [],
          commands_run: [],
          artifacts: [],
          next_actions: [
            {
              action: `Create or configure a ${job.worker_kind} worker agent in workspace org/agents.`,
              rationale: "job routing failed"
            }
          ],
          errors: [
            {
              code: "worker_unavailable",
              message: `No worker found for worker_kind=${job.worker_kind}`
            }
          ]
        });
        await finalizeJob({
          record,
          result: blocked,
          signals: { reason: "worker_unavailable" }
        });
        active.status = "completed";
        return;
      }

      const attemptOutputs: Array<{ run_id: string; output: string; validation_errors: ResultError[] }> = [];
      let lastErrors: ResultError[] = [];
      const heartbeatJob = job.job_kind === "heartbeat";

      for (const attemptNo of [1, 2, 3]) {
        if (controller.signal.aborted) {
          const canceled = ResultSpec.parse({
            schema_version: 1,
            type: "result",
            job_id: job.job_id,
            attempt_run_id: attemptOutputs.at(-1)?.run_id ?? "none",
            status: "canceled",
            summary: "Job was canceled before completion.",
            files_changed: [],
            commands_run: [],
            artifacts: [],
            next_actions: [],
            errors: []
          });
          await finalizeJob({
            record,
            result: canceled,
            signals: { canceled: true }
          });
          active.status = "canceled";
          return;
        }

        const worker =
          attemptNo === 3 ? (await resolveCodexReformatterWorker(job)) ?? primaryWorker : primaryWorker;
        const prior = attemptOutputs.at(-1);
        const prompt =
          attemptNo === 1
            ? buildInitialAttemptPrompt({
                job,
                attempt_run_id: "__set_by_orchestrator__"
              })
            : heartbeatJob
              ? buildHeartbeatRepairPrompt({
                  job,
                  attempt_run_id: prior?.run_id ?? "__set_by_orchestrator__",
                  previous_output: prior?.output ?? "",
                  validation_errors: prior?.validation_errors ?? lastErrors
                })
              : attemptNo === 2
              ? buildStrictJsonRepairPrompt({
                  job,
                  attempt_run_id: prior?.run_id ?? "__set_by_orchestrator__",
                  previous_output: prior?.output ?? "",
                  validation_errors: prior?.validation_errors ?? lastErrors
                })
              : buildCodexReformatPrompt({
                  job,
                  attempt_run_id: prior?.run_id ?? "__set_by_orchestrator__",
                  previous_output: prior?.output ?? "",
                  validation_errors: prior?.validation_errors ?? lastErrors
                });

        const startedAt = nowIso();
        const attempt = await runWorkerAttempt({
          job,
          worker,
          worker_kind: attemptNo === 3 ? workerKindFromProvider(worker.provider) : job.worker_kind,
          prompt,
          attempt: attemptNo,
          result_contract_mode: providerSupportsNativeSchema(worker.provider)
            ? "provider_schema"
            : "prompt_only",
          output_contract: heartbeatJob ? "heartbeat_worker_report" : "result_spec",
          abort_signal: controller.signal
        });
        const endedAt = nowIso();
        record.current_attempt = attemptNo;
        record.attempts.push({
          attempt: attemptNo,
          run_id: attempt.run_id,
          context_pack_id: attempt.context_pack_id,
          session_ref: attempt.session_ref,
          worker_kind: attemptNo === 3 ? workerKindFromProvider(worker.provider) : job.worker_kind,
          worker_agent_id: worker.agent_id,
          provider: worker.provider,
          provider_bin: attempt.provider_bin,
          provider_version: attempt.provider_version,
          provider_help_hash: attempt.provider_help_hash,
          output_format: attempt.output_format,
          started_at: startedAt,
          ended_at: endedAt,
          status: attempt.status,
          error: attempt.error
        });
        record.updated_at = endedAt;
        await writeJobRecord(record);

        if (attempt.blocked_reason === "subscription_unverified") {
          const blocked = ResultSpec.parse({
            schema_version: 1,
            type: "result",
            job_id: job.job_id,
            attempt_run_id: attempt.run_id,
            status: "blocked",
            summary: "Worker preflight policy checks failed; run blocked before execution.",
            files_changed: [],
            commands_run: [],
            artifacts: [],
            next_actions: [
              {
                action: "Fix provider policy/auth configuration and retry.",
                rationale: "fail-closed preflight policy"
              }
            ],
            errors: [
              {
                code: "subscription_unverified",
                message: attempt.error ?? "Worker preflight policy check failed"
              }
            ]
          });
          await finalizeJob({
            record,
            result: blocked,
            signals: { blocked_reason: "subscription_unverified", provider: worker.provider }
          });
          active.status = "completed";
          return;
        }

        if (attempt.status !== "ended") {
          const pressureClass = classifyWorkerFailure({
            error: attempt.error,
            output: attempt.raw_output
          });
          if (pressureClass && pressureClass !== "auth") {
            reportProviderBackpressure(job.workspace_dir, worker.provider, attempt.error ?? "provider_backpressure", {
              class: pressureClass
            });
          }
          lastErrors = [
            {
              code: "worker_attempt_failed",
              message: attempt.error ?? `Attempt ended with status=${attempt.status}`
            }
          ];
          attemptOutputs.push({
            run_id: attempt.run_id,
            output: attempt.raw_output,
            validation_errors: lastErrors
          });
          continue;
        }

        const candidate = heartbeatJob
          ? extractGenericJsonObjectCandidate(attempt.raw_output)
          : extractResultCandidate(attempt.raw_output);
        if (candidate === null) {
          lastErrors = [
            {
              code: heartbeatJob ? "heartbeat_report_unparseable" : "result_unparseable",
              message: heartbeatJob
                ? "Unable to parse worker heartbeat report as JSON"
                : "Unable to parse worker output as JSON"
            }
          ];
          attemptOutputs.push({
            run_id: attempt.run_id,
            output: attempt.raw_output,
            validation_errors: lastErrors
          });
          continue;
        }

        if (heartbeatJob) {
          const parsed = HeartbeatWorkerReport.safeParse(candidate);
          if (!parsed.success) {
            lastErrors = parsed.error.issues.map((i) => ({
              code: "heartbeat_report_schema_invalid",
              message: i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message
            }));
            attemptOutputs.push({
              run_id: attempt.run_id,
              output: attempt.raw_output,
              validation_errors: lastErrors
            });
            continue;
          }
          await writeFileAtomic(
            jobHeartbeatReportPath(job.workspace_dir, job.project_id, job.job_id),
            `${JSON.stringify(parsed.data, null, 2)}\n`
          );
          const synthesized = heartbeatReportToResult({
            job_id: job.job_id,
            attempt_run_id: attempt.run_id,
            report: parsed.data
          });
          await finalizeJob({
            record,
            result: synthesized,
            signals: {
              retries_used: attemptNo - 1,
              normalization: "heartbeat_report_valid",
              heartbeat_status: parsed.data.status
            }
          });
          active.status = "completed";
          return;
        } else {
          const validated = validateResultCandidate({
            candidate,
            job_id: job.job_id,
            attempt_run_id: attempt.run_id
          });
          if (!validated.ok) {
            lastErrors = validated.errors;
            attemptOutputs.push({
              run_id: attempt.run_id,
              output: attempt.raw_output,
              validation_errors: validated.errors
            });
            continue;
          }

          await finalizeJob({
            record,
            result: validated.result,
            signals: {
              retries_used: attemptNo - 1,
              normalization: "schema_valid"
            }
          });
          active.status = validated.result.status === "canceled" ? "canceled" : "completed";
          return;
        }
      }

      const fallback = buildFallbackNeedsInputResult({
        job_id: job.job_id,
        attempt_run_id: attemptOutputs.at(-1)?.run_id ?? "none",
        errors: lastErrors
      });
      await finalizeJob({
        record,
        result: fallback,
        signals: {
          retries_used: 2,
          normalization: "fallback_needs_input",
          last_validation_error: attemptErrorFromValidation(lastErrors)
        }
      });
      active.status = "completed";
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      active.error = msg;
      try {
        record = await readJobRecord({
          workspace_dir: job.workspace_dir,
          project_id: job.project_id,
          job_id: job.job_id
        });
      } catch {
        // keep best-effort local record
      }
      const failed = ResultSpec.parse({
        schema_version: 1,
        type: "result",
        job_id: job.job_id,
        attempt_run_id: record.attempts.at(-1)?.run_id ?? "none",
        status: controller.signal.aborted ? "canceled" : "failed",
        summary: controller.signal.aborted
          ? "Job was canceled."
          : "Job runner failed before producing a valid result.",
        files_changed: [],
        commands_run: [],
        artifacts: [],
        next_actions: [],
        errors: [{ code: "job_runner_error", message: msg }]
      });
      await finalizeJob({
        record,
        result: failed,
        signals: { unhandled_error: true }
      }).catch(() => {});
      active.status = controller.signal.aborted ? "canceled" : "completed";
    } finally {
      ACTIVE_JOBS.delete(key);
    }
  })();

  return {
    workspace_dir: job.workspace_dir,
    project_id: job.project_id,
    job_id: job.job_id,
    status: "queued"
  };
}

export async function pollJob(args: {
  workspace_dir: string;
  project_id: string;
  job_id: string;
}): Promise<JobPollResult> {
  const rec = await readJobRecord(args);
  return {
    workspace_dir: args.workspace_dir,
    project_id: args.project_id,
    job_id: args.job_id,
    status: rec.status,
    cancellation_requested: rec.cancellation_requested,
    current_attempt: rec.current_attempt,
    attempts: rec.attempts,
    final_result_relpath: rec.final_result_relpath
  };
}

export async function collectJob(args: {
  workspace_dir: string;
  project_id: string;
  job_id: string;
}): Promise<JobCollectResult> {
  const poll = await pollJob(args);
  const resultPath = jobResultPath(args.workspace_dir, args.project_id, args.job_id);
  const digestPath = jobManagerDigestPath(args.workspace_dir, args.project_id, args.job_id);
  const heartbeatReportPath = jobHeartbeatReportPath(args.workspace_dir, args.project_id, args.job_id);
  let result: ResultSpecType | undefined;
  let digest: Record<string, unknown> | undefined;
  let heartbeatReport: HeartbeatWorkerReportType | undefined;
  if (await pathExists(resultPath)) {
    const raw = await fs.readFile(resultPath, { encoding: "utf8" });
    result = ResultSpec.parse(JSON.parse(raw));
  }
  if (await pathExists(digestPath)) {
    const raw = await fs.readFile(digestPath, { encoding: "utf8" });
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      digest = parsed as Record<string, unknown>;
    }
  }
  if (await pathExists(heartbeatReportPath)) {
    const raw = await fs.readFile(heartbeatReportPath, { encoding: "utf8" });
    heartbeatReport = HeartbeatWorkerReport.parse(JSON.parse(raw));
  }
  return {
    ...poll,
    result,
    manager_digest: digest,
    heartbeat_report: heartbeatReport
  };
}

export async function cancelJob(args: {
  workspace_dir: string;
  project_id: string;
  job_id: string;
}): Promise<JobPollResult> {
  const rec = await readJobRecord(args);
  rec.cancellation_requested = true;
  rec.updated_at = nowIso();
  await writeJobRecord(rec);
  const key = activeJobKey(args.workspace_dir, args.project_id, args.job_id);
  const active = ACTIVE_JOBS.get(key);
  if (active) {
    active.abort_controller.abort();
    active.status = "canceled";
  }
  return pollJob(args);
}

export async function listJobs(args: {
  workspace_dir: string;
  project_id: string;
  status?: "queued" | "running" | "completed" | "canceled";
  limit?: number;
}): Promise<JobPollResult[]> {
  const dir = jobsDir(args.workspace_dir, args.project_id);
  const lim = Math.max(1, Math.min(args.limit ?? 200, 5000));
  let entries: string[] = [];
  try {
    entries = (await fs.readdir(dir)).sort();
  } catch {
    return [];
  }
  const rows: JobPollResult[] = [];
  for (const id of entries) {
    const p = jobRecordPath(args.workspace_dir, args.project_id, id);
    try {
      const rec = JobRecord.parse(await readYamlFile(p));
      if (args.status && rec.status !== args.status) continue;
      rows.push({
        workspace_dir: args.workspace_dir,
        project_id: args.project_id,
        job_id: rec.job.job_id,
        status: rec.status,
        cancellation_requested: rec.cancellation_requested,
        current_attempt: rec.current_attempt,
        attempts: rec.attempts,
        final_result_relpath: rec.final_result_relpath
      });
    } catch {
      // ignore malformed records
    }
  }
  rows.sort((a, b) => a.job_id.localeCompare(b.job_id));
  return rows.slice(0, lim);
}
