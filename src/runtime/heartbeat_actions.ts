import { newId } from "../core/ids.js";
import { nowIso } from "../core/time.js";
import { createComment } from "../comments/comment.js";
import { enforcePolicy, type EnforcePolicyArgs } from "../policy/enforce.js";
import {
  HeartbeatAction,
  type HeartbeatAction as HeartbeatActionType,
  type HeartbeatConfig,
  type HeartbeatState,
  type HeartbeatWorkerReport
} from "../schemas/heartbeat.js";
import { submitJob } from "./job_runner.js";
import {
  createHeartbeatActionProposal,
  type HeartbeatActionProposalFrontmatter
} from "../heartbeat/action_proposal.js";
import { readHeartbeatConfig, readHeartbeatState, writeHeartbeatState } from "./heartbeat_store.js";

type ExecOutcome = {
  executed: boolean;
  queued: boolean;
  deduped: boolean;
  skipped: boolean;
  reason?: string;
  proposal_artifact_id?: string;
  launched_job_id?: string;
};

export type HeartbeatActionApplyResult = {
  executed_actions: number;
  queued_for_approval: number;
  deduped_actions: number;
  skipped_actions: number;
  proposal_artifact_ids: string[];
  launched_job_ids: string[];
};

function parseIsoMs(value: string | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function isQuietHours(now: Date, startHour: number, endHour: number): boolean {
  const h = now.getHours();
  if (startHour === endHour) return false;
  if (startHour < endHour) return h >= startHour && h < endHour;
  return h >= startHour || h < endHour;
}

function toHourBucketKey(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(
    2,
    "0"
  )}-${String(now.getUTCHours()).padStart(2, "0")}`;
}

function cleanupDurableCounters(state: HeartbeatState, now: Date): void {
  const nowMs = now.getTime();
  for (const [key, val] of Object.entries(state.idempotency)) {
    const expiresMs = parseIsoMs(val.expires_at);
    if (expiresMs !== null && expiresMs <= nowMs) {
      delete state.idempotency[key];
    }
  }

  const staleBefore = nowMs - 48 * 60 * 60 * 1000;
  for (const key of Object.keys(state.hourly_action_counters)) {
    const parsed = Date.parse(`${key.replace(/-/g, ":").replace(/:(\d\d)$/, "T$1:00:00Z")}`);
    if (Number.isFinite(parsed) && parsed < staleBefore) {
      delete state.hourly_action_counters[key];
    }
  }
}

function rememberIdempotency(args: {
  state: HeartbeatState;
  action: HeartbeatActionType;
  status: "queued" | "executed";
  nowIso: string;
  ttl_days: number;
}): void {
  const expiresAt = new Date(Date.parse(args.nowIso) + args.ttl_days * 24 * 60 * 60 * 1000).toISOString();
  const prev = args.state.idempotency[args.action.idempotency_key];
  args.state.idempotency[args.action.idempotency_key] = {
    idempotency_key: args.action.idempotency_key,
    action_kind: args.action.kind,
    first_seen_at: prev?.first_seen_at ?? args.nowIso,
    last_seen_at: args.nowIso,
    expires_at: expiresAt,
    status: args.status,
    execution_count: args.status === "executed" ? (prev?.execution_count ?? 0) + 1 : prev?.execution_count ?? 0
  };
}

async function queueProposal(args: {
  workspace_dir: string;
  project_id: string;
  summary: string;
  title: string;
  rationale?: string;
  produced_by: string;
  run_id: string;
  context_pack_id: string;
  action: HeartbeatActionType;
  dry_run?: boolean;
}): Promise<{ artifact_id?: string }> {
  if (args.dry_run) return {};
  const created = await createHeartbeatActionProposal({
    workspace_dir: args.workspace_dir,
    project_id: args.project_id,
    title: args.title,
    summary: args.summary,
    produced_by: args.produced_by,
    run_id: args.run_id,
    context_pack_id: args.context_pack_id,
    proposed_action: args.action,
    rationale: args.rationale,
    visibility: "managers"
  });
  return { artifact_id: created.artifact_id };
}

function policyArgsForAuto(args: {
  workspace_dir: string;
  action: HeartbeatActionType;
  actor_id: string;
  actor_role: "human" | "ceo" | "director" | "manager" | "worker";
  actor_team_id?: string;
}): EnforcePolicyArgs | null {
  if (args.action.kind === "noop") return null;
  const projectId = "project_id" in args.action ? args.action.project_id : undefined;
  if (!projectId) return null;
  return {
    workspace_dir: args.workspace_dir,
    project_id: projectId,
    actor_id: args.actor_id,
    actor_role: args.actor_role,
    actor_team_id: args.actor_team_id,
    action: args.action.kind === "launch_job" ? "launch" : "approve",
    resource: {
      resource_id: args.action.idempotency_key,
      kind: "heartbeat_action",
      visibility: args.action.visibility ?? "managers",
      team_id: args.actor_team_id
    }
  };
}

async function executeAutoAction(args: {
  workspace_dir: string;
  action: HeartbeatActionType;
  actor_id: string;
  actor_role: "human" | "ceo" | "director" | "manager" | "worker";
  actor_team_id?: string;
  dry_run?: boolean;
}): Promise<{ launched_job_id?: string }> {
  const policy = policyArgsForAuto(args);
  if (policy) {
    await enforcePolicy(policy);
  }

  if (args.dry_run) return {};

  if (args.action.kind === "launch_job") {
    const jobId = newId("job");
    await submitJob({
      job: {
        schema_version: 1,
        type: "job",
        job_id: jobId,
        job_kind: "execution",
        worker_kind: args.action.worker_kind,
        workspace_dir: args.workspace_dir,
        project_id: args.action.project_id,
        goal: args.action.goal,
        constraints: args.action.constraints,
        deliverables: args.action.deliverables.length ? args.action.deliverables : ["Follow-up action"],
        permission_level: args.action.permission_level,
        context_refs: args.action.context_note
          ? [{ kind: "note", value: args.action.context_note }]
          : [{ kind: "note", value: `Created by heartbeat action ${args.action.idempotency_key}` }],
        worker_agent_id: args.action.worker_agent_id
      }
    });
    return { launched_job_id: jobId };
  }

  if (args.action.kind === "add_comment") {
    await createComment({
      workspace_dir: args.workspace_dir,
      project_id: args.action.project_id,
      author_id: args.actor_id,
      author_role: args.actor_role,
      visibility: args.action.visibility ?? "managers",
      body: args.action.body,
      target_agent_id: args.action.target_agent_id,
      target_artifact_id: args.action.target_artifact_id,
      target_run_id: args.action.target_run_id
    });
    return {};
  }

  if (args.action.kind === "create_approval_item") {
    return {};
  }

  return {};
}

function asActionList(report: HeartbeatWorkerReport): HeartbeatActionType[] {
  if (report.status !== "actions") return [];
  return report.actions.map((a) => HeartbeatAction.parse(a));
}

async function executeOneAction(args: {
  workspace_dir: string;
  action: HeartbeatActionType;
  config: HeartbeatConfig;
  state: HeartbeatState;
  source_worker_agent_id: string;
  source_run_id: string;
  source_context_pack_id: string;
  actor_id: string;
  actor_role: "human" | "ceo" | "director" | "manager" | "worker";
  actor_team_id?: string;
  tick_auto_executed_count: number;
  dry_run?: boolean;
  bypass_approval_gate?: boolean;
}): Promise<ExecOutcome> {
  cleanupDurableCounters(args.state, new Date());
  const now = new Date();
  const nowText = now.toISOString();
  const existing = args.state.idempotency[args.action.idempotency_key];
  if (existing) {
    return { deduped: true, executed: false, queued: false, skipped: false, reason: "duplicate_idempotency_key" };
  }

  const hourKey = toHourBucketKey(now);
  const hourCount = args.state.hourly_action_counters[hourKey] ?? 0;
  const quiet = isQuietHours(now, args.config.quiet_hours_start_hour, args.config.quiet_hours_end_hour);
  const exceededTick = args.tick_auto_executed_count >= args.config.max_auto_actions_per_tick;
  const exceededHour = hourCount >= args.config.max_auto_actions_per_hour;

  const needsApprovalByPolicy =
    !args.bypass_approval_gate &&
    (args.action.kind === "create_approval_item" ||
      args.action.needs_approval ||
      args.action.risk !== "low" ||
      (quiet && args.action.kind === "add_comment") ||
      exceededTick ||
      exceededHour);

  if (needsApprovalByPolicy) {
    const projId = "project_id" in args.action ? args.action.project_id : undefined;
    if (!projId) {
      rememberIdempotency({
        state: args.state,
        action: args.action,
        status: "queued",
        nowIso: nowText,
        ttl_days: args.config.idempotency_ttl_days
      });
      return { skipped: true, executed: false, queued: false, deduped: false, reason: "missing_project_for_approval" };
    }

    const proposalAction =
      args.action.kind === "create_approval_item"
        ? args.action.proposed_action ?? {
            kind: "noop",
            idempotency_key: `${args.action.idempotency_key}:noop`,
            risk: "low",
            needs_approval: false,
            reason: args.action.rationale ?? "No proposed action supplied"
          }
        : args.action;

    const proposal = await queueProposal({
      workspace_dir: args.workspace_dir,
      project_id: projId,
      title:
        args.action.kind === "create_approval_item"
          ? args.action.title
          : `Heartbeat approval: ${args.action.kind}`,
      summary:
        args.action.summary ??
        `Coordinator queued ${args.action.kind} from ${args.source_worker_agent_id} for manager approval.`,
      rationale:
        args.action.kind === "create_approval_item"
          ? args.action.rationale
          : exceededTick
            ? "Auto-action per-tick limit reached"
            : exceededHour
              ? "Auto-action per-hour limit reached"
              : quiet
                ? "Quiet hours deferment"
                : "Risk/approval policy gate",
      produced_by: args.source_worker_agent_id,
      run_id: args.source_run_id,
      context_pack_id: args.source_context_pack_id,
      action: proposalAction,
      dry_run: args.dry_run
    });

    rememberIdempotency({
      state: args.state,
      action: args.action,
      status: "queued",
      nowIso: nowText,
      ttl_days: args.config.idempotency_ttl_days
    });

    return {
      executed: false,
      queued: true,
      deduped: false,
      skipped: false,
      proposal_artifact_id: proposal.artifact_id,
      reason: "queued_for_approval"
    };
  }

  const executed = await executeAutoAction({
    workspace_dir: args.workspace_dir,
    action: args.action,
    actor_id: args.actor_id,
    actor_role: args.actor_role,
    actor_team_id: args.actor_team_id,
    dry_run: args.dry_run
  });

  rememberIdempotency({
    state: args.state,
    action: args.action,
    status: "executed",
    nowIso: nowText,
    ttl_days: args.config.idempotency_ttl_days
  });
  if (!args.dry_run) {
    args.state.hourly_action_counters[hourKey] = hourCount + 1;
  }
  return {
    executed: true,
    queued: false,
    deduped: false,
    skipped: false,
    launched_job_id: executed.launched_job_id
  };
}

export async function applyHeartbeatWorkerReportActions(args: {
  workspace_dir: string;
  report: HeartbeatWorkerReport;
  source_worker_agent_id: string;
  source_run_id: string;
  source_context_pack_id: string;
  config: HeartbeatConfig;
  state: HeartbeatState;
  actor_id?: string;
  actor_role?: "human" | "ceo" | "director" | "manager" | "worker";
  actor_team_id?: string;
  dry_run?: boolean;
}): Promise<{ state: HeartbeatState; summary: HeartbeatActionApplyResult }> {
  const summary: HeartbeatActionApplyResult = {
    executed_actions: 0,
    queued_for_approval: 0,
    deduped_actions: 0,
    skipped_actions: 0,
    proposal_artifact_ids: [],
    launched_job_ids: []
  };

  if (args.report.status !== "actions") {
    return { state: args.state, summary };
  }

  let tickAutoExecutedCount = 0;
  for (const raw of asActionList(args.report)) {
    const outcome = await executeOneAction({
      workspace_dir: args.workspace_dir,
      action: raw,
      config: args.config,
      state: args.state,
      source_worker_agent_id: args.source_worker_agent_id,
      source_run_id: args.source_run_id,
      source_context_pack_id: args.source_context_pack_id,
      actor_id: args.actor_id ?? "heartbeat_coordinator",
      actor_role: args.actor_role ?? "manager",
      actor_team_id: args.actor_team_id,
      tick_auto_executed_count: tickAutoExecutedCount,
      dry_run: args.dry_run
    });

    if (outcome.executed) {
      summary.executed_actions += 1;
      tickAutoExecutedCount += 1;
    }
    if (outcome.queued) {
      summary.queued_for_approval += 1;
    }
    if (outcome.deduped) {
      summary.deduped_actions += 1;
    }
    if (outcome.skipped) {
      summary.skipped_actions += 1;
    }
    if (outcome.proposal_artifact_id) {
      summary.proposal_artifact_ids.push(outcome.proposal_artifact_id);
    }
    if (outcome.launched_job_id) {
      summary.launched_job_ids.push(outcome.launched_job_id);
    }
  }

  return {
    state: args.state,
    summary
  };
}

export async function executeApprovedHeartbeatProposal(args: {
  workspace_dir: string;
  proposal: HeartbeatActionProposalFrontmatter;
  actor_id: string;
  actor_role: "human" | "ceo" | "director" | "manager" | "worker";
  actor_team_id?: string;
  dry_run?: boolean;
}): Promise<{ state: HeartbeatState; summary: HeartbeatActionApplyResult }> {
  const config = await readHeartbeatConfig(args.workspace_dir);
  const state = await readHeartbeatState(args.workspace_dir);
  const action = HeartbeatAction.parse(args.proposal.proposed_action);
  const sourceWorker = args.proposal.produced_by || "heartbeat_worker";

  const normalizedAction: HeartbeatActionType =
    action.kind === "create_approval_item" ? action.proposed_action ?? {
      kind: "noop",
      idempotency_key: `${action.idempotency_key}:noop`,
      risk: "low",
      needs_approval: false,
      reason: action.rationale ?? "No proposed action provided"
    } : action;

  const outcome = await executeOneAction({
    workspace_dir: args.workspace_dir,
    action: normalizedAction,
    config,
    state,
    source_worker_agent_id: sourceWorker,
    source_run_id: args.proposal.run_id,
    source_context_pack_id: args.proposal.context_pack_id,
    actor_id: args.actor_id,
    actor_role: args.actor_role,
    actor_team_id: args.actor_team_id,
    tick_auto_executed_count: 0,
    dry_run: args.dry_run,
    bypass_approval_gate: true
  });

  const summary: HeartbeatActionApplyResult = {
    executed_actions: outcome.executed ? 1 : 0,
    queued_for_approval: outcome.queued ? 1 : 0,
    deduped_actions: outcome.deduped ? 1 : 0,
    skipped_actions: outcome.skipped ? 1 : 0,
    proposal_artifact_ids: outcome.proposal_artifact_id ? [outcome.proposal_artifact_id] : [],
    launched_job_ids: outcome.launched_job_id ? [outcome.launched_job_id] : []
  };

  if (!args.dry_run) {
    await writeHeartbeatState({ workspace_dir: args.workspace_dir, state });
  }

  return { state, summary };
}

export async function applyHeartbeatReportWithDurableState(args: {
  workspace_dir: string;
  report: HeartbeatWorkerReport;
  source_worker_agent_id: string;
  source_run_id: string;
  source_context_pack_id: string;
  actor_id?: string;
  actor_role?: "human" | "ceo" | "director" | "manager" | "worker";
  actor_team_id?: string;
  dry_run?: boolean;
}): Promise<HeartbeatActionApplyResult> {
  const config = await readHeartbeatConfig(args.workspace_dir);
  const state = await readHeartbeatState(args.workspace_dir);
  const applied = await applyHeartbeatWorkerReportActions({
    workspace_dir: args.workspace_dir,
    report: args.report,
    source_worker_agent_id: args.source_worker_agent_id,
    source_run_id: args.source_run_id,
    source_context_pack_id: args.source_context_pack_id,
    actor_id: args.actor_id,
    actor_role: args.actor_role,
    actor_team_id: args.actor_team_id,
    config,
    state,
    dry_run: args.dry_run
  });

  if (!args.dry_run) {
    state.stats.actions_executed_total += applied.summary.executed_actions;
    state.stats.approvals_queued_total += applied.summary.queued_for_approval;
    state.stats.deduped_actions_total += applied.summary.deduped_actions;
    await writeHeartbeatState({ workspace_dir: args.workspace_dir, state });
  }
  return applied.summary;
}

export function actionSummaryAsSignals(summary: HeartbeatActionApplyResult): Record<string, unknown> {
  return {
    executed_actions: summary.executed_actions,
    queued_for_approval: summary.queued_for_approval,
    deduped_actions: summary.deduped_actions,
    skipped_actions: summary.skipped_actions,
    proposal_artifact_ids: summary.proposal_artifact_ids,
    launched_job_ids: summary.launched_job_ids,
    at: nowIso()
  };
}
