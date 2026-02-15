import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { initWorkspace } from "../workspace/init.js";
import { validateWorkspace } from "../workspace/validate.js";
import { doctorWorkspace } from "../workspace/doctor.js";
import { createWorkspaceDiagnosticsBundle } from "../workspace/diagnostics.js";
import { migrateWorkspace } from "../workspace/migrate.js";
import { exportWorkspace, importWorkspace } from "../workspace/export_import.js";
import { bootstrapWorkspacePresets } from "../workspace/bootstrap_presets.js";
import { ensureEnterpriseDefaults } from "../workspace/enterprise_defaults.js";
import { createRun } from "../runtime/run.js";
import {
  launchSession,
  pollSession,
  collectSession,
  stopSession,
  listSessions
} from "../runtime/session.js";
import { cleanupWorktrees } from "../runtime/worktree_cleanup.js";
import { submitJob, pollJob, collectJob, cancelJob, listJobs } from "../runtime/job_runner.js";
import { buildRunMonitorSnapshot } from "../runtime/run_monitor.js";
import { buildReviewInboxSnapshot } from "../runtime/review_inbox.js";
import { buildUiSnapshot } from "../runtime/ui_bundle.js";
import { buildUsageAnalyticsSnapshot } from "../runtime/usage_analytics.js";
import {
  buildUsageReconciliationSnapshot,
  recordUsageReconciliationStatement
} from "../runtime/usage_reconciliation.js";
import { readIndexSyncWorkerStatus, flushIndexSyncWorker } from "../runtime/index_sync_service.js";
import { getDefaultHeartbeatService } from "../runtime/heartbeat_service.js";
import { resolveInboxItem } from "../inbox/resolve.js";
import { resolveInboxAndBuildUiSnapshot } from "../ui/resolve_and_snapshot.js";
import { createComment, listComments } from "../comments/comment.js";
import { listAgents as listOrgAgents } from "../org/agents_list.js";
import { listRuns } from "../runtime/run_queries.js";
import { replayRun } from "../runtime/replay.js";
import { replaySharePack } from "../share/replay.js";
import { listProjects } from "../work/projects_list.js";
import { createProjectWithDefaults } from "../work/projects_with_defaults.js";
import { linkProjectRepo, readProjectRepoLinks } from "../work/project_repo_links.js";
import { listTeams as listOrgTeams } from "../org/teams_list.js";
import { listProjectTasks } from "../work/tasks_list.js";
import { updateTaskPlan } from "../work/tasks_plan_update.js";
import { buildWorkspaceHomeSnapshot } from "../runtime/workspace_home.js";
import { buildPmSnapshot } from "../runtime/pm_snapshot.js";
import { recommendTaskAllocations, applyTaskAllocations } from "../runtime/allocation_recommend.js";
import {
  listConversations,
  createConversation,
  listConversationMessages,
  sendConversationMessage
} from "../conversations/store.js";
import { ensureProjectDefaults, ensureWorkspaceDefaults } from "../conversations/defaults.js";
import { buildAgentProfileSnapshot } from "../runtime/agent_profile.js";
import { buildResourcesSnapshot } from "../runtime/resources_snapshot.js";
import { proposeMemoryDelta } from "../memory/propose_memory_delta.js";
import { approveMemoryDelta } from "../memory/approve_memory_delta.js";
import { listMemoryDeltas } from "../memory/list_memory_deltas.js";
import { approveMilestone } from "../milestones/approve_milestone.js";
import { recordAgentMistake } from "../eval/mistake_loop.js";
import { runSelfImproveCycle } from "../eval/self_improve_cycle.js";
import { refreshAgentContextIndex } from "../eval/agent_context_index.js";
import { planContextForJob } from "../runtime/context_plan.js";
import { setRepoRoot } from "../machine/machine.js";
import { readYamlFile } from "../store/yaml.js";
import { ReviewYaml } from "../schemas/review.js";
import { JobSpec } from "../schemas/job.js";
import { extractSessionCommitCandidates } from "../memory/extract_session_commit_candidates.js";
import { validateHelpRequestMarkdown } from "../help/help_request.js";
import { parseFrontMatter } from "../artifacts/frontmatter.js";
import { readArtifactWithPolicy } from "../artifacts/read_artifact.js";
import { listAdapterStatuses } from "../adapters/registry.js";
import { runClientIntakePipeline } from "../pipeline/client_intake_run.js";
import { assignDepartmentTasks } from "../pipeline/department_assignment.js";
import {
  rebuildSqliteIndex,
  syncSqliteIndex,
  listIndexedRuns,
  listIndexedEvents,
  listIndexedEventParseErrors,
  listIndexedReviews,
  listIndexedHelpRequests,
  readIndexStats
} from "../index/sqlite.js";

export class RpcUserError extends Error {
  override name = "RpcUserError";
}

const WorkspaceOpenParams = z.object({
  workspace_dir: z.string().min(1)
});

const WorkspaceValidateParams = WorkspaceOpenParams;

const WorkspaceInitParams = z.object({
  workspace_dir: z.string().min(1),
  company_name: z.string().min(1).default("AgentCompany"),
  force: z.boolean().default(false)
});

const WorkspaceBootstrapEnterpriseParams = z
  .object({
    workspace_dir: z.string().min(1),
    company_name: z.string().min(1).default("AgentCompany"),
    project_name: z.string().min(1).default("AgentCompany Ops"),
    org_mode: z.enum(["enterprise", "standard"]).default("enterprise"),
    executive_manager_name: z.string().min(1).default("Executive Manager"),
    departments: z.array(z.string().min(1)).optional(),
    workers_per_dept: z.number().int().min(1).max(20).default(2),
    include_ceo: z.boolean().default(true),
    include_director: z.boolean().default(true),
    force: z.boolean().default(false)
  })
  .strict();

const WorkspaceEnterpriseEnsureDefaultsParams = z
  .object({
    workspace_dir: z.string().min(1),
    company_name: z.string().min(1).default("AgentCompany"),
    project_name: z.string().min(1).default("AgentCompany Ops"),
    executive_manager_name: z.string().min(1).default("Executive Manager"),
    departments: z.array(z.string().min(1)).optional(),
    workers_per_dept: z.number().int().min(1).max(20).default(2)
  })
  .strict();

const WorkspaceDoctorParams = z.object({
  workspace_dir: z.string().min(1),
  rebuild_index: z.boolean().default(false),
  sync_index: z.boolean().default(false)
});

const WorkspaceDiagnosticsParams = z.object({
  workspace_dir: z.string().min(1),
  out_dir: z.string().min(1),
  rebuild_index: z.boolean().default(false),
  sync_index: z.boolean().default(true),
  monitor_limit: z.number().int().positive().max(5000).optional(),
  pending_limit: z.number().int().positive().max(5000).optional(),
  decisions_limit: z.number().int().positive().max(5000).optional()
});

const WorkspaceMigrateParams = z.object({
  workspace_dir: z.string().min(1),
  dry_run: z.boolean().default(false),
  force: z.boolean().default(false)
});

const WorkspaceExportParams = z.object({
  workspace_dir: z.string().min(1),
  out_dir: z.string().min(1),
  include_local: z.boolean().default(false),
  force: z.boolean().default(false)
});

const WorkspaceImportParams = z.object({
  src_dir: z.string().min(1),
  workspace_dir: z.string().min(1),
  include_local: z.boolean().default(false),
  force: z.boolean().default(false)
});

const WorktreeCleanupParams = z.object({
  workspace_dir: z.string().min(1),
  project_id: z.string().min(1).optional(),
  max_age_hours: z.number().nonnegative().optional(),
  dry_run: z.boolean().default(false)
});

const RunCreateParams = z.object({
  workspace_dir: z.string().min(1),
  project_id: z.string().min(1),
  agent_id: z.string().min(1),
  provider: z.string().min(1)
});

const BudgetThresholdParams = z
  .object({
    soft_cost_usd: z.number().finite().nonnegative().optional(),
    hard_cost_usd: z.number().finite().nonnegative().optional(),
    soft_tokens: z.number().int().nonnegative().optional(),
    hard_tokens: z.number().int().nonnegative().optional()
  })
  .strict();

const SessionLaunchParams = z.object({
  workspace_dir: z.string().min(1),
  project_id: z.string().min(1),
  run_id: z.string().min(1),
  argv: z.array(z.string().min(1)).default([]),
  repo_id: z.string().min(1).optional(),
  workdir_rel: z.string().min(1).optional(),
  task_id: z.string().min(1).optional(),
  milestone_id: z.string().min(1).optional(),
  prompt_text: z.string().optional(),
  model: z.string().min(1).optional(),
  budget: BudgetThresholdParams.optional(),
  stdin_text: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  session_ref: z.string().min(1).optional(),
  lane_priority: z.enum(["high", "normal", "low"]).optional(),
  lane_workspace_limit: z.number().int().positive().optional(),
  lane_provider_limit: z.number().int().positive().optional(),
  lane_team_limit: z.number().int().positive().optional(),
  actor_id: z.string().min(1).default("human"),
  actor_role: z.enum(["human", "ceo", "director", "manager", "worker"]).default("human"),
  actor_team_id: z.string().min(1).optional()
});

const SessionSingleParams = z.object({
  session_ref: z.string().min(1),
  workspace_dir: z.string().min(1).optional()
});

const SessionListParams = z.object({
  workspace_dir: z.string().min(1).optional(),
  project_id: z.string().min(1).optional(),
  run_id: z.string().min(1).optional(),
  status: z.enum(["running", "ended", "failed", "stopped"]).optional()
});

const JobSubmitParams = z.object({
  job: JobSpec
});

const JobSingleParams = z.object({
  workspace_dir: z.string().min(1),
  project_id: z.string().min(1),
  job_id: z.string().min(1)
});

const JobListParams = z.object({
  workspace_dir: z.string().min(1),
  project_id: z.string().min(1),
  status: z.enum(["queued", "running", "completed", "canceled"]).optional(),
  limit: z.number().int().positive().max(5000).optional()
});

const HeartbeatStatusParams = z.object({
  workspace_dir: z.string().min(1)
});

const HeartbeatTickParams = z.object({
  workspace_dir: z.string().min(1),
  dry_run: z.boolean().optional(),
  reason: z.string().min(1).optional()
});

const HeartbeatConfigGetParams = z.object({
  workspace_dir: z.string().min(1)
});

const HeartbeatConfigSetParams = z
  .object({
    workspace_dir: z.string().min(1),
    enabled: z.boolean().optional(),
    tick_interval_minutes: z.number().int().min(1).max(24 * 60).optional(),
    top_k_workers: z.number().int().min(1).max(100).optional(),
    min_wake_score: z.number().int().min(0).max(100).optional(),
    ok_suppression_minutes: z.number().int().min(0).max(24 * 60).optional(),
    due_horizon_minutes: z.number().int().min(1).max(24 * 60).optional(),
    max_auto_actions_per_tick: z.number().int().min(1).max(10_000).optional(),
    max_auto_actions_per_hour: z.number().int().min(1).max(100_000).optional(),
    hierarchy_mode: z.enum(["standard", "enterprise_v1"]).optional(),
    executive_manager_agent_id: z.string().min(1).optional(),
    allow_director_to_spawn_workers: z.boolean().optional(),
    quiet_hours_start_hour: z.number().int().min(0).max(23).optional(),
    quiet_hours_end_hour: z.number().int().min(0).max(23).optional(),
    stuck_job_running_minutes: z.number().int().min(1).max(24 * 60).optional(),
    idempotency_ttl_days: z.number().int().min(1).max(365).optional(),
    jitter_max_seconds: z.number().int().min(0).max(3600).optional()
  })
  .strict();

const RunListParams = z.object({
  workspace_dir: z.string().min(1),
  project_id: z.string().min(1).optional()
});

const RunReplayParams = z.object({
  workspace_dir: z.string().min(1),
  project_id: z.string().min(1),
  run_id: z.string().min(1),
  tail: z.number().int().positive().optional(),
  mode: z.enum(["raw", "verified", "deterministic", "live"]).default("raw")
});

const SharePackReplayParams = z.object({
  workspace_dir: z.string().min(1),
  project_id: z.string().min(1),
  share_pack_id: z.string().min(1),
  run_id: z.string().min(1).optional(),
  tail: z.number().int().positive().optional(),
  mode: z.enum(["raw", "verified", "deterministic"]).default("raw")
});

const InboxListParams = z.object({
  workspace_dir: z.string().min(1),
  limit: z.number().int().positive().max(1000).default(200)
});

const InboxResolveParams = z.object({
  workspace_dir: z.string().min(1),
  project_id: z.string().min(1),
  artifact_id: z.string().min(1),
  decision: z.enum(["approved", "denied"]),
  actor_id: z.string().min(1),
  actor_role: z.enum(["human", "ceo", "director", "manager", "worker"]),
  actor_team_id: z.string().min(1).optional(),
  notes: z.string().optional()
});

const MemoryProposeParams = z.object({
  workspace_dir: z.string().min(1),
  project_id: z.string().min(1),
  title: z.string().min(1),
  scope_kind: z.enum(["project_memory", "agent_guidance"]),
  scope_ref: z.string().min(1).optional(),
  sensitivity: z.enum(["public", "internal", "restricted"]),
  rationale: z.string().min(1),
  under_heading: z.string().min(1),
  insert_lines: z.array(z.string().min(1)).min(1),
  visibility: z.enum(["private_agent", "team", "managers", "org"]),
  produced_by: z.string().min(1),
  run_id: z.string().min(1),
  context_pack_id: z.string().min(1),
  evidence: z.array(z.string().min(1)).min(1)
});

const ArtifactReadParams = z.object({
  workspace_dir: z.string().min(1),
  project_id: z.string().min(1),
  artifact_id: z.string().min(1),
  actor_id: z.string().min(1),
  actor_role: z.enum(["human", "ceo", "director", "manager", "worker"]),
  actor_team_id: z.string().min(1).optional(),
  run_id: z.string().min(1).optional()
});

const MemoryApproveParams = z.object({
  workspace_dir: z.string().min(1),
  project_id: z.string().min(1),
  artifact_id: z.string().min(1),
  actor_id: z.string().min(1),
  actor_role: z.enum(["human", "ceo", "director", "manager", "worker"]),
  actor_team_id: z.string().min(1).optional(),
  notes: z.string().optional()
});

const MemoryListParams = z.object({
  workspace_dir: z.string().min(1),
  actor_id: z.string().min(1),
  actor_role: z.enum(["human", "ceo", "director", "manager", "worker"]),
  actor_team_id: z.string().min(1).optional(),
  project_id: z.string().min(1).optional(),
  status: z.enum(["pending", "approved", "denied", "all"]).optional(),
  limit: z.number().int().positive().max(5000).optional()
});

const ContextPlanParams = z.object({
  workspace_dir: z.string().min(1),
  project_id: z.string().min(1),
  worker_agent_id: z.string().min(1).optional(),
  manager_actor_id: z.string().min(1),
  manager_role: z.enum(["human", "ceo", "director", "manager", "worker"]),
  manager_team_id: z.string().min(1).optional(),
  job_kind: z.enum(["execution", "heartbeat"]).optional(),
  goal: z.string().min(1),
  constraints: z.array(z.string().min(1)).optional(),
  deliverables: z.array(z.string().min(1)).optional(),
  context_refs: z
    .array(
      z
        .object({
          kind: z.enum(["file", "command", "artifact", "note"]),
          value: z.string().min(1),
          description: z.string().min(1).optional()
        })
        .strict()
    )
    .optional(),
  max_refs: z.number().int().positive().max(200).optional()
});

const MemoryExtractCandidatesParams = z.object({
  workspace_dir: z.string().min(1),
  project_id: z.string().min(1),
  job_id: z.string().min(1).optional(),
  run_id: z.string().min(1).optional(),
  actor_id: z.string().min(1),
  actor_role: z.enum(["human", "ceo", "director", "manager", "worker"]),
  actor_team_id: z.string().min(1).optional(),
  limit: z.number().int().positive().max(100).optional()
}).refine((p) => Boolean(p.job_id || p.run_id), {
  message: "job_id or run_id is required"
});

const MilestoneApproveParams = z.object({
  workspace_dir: z.string().min(1),
  project_id: z.string().min(1),
  task_id: z.string().min(1),
  milestone_id: z.string().min(1),
  report_artifact_id: z.string().min(1),
  actor_id: z.string().min(1),
  actor_role: z.enum(["human", "ceo", "director", "manager", "worker"]),
  actor_team_id: z.string().min(1).optional(),
  notes: z.string().optional()
});

const AgentRecordMistakeParams = z.object({
  workspace_dir: z.string().min(1),
  worker_agent_id: z.string().min(1),
  manager_actor_id: z.string().min(1),
  manager_role: z.enum(["human", "ceo", "director", "manager", "worker"]),
  mistake_key: z.string().min(1),
  summary: z.string().min(1),
  prevention_rule: z.string().min(1),
  project_id: z.string().min(1).optional(),
  run_id: z.string().min(1).optional(),
  task_id: z.string().min(1).optional(),
  milestone_id: z.string().min(1).optional(),
  evidence_artifact_ids: z.array(z.string().min(1)).optional(),
  promote_threshold: z.number().int().min(1).optional()
});

const AgentSelfImproveCycleParams = z.object({
  workspace_dir: z.string().min(1),
  project_id: z.string().min(1),
  worker_agent_id: z.string().min(1),
  manager_actor_id: z.string().min(1),
  manager_role: z.enum(["human", "ceo", "director", "manager", "worker"]),
  mistake_key: z.string().min(1),
  summary: z.string().min(1),
  prevention_rule: z.string().min(1),
  proposal_threshold: z.number().int().min(1).optional(),
  promote_threshold: z.number().int().min(1).optional(),
  evidence_artifact_ids: z.array(z.string().min(1)).optional(),
  task_id: z.string().min(1).optional(),
  milestone_id: z.string().min(1).optional(),
  evaluation_argv: z.array(z.string().min(1)).optional(),
  evaluation_repo_id: z.string().min(1).optional(),
  evaluation_workdir_rel: z.string().min(1).optional(),
  evaluation_env: z.record(z.string(), z.string()).optional()
});

const AgentRefreshContextParams = z.object({
  workspace_dir: z.string().min(1),
  agent_id: z.string().min(1),
  project_id: z.string().min(1).optional(),
  max_tasks: z.number().int().positive().max(200).optional(),
  max_scope_paths: z.number().int().positive().max(500).optional()
});

const AdapterStatusParams = z.object({
  workspace_dir: z.string().min(1)
});

const IndexRebuildParams = z.object({
  workspace_dir: z.string().min(1)
});

const EmptyParams = z.object({}).passthrough();

const SYSTEM_CAPABILITIES = {
  protocol_version: "v1",
  available_methods: [
    "adapter.status",
    "agent.profile.snapshot",
    "agent.record_mistake",
    "agent.refresh_context",
    "agent.self_improve_cycle",
    "artifact.read",
    "comment.add",
    "comment.list",
    "context.plan_for_job",
    "conversation.create_channel",
    "conversation.create_dm",
    "conversation.list",
    "conversation.members.sync",
    "conversation.message.send",
    "conversation.messages.list",
    "desktop.bootstrap.snapshot",
    "events.ack",
    "events.subscribe",
    "events.unsubscribe",
    "heartbeat.config.get",
    "heartbeat.config.set",
    "heartbeat.status",
    "heartbeat.tick",
    "inbox.list_help_requests",
    "inbox.list_reviews",
    "inbox.resolve",
    "inbox.snapshot",
    "index.list_event_parse_errors",
    "index.list_events",
    "index.list_help_requests",
    "index.list_reviews",
    "index.list_runs",
    "index.rebuild",
    "index.stats",
    "index.sync",
    "index.sync_worker_flush",
    "index.sync_worker_status",
    "job.cancel",
    "job.collect",
    "job.list",
    "job.poll",
    "job.submit",
    "memory.approve_delta",
    "memory.extract_candidates",
    "memory.list_deltas",
    "memory.propose_delta",
    "milestone.approve",
    "monitor.snapshot",
    "pipeline.client_intake.run",
    "pipeline.department.assign_tasks",
    "pm.apply_allocations",
    "pm.recommend_allocations",
    "pm.snapshot",
    "resources.snapshot",
    "run.create",
    "run.list",
    "run.replay",
    "session.collect",
    "session.launch",
    "session.list",
    "session.poll",
    "session.stop",
    "sharepack.replay",
    "system.capabilities",
    "task.list",
    "task.update_plan",
    "ui.resolve",
    "ui.snapshot",
    "usage.analytics",
    "usage.reconciliation.record",
    "usage.reconciliation.snapshot",
    "workspace.agents.list",
    "workspace.bootstrap.enterprise",
    "workspace.diagnostics",
    "workspace.doctor",
    "workspace.enterprise.ensure_defaults",
    "workspace.export",
    "workspace.home.snapshot",
    "workspace.import",
    "workspace.init",
    "workspace.migrate",
    "workspace.open",
    "workspace.project.create_with_defaults",
    "workspace.project.link_repo",
    "workspace.projects.list",
    "workspace.repo_root.set",
    "workspace.teams.list",
    "workspace.validate",
    "worktree.cleanup"
  ],
  context: {
    layers_version: 1,
    job_submit_auto_default: true
  },
  memory: {
    write_schema_version: 2,
    parse_supported: [1, 2],
    list_requires_actor: true,
    list_required_params: ["actor_id", "actor_role"],
    session_candidate_mode: "review_only",
    scope_kind: ["project_memory", "agent_guidance"],
    sensitivity: ["public", "internal", "restricted"]
  },
  retrieval: {
    storage: "sqlite_metadata"
  }
} as const;

const IndexListRunsParams = z.object({
  workspace_dir: z.string().min(1),
  project_id: z.string().min(1).optional(),
  status: z.enum(["running", "ended", "failed", "stopped"]).optional(),
  limit: z.number().int().positive().max(5000).optional()
});

const IndexListEventsParams = z.object({
  workspace_dir: z.string().min(1),
  project_id: z.string().min(1).optional(),
  run_id: z.string().min(1).optional(),
  type: z.string().min(1).optional(),
  since_seq: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(5000).optional(),
  order: z.enum(["asc", "desc"]).optional()
});

const IndexListEventParseErrorsParams = z.object({
  workspace_dir: z.string().min(1),
  project_id: z.string().min(1).optional(),
  run_id: z.string().min(1).optional(),
  limit: z.number().int().positive().max(5000).optional()
});

const IndexListReviewsParams = z.object({
  workspace_dir: z.string().min(1),
  project_id: z.string().min(1).optional(),
  decision: z.enum(["approved", "denied"]).optional(),
  limit: z.number().int().positive().max(5000).optional()
});

const IndexListHelpRequestsParams = z.object({
  workspace_dir: z.string().min(1),
  target_manager: z.string().min(1).optional(),
  project_id: z.string().min(1).optional(),
  limit: z.number().int().positive().max(5000).optional()
});

const MonitorSnapshotParams = z.object({
  workspace_dir: z.string().min(1),
  project_id: z.string().min(1).optional(),
  limit: z.number().int().positive().max(5000).optional(),
  refresh_index: z.boolean().optional(),
  sync_index: z.boolean().optional()
});

const InboxSnapshotParams = z.object({
  workspace_dir: z.string().min(1),
  project_id: z.string().min(1).optional(),
  pending_limit: z.number().int().positive().max(5000).optional(),
  decisions_limit: z.number().int().positive().max(5000).optional(),
  refresh_index: z.boolean().optional(),
  sync_index: z.boolean().optional()
});

const UiSnapshotParams = z.object({
  workspace_dir: z.string().min(1),
  project_id: z.string().min(1).optional(),
  monitor_limit: z.number().int().positive().max(5000).optional(),
  pending_limit: z.number().int().positive().max(5000).optional(),
  decisions_limit: z.number().int().positive().max(5000).optional(),
  refresh_index: z.boolean().optional(),
  sync_index: z.boolean().optional()
});

const UsageAnalyticsParams = z.object({
  workspace_dir: z.string().min(1),
  project_id: z.string().min(1).optional(),
  limit: z.number().int().positive().max(5000).optional(),
  refresh_index: z.boolean().optional(),
  sync_index: z.boolean().optional()
});

const UsageReconciliationRecordParams = z
  .object({
    workspace_dir: z.string().min(1),
    statement_id: z.string().min(1).optional(),
    provider: z.string().min(1),
    period_start: z.string().min(1),
    period_end: z.string().min(1),
    billed_cost_usd: z.number().finite().nonnegative(),
    billed_tokens: z.number().int().nonnegative().optional(),
    currency: z.literal("USD").optional(),
    source: z.enum(["manual", "api"]).optional(),
    external_ref: z.string().min(1).optional(),
    notes: z.string().min(1).optional()
  })
  .strict();

const UsageReconciliationSnapshotParams = z
  .object({
    workspace_dir: z.string().min(1),
    project_id: z.string().min(1).optional(),
    period_start: z.string().min(1).optional(),
    period_end: z.string().min(1).optional()
  })
  .strict();

const WorkspaceProjectsListParams = z.object({
  workspace_dir: z.string().min(1)
});

const WorkspaceAgentsListParams = z.object({
  workspace_dir: z.string().min(1),
  role: z.enum(["ceo", "director", "manager", "worker"]).optional(),
  team_id: z.string().min(1).optional()
});

const WorkspaceTeamsListParams = z.object({
  workspace_dir: z.string().min(1)
});

const WorkspaceProjectCreateWithDefaultsParams = z.object({
  workspace_dir: z.string().min(1),
  name: z.string().min(1),
  ceo_actor_id: z.string().min(1).optional(),
  executive_manager_agent_id: z.string().min(1).optional(),
  repo_ids: z.array(z.string().min(1)).optional()
});

const WorkspaceProjectLinkRepoParams = z.object({
  workspace_dir: z.string().min(1),
  project_id: z.string().min(1),
  repo_id: z.string().min(1),
  label: z.string().min(1).optional()
});

const WorkspaceRepoRootSetParams = z.object({
  workspace_dir: z.string().min(1),
  repo_id: z.string().min(1),
  repo_path: z.string().min(1),
  require_git: z.boolean().default(true)
});

const WorkspaceHomeSnapshotParams = z.object({
  workspace_dir: z.string().min(1)
});

const DesktopBootstrapSnapshotParams = z.object({
  workspace_dir: z.string().min(1),
  actor_id: z.string().min(1),
  scope: z.enum(["workspace", "project"]),
  project_id: z.string().min(1).optional(),
  view: z.enum(["home", "activities", "resources", "conversation"]),
  conversation_id: z.string().min(1).optional()
});

const TaskScheduleParams = z
  .object({
    planned_start: z.string().min(1).optional(),
    planned_end: z.string().min(1).optional(),
    duration_days: z.number().int().positive().optional(),
    depends_on_task_ids: z.array(z.string().min(1)).optional()
  })
  .strict();

const TaskExecutionPlanParams = z
  .object({
    preferred_provider: z.string().min(1).optional(),
    preferred_model: z.string().min(1).optional(),
    preferred_agent_id: z.string().min(1).optional(),
    token_budget_hint: z.number().int().nonnegative().optional(),
    applied_by: z.string().min(1).optional(),
    applied_at: z.string().min(1).optional()
  })
  .strict();

const TaskListParams = z.object({
  workspace_dir: z.string().min(1),
  project_id: z.string().min(1)
});

const TaskUpdatePlanParams = z.object({
  workspace_dir: z.string().min(1),
  project_id: z.string().min(1),
  task_id: z.string().min(1),
  schedule: TaskScheduleParams.optional(),
  execution_plan: TaskExecutionPlanParams.optional(),
  clear_schedule: z.boolean().optional(),
  clear_execution_plan: z.boolean().optional()
});

const PmSnapshotParams = z.object({
  workspace_dir: z.string().min(1),
  scope: z.enum(["workspace", "project"]),
  project_id: z.string().min(1).optional()
});

const PmRecommendAllocationsParams = z.object({
  workspace_dir: z.string().min(1),
  project_id: z.string().min(1)
});

const PmApplyAllocationsParams = z.object({
  workspace_dir: z.string().min(1),
  project_id: z.string().min(1),
  applied_by: z.string().min(1),
  items: z
    .array(
      z.object({
        task_id: z.string().min(1),
        preferred_provider: z.string().min(1).optional(),
        preferred_model: z.string().min(1).optional(),
        preferred_agent_id: z.string().min(1).optional(),
        token_budget_hint: z.number().int().nonnegative().optional()
      })
    )
    .default([])
});

const ConversationListParams = z.object({
  workspace_dir: z.string().min(1),
  scope: z.enum(["workspace", "project"]),
  project_id: z.string().min(1).optional()
});

const ConversationCreateChannelParams = z.object({
  workspace_dir: z.string().min(1),
  scope: z.enum(["workspace", "project"]),
  project_id: z.string().min(1).optional(),
  name: z.string().min(1),
  slug: z.string().min(1),
  visibility: z.enum(["private_agent", "team", "managers", "org"]).optional(),
  created_by: z.string().min(1),
  participant_agent_ids: z.array(z.string().min(1)).optional(),
  participant_team_ids: z.array(z.string().min(1)).optional()
});

const ConversationCreateDmParams = z.object({
  workspace_dir: z.string().min(1),
  scope: z.enum(["workspace", "project"]),
  project_id: z.string().min(1).optional(),
  created_by: z.string().min(1),
  peer_agent_id: z.string().min(1),
  visibility: z.enum(["private_agent", "team", "managers", "org"]).optional()
});

const ConversationMessagesListParams = z.object({
  workspace_dir: z.string().min(1),
  scope: z.enum(["workspace", "project"]),
  project_id: z.string().min(1).optional(),
  conversation_id: z.string().min(1),
  limit: z.number().int().positive().max(5000).optional()
});

const ConversationMessageSendParams = z.object({
  workspace_dir: z.string().min(1),
  scope: z.enum(["workspace", "project"]),
  project_id: z.string().min(1).optional(),
  conversation_id: z.string().min(1),
  author_id: z.string().min(1),
  author_role: z.enum(["human", "ceo", "director", "manager", "worker"]),
  body: z.string().min(1),
  kind: z.enum(["text", "system", "report"]).optional(),
  visibility: z.enum(["private_agent", "team", "managers", "org"]).optional(),
  mentions: z.array(z.string().min(1)).optional()
});

const ConversationMembersSyncParams = z.object({
  workspace_dir: z.string().min(1),
  project_id: z.string().min(1),
  ceo_actor_id: z.string().min(1).optional(),
  executive_manager_agent_id: z.string().min(1).optional()
});

const AgentProfileSnapshotParams = z.object({
  workspace_dir: z.string().min(1),
  agent_id: z.string().min(1),
  project_id: z.string().min(1).optional()
});

const ResourcesSnapshotParams = z.object({
  workspace_dir: z.string().min(1),
  project_id: z.string().min(1).optional()
});

const PipelineClientIntakeRunParams = z
  .object({
    workspace_dir: z.string().min(1),
    project_name: z.string().min(1),
    ceo_actor_id: z.string().min(1),
    executive_manager_agent_id: z.string().min(1),
    intake_text: z.string().optional(),
    intake_file: z.string().optional(),
    model: z.string().min(1).optional()
  })
  .strict();

const PipelineDepartmentAssignTasksParams = z
  .object({
    workspace_dir: z.string().min(1),
    project_id: z.string().min(1),
    department_key: z.string().min(1),
    director_agent_id: z.string().min(1),
    worker_agent_ids: z.array(z.string().min(1)).min(1),
    approved_executive_plan_artifact_id: z.string().min(1)
  })
  .strict();

const UiResolveParams = z.object({
  workspace_dir: z.string().min(1),
  project_id: z.string().min(1),
  artifact_id: z.string().min(1),
  decision: z.enum(["approved", "denied"]),
  actor_id: z.string().min(1),
  actor_role: z.enum(["human", "ceo", "director", "manager", "worker"]),
  actor_team_id: z.string().min(1).optional(),
  notes: z.string().optional(),
  monitor_limit: z.number().int().positive().max(5000).optional(),
  pending_limit: z.number().int().positive().max(5000).optional(),
  decisions_limit: z.number().int().positive().max(5000).optional(),
  refresh_index: z.boolean().optional(),
  sync_index: z.boolean().optional()
});

const CommentAddParams = z.object({
  workspace_dir: z.string().min(1),
  project_id: z.string().min(1),
  author_id: z.string().min(1),
  author_role: z.enum(["human", "ceo", "director", "manager", "worker"]),
  body: z.string().min(1),
  target_agent_id: z.string().min(1).optional(),
  target_artifact_id: z.string().min(1).optional(),
  target_run_id: z.string().min(1).optional(),
  visibility: z.enum(["private_agent", "team", "managers", "org"]).optional()
});

const CommentListParams = z.object({
  workspace_dir: z.string().min(1),
  project_id: z.string().min(1),
  target_agent_id: z.string().min(1).optional(),
  target_artifact_id: z.string().min(1).optional(),
  target_run_id: z.string().min(1).optional(),
  limit: z.number().int().positive().max(5000).optional()
});

async function listReviews(workspaceDir: string, limit: number): Promise<unknown[]> {
  const dir = path.join(workspaceDir, "inbox/reviews");
  let entries: string[] = [];
  try {
    entries = (await fs.readdir(dir))
      .filter((f) => f.endsWith(".yaml"))
      .sort()
      .reverse()
      .slice(0, limit);
  } catch {
    return [];
  }

  const out: unknown[] = [];
  for (const f of entries) {
    try {
      const parsed = ReviewYaml.parse(await readYamlFile(path.join(dir, f)));
      out.push(parsed);
    } catch {
      // best-effort
    }
  }
  return out;
}

async function listHelpRequests(workspaceDir: string, limit: number): Promise<unknown[]> {
  const dir = path.join(workspaceDir, "inbox/help_requests");
  let entries: string[] = [];
  try {
    entries = (await fs.readdir(dir))
      .filter((f) => f.endsWith(".md"))
      .sort()
      .reverse()
      .slice(0, limit);
  } catch {
    return [];
  }

  const out: unknown[] = [];
  for (const f of entries) {
    const abs = path.join(dir, f);
    try {
      const md = await fs.readFile(abs, { encoding: "utf8" });
      const valid = validateHelpRequestMarkdown(md);
      if (!valid.ok) continue;
      const fm = parseFrontMatter(md);
      if (!fm.ok) continue;
      out.push(fm.frontmatter);
    } catch {
      // best-effort
    }
  }
  return out;
}

export async function routeRpcMethod(method: string, params: unknown): Promise<unknown> {
  switch (method) {
    case "system.capabilities": {
      EmptyParams.parse((params ?? {}) as unknown);
      return SYSTEM_CAPABILITIES;
    }
    case "workspace.open": {
      const p = WorkspaceOpenParams.parse(params);
      const res = await validateWorkspace(p.workspace_dir);
      return {
        workspace_dir: p.workspace_dir,
        valid: res.ok,
        issues: res.ok ? [] : res.issues
      };
    }
    case "workspace.init": {
      const p = WorkspaceInitParams.parse(params);
      await initWorkspace({
        root_dir: p.workspace_dir,
        company_name: p.company_name,
        force: p.force
      });
      return { ok: true };
    }
    case "workspace.bootstrap.enterprise": {
      const p = WorkspaceBootstrapEnterpriseParams.parse(params);
      return bootstrapWorkspacePresets({
        workspace_dir: p.workspace_dir,
        company_name: p.company_name,
        project_name: p.project_name,
        org_mode: p.org_mode,
        executive_manager_name: p.executive_manager_name,
        departments: p.departments,
        workers_per_dept: p.workers_per_dept,
        include_ceo: p.include_ceo,
        include_director: p.include_director,
        force: p.force
      });
    }
    case "workspace.enterprise.ensure_defaults": {
      const p = WorkspaceEnterpriseEnsureDefaultsParams.parse(params);
      return ensureEnterpriseDefaults({
        workspace_dir: p.workspace_dir,
        company_name: p.company_name,
        project_name: p.project_name,
        executive_manager_name: p.executive_manager_name,
        departments: p.departments,
        workers_per_dept: p.workers_per_dept
      });
    }
    case "workspace.validate": {
      const p = WorkspaceValidateParams.parse(params);
      return validateWorkspace(p.workspace_dir);
    }
    case "workspace.doctor": {
      const p = WorkspaceDoctorParams.parse(params);
      return doctorWorkspace({
        workspace_dir: p.workspace_dir,
        rebuild_index: p.rebuild_index,
        sync_index: p.sync_index
      });
    }
    case "workspace.diagnostics": {
      const p = WorkspaceDiagnosticsParams.parse(params);
      return createWorkspaceDiagnosticsBundle({
        workspace_dir: p.workspace_dir,
        out_dir: p.out_dir,
        rebuild_index: p.rebuild_index,
        sync_index: p.sync_index,
        monitor_limit: p.monitor_limit,
        pending_limit: p.pending_limit,
        decisions_limit: p.decisions_limit
      });
    }
    case "workspace.migrate": {
      const p = WorkspaceMigrateParams.parse(params);
      return migrateWorkspace({
        workspace_dir: p.workspace_dir,
        dry_run: p.dry_run,
        force: p.force
      });
    }
    case "workspace.export": {
      const p = WorkspaceExportParams.parse(params);
      return exportWorkspace({
        workspace_dir: p.workspace_dir,
        out_dir: p.out_dir,
        include_local: p.include_local,
        force: p.force
      });
    }
    case "workspace.import": {
      const p = WorkspaceImportParams.parse(params);
      return importWorkspace({
        src_dir: p.src_dir,
        workspace_dir: p.workspace_dir,
        include_local: p.include_local,
        force: p.force
      });
    }
    case "workspace.projects.list": {
      const p = WorkspaceProjectsListParams.parse(params);
      await ensureWorkspaceDefaults({ workspace_dir: p.workspace_dir });
      const [projects, home, pm] = await Promise.all([
        listProjects({ workspace_dir: p.workspace_dir }),
        buildWorkspaceHomeSnapshot({ workspace_dir: p.workspace_dir }),
        buildPmSnapshot({
          workspace_dir: p.workspace_dir,
          scope: "workspace"
        })
      ]);
      const pendingByProject = new Map(home.projects.map((row) => [row.project_id, row.pending_reviews]));
      const activeByProject = new Map(home.projects.map((row) => [row.project_id, row.active_runs]));
      const pmByProject = new Map(pm.workspace.projects.map((row) => [row.project_id, row]));
      return {
        workspace_dir: p.workspace_dir,
        projects: await Promise.all(
          projects.map(async (proj) => {
            const links = await readProjectRepoLinks({
              workspace_dir: p.workspace_dir,
              project_id: proj.project_id
            });
            const projectPm = pmByProject.get(proj.project_id);
            return {
              ...proj,
              repo_links: links.repos,
              pending_reviews: pendingByProject.get(proj.project_id) ?? 0,
              active_runs: activeByProject.get(proj.project_id) ?? 0,
              task_count: projectPm?.task_count ?? 0,
              progress_pct: projectPm?.progress_pct ?? 0,
              blocked_tasks: projectPm?.blocked_tasks ?? 0,
              risk_flags: projectPm?.risk_flags ?? []
            };
          })
        )
      };
    }
    case "workspace.agents.list": {
      const p = WorkspaceAgentsListParams.parse(params);
      return listOrgAgents({
        workspace_dir: p.workspace_dir,
        role: p.role,
        team_id: p.team_id
      });
    }
    case "workspace.teams.list": {
      const p = WorkspaceTeamsListParams.parse(params);
      return listOrgTeams({
        workspace_dir: p.workspace_dir
      });
    }
    case "workspace.project.create_with_defaults": {
      const p = WorkspaceProjectCreateWithDefaultsParams.parse(params);
      return createProjectWithDefaults({
        workspace_dir: p.workspace_dir,
        name: p.name,
        ceo_actor_id: p.ceo_actor_id,
        executive_manager_agent_id: p.executive_manager_agent_id,
        repo_ids: p.repo_ids
      });
    }
    case "workspace.project.link_repo": {
      const p = WorkspaceProjectLinkRepoParams.parse(params);
      const links = await linkProjectRepo({
        workspace_dir: p.workspace_dir,
        project_id: p.project_id,
        repo_id: p.repo_id,
        label: p.label
      });
      return {
        workspace_dir: p.workspace_dir,
        project_id: p.project_id,
        repos: links.repos
      };
    }
    case "workspace.repo_root.set": {
      const p = WorkspaceRepoRootSetParams.parse(params);
      const repoPath = path.resolve(p.repo_path);
      let st: Awaited<ReturnType<typeof fs.stat>>;
      try {
        st = await fs.stat(repoPath);
      } catch {
        throw new RpcUserError(`repo_path does not exist: ${repoPath}`);
      }
      if (!st.isDirectory()) {
        throw new RpcUserError(`repo_path must be a directory: ${repoPath}`);
      }
      if (p.require_git) {
        const gitMarker = path.join(repoPath, ".git");
        try {
          await fs.access(gitMarker);
        } catch {
          throw new RpcUserError(`Path does not look like a git repository (missing .git): ${repoPath}`);
        }
      }
      await setRepoRoot(p.workspace_dir, p.repo_id, repoPath);
      return {
        workspace_dir: p.workspace_dir,
        repo_id: p.repo_id,
        repo_path: repoPath
      };
    }
    case "workspace.home.snapshot": {
      const p = WorkspaceHomeSnapshotParams.parse(params);
      const [home, pm] = await Promise.all([
        buildWorkspaceHomeSnapshot({
          workspace_dir: p.workspace_dir
        }),
        buildPmSnapshot({
          workspace_dir: p.workspace_dir,
          scope: "workspace"
        })
      ]);
      return {
        ...home,
        pm: pm.workspace
      };
    }
    case "desktop.bootstrap.snapshot": {
      const p = DesktopBootstrapSnapshotParams.parse(params);
      if (p.scope === "project" && !p.project_id) {
        throw new RpcUserError("project_id is required when scope=project");
      }
      if (p.view === "conversation" && !p.conversation_id) {
        throw new RpcUserError("conversation_id is required when view=conversation");
      }
      if (p.scope === "workspace") {
        await ensureEnterpriseDefaults({
          workspace_dir: p.workspace_dir
        });
      }

      if (p.scope === "project" && p.project_id) {
        await ensureProjectDefaults({
          workspace_dir: p.workspace_dir,
          project_id: p.project_id,
          ceo_actor_id: p.actor_id
        });
      } else {
        await ensureWorkspaceDefaults({ workspace_dir: p.workspace_dir });
      }

      const [projectsPayload, agents, teams, conversations, workspaceHome, pm, resources] = await Promise.all([
        routeRpcMethod("workspace.projects.list", {
          workspace_dir: p.workspace_dir
        }),
        routeRpcMethod("workspace.agents.list", {
          workspace_dir: p.workspace_dir
        }),
        routeRpcMethod("workspace.teams.list", {
          workspace_dir: p.workspace_dir
        }),
        routeRpcMethod("conversation.list", {
          workspace_dir: p.workspace_dir,
          scope: p.scope,
          project_id: p.project_id
        }),
        buildWorkspaceHomeSnapshot({
          workspace_dir: p.workspace_dir
        }),
        buildPmSnapshot({
          workspace_dir: p.workspace_dir,
          scope: p.scope,
          project_id: p.project_id
        }),
        buildResourcesSnapshot({
          workspace_dir: p.workspace_dir,
          project_id: p.scope === "project" ? p.project_id : undefined
        })
      ]);

      let viewData: unknown;
      let activitySummary = {
        pending_reviews: 0,
        recent_decisions: 0,
        monitor_rows: 0
      };

      if (p.view === "home") {
        let recommendations: unknown[] = [];
        let forecast: unknown;
        if (p.scope === "project" && p.project_id) {
          const rec = await recommendTaskAllocations({
            workspace_dir: p.workspace_dir,
            project_id: p.project_id
          });
          recommendations = Array.isArray(rec.recommendations)
            ? rec.recommendations.map((row) => ({
                ...row,
                reason: row.rationale
              }))
            : [];
          forecast = rec.forecast;
        }
        viewData = {
          workspace_home: workspaceHome,
          pm,
          resources,
          recommendations,
          forecast
        };
      } else if (p.view === "activities") {
        const ui = await buildUiSnapshot({
          workspace_dir: p.workspace_dir,
          project_id: p.scope === "project" ? p.project_id : undefined,
          sync_index: true
        });
        viewData = { ui };
        activitySummary = {
          pending_reviews: ui.review_inbox.pending.length,
          recent_decisions: ui.review_inbox.recent_decisions.length,
          monitor_rows: ui.monitor.rows.length
        };
      } else if (p.view === "resources") {
        viewData = { resources };
      } else {
        const messages = await listConversationMessages({
          workspace_dir: p.workspace_dir,
          scope: p.scope,
          project_id: p.project_id,
          conversation_id: p.conversation_id!,
          limit: 3000
        });
        viewData = { messages };
      }

      return {
        workspace_dir: p.workspace_dir,
        actor_id: p.actor_id,
        scope: p.scope,
        project_id: p.project_id,
        view: p.view,
        conversation_id: p.conversation_id,
        projects: (projectsPayload as any).projects ?? [],
        agents,
        teams,
        conversations,
        view_data: viewData,
        resources_summary: resources.totals,
        activity_summary: activitySummary,
        pm_summary: pm.workspace.summary,
        sync_ts: new Date().toISOString()
      };
    }
    case "task.list": {
      const p = TaskListParams.parse(params);
      const tasks = await listProjectTasks({
        workspace_dir: p.workspace_dir,
        project_id: p.project_id
      });
      return {
        workspace_dir: p.workspace_dir,
        project_id: p.project_id,
        tasks
      };
    }
    case "task.update_plan": {
      const p = TaskUpdatePlanParams.parse(params);
      return updateTaskPlan({
        workspace_dir: p.workspace_dir,
        project_id: p.project_id,
        task_id: p.task_id,
        schedule: p.schedule
          ? {
              ...p.schedule,
              depends_on_task_ids: p.schedule.depends_on_task_ids ?? []
            }
          : undefined,
        execution_plan: p.execution_plan,
        clear_schedule: p.clear_schedule,
        clear_execution_plan: p.clear_execution_plan
      });
    }
    case "pm.snapshot": {
      const p = PmSnapshotParams.parse(params);
      if (p.scope === "project" && !p.project_id) {
        throw new RpcUserError("project_id is required when scope=project");
      }
      return buildPmSnapshot({
        workspace_dir: p.workspace_dir,
        scope: p.scope,
        project_id: p.project_id
      });
    }
    case "pm.recommend_allocations": {
      const p = PmRecommendAllocationsParams.parse(params);
      return recommendTaskAllocations({
        workspace_dir: p.workspace_dir,
        project_id: p.project_id
      });
    }
    case "pm.apply_allocations": {
      const p = PmApplyAllocationsParams.parse(params);
      return applyTaskAllocations({
        workspace_dir: p.workspace_dir,
        project_id: p.project_id,
        applied_by: p.applied_by,
        items: p.items
      });
    }
    case "conversation.list": {
      const p = ConversationListParams.parse(params);
      if (p.scope === "project" && !p.project_id) {
        throw new RpcUserError("project_id is required when scope=project");
      }
      if (p.scope === "project" && p.project_id) {
        await ensureProjectDefaults({
          workspace_dir: p.workspace_dir,
          project_id: p.project_id
        });
      } else if (p.scope === "workspace") {
        await ensureWorkspaceDefaults({ workspace_dir: p.workspace_dir });
      }
      return listConversations({
        workspace_dir: p.workspace_dir,
        scope: p.scope,
        project_id: p.project_id
      });
    }
    case "conversation.create_channel": {
      const p = ConversationCreateChannelParams.parse(params);
      if (p.scope === "project" && !p.project_id) {
        throw new RpcUserError("project_id is required when scope=project");
      }
      return createConversation({
        workspace_dir: p.workspace_dir,
        scope: p.scope,
        project_id: p.project_id,
        kind: "channel",
        name: p.name,
        slug: p.slug,
        visibility: p.visibility ?? "team",
        created_by: p.created_by,
        participants: {
          agent_ids: p.participant_agent_ids ?? [],
          team_ids: p.participant_team_ids ?? []
        }
      });
    }
    case "conversation.create_dm": {
      const p = ConversationCreateDmParams.parse(params);
      if (p.scope === "project" && !p.project_id) {
        throw new RpcUserError("project_id is required when scope=project");
      }
      const existing = (
        await listConversations({
          workspace_dir: p.workspace_dir,
          scope: p.scope,
          project_id: p.project_id
        })
      ).find(
        (c) =>
          c.kind === "dm" &&
          c.dm_peer_agent_id === p.peer_agent_id &&
          c.participants.agent_ids.includes(p.created_by)
      );
      if (existing) return existing;
      const slug = `dm-${p.peer_agent_id}`;
      return createConversation({
        workspace_dir: p.workspace_dir,
        scope: p.scope,
        project_id: p.project_id,
        kind: "dm",
        name: `DM: ${p.peer_agent_id}`,
        slug,
        visibility: p.visibility ?? "private_agent",
        created_by: p.created_by,
        participants: {
          agent_ids: [...new Set([p.created_by, p.peer_agent_id])]
        },
        dm_peer_agent_id: p.peer_agent_id
      });
    }
    case "conversation.messages.list": {
      const p = ConversationMessagesListParams.parse(params);
      if (p.scope === "project" && !p.project_id) {
        throw new RpcUserError("project_id is required when scope=project");
      }
      return listConversationMessages({
        workspace_dir: p.workspace_dir,
        scope: p.scope,
        project_id: p.project_id,
        conversation_id: p.conversation_id,
        limit: p.limit
      });
    }
    case "conversation.message.send": {
      const p = ConversationMessageSendParams.parse(params);
      if (p.scope === "project" && !p.project_id) {
        throw new RpcUserError("project_id is required when scope=project");
      }
      return sendConversationMessage({
        workspace_dir: p.workspace_dir,
        scope: p.scope,
        project_id: p.project_id,
        conversation_id: p.conversation_id,
        body: p.body,
        author_id: p.author_id,
        author_role: p.author_role,
        kind: p.kind,
        visibility: p.visibility,
        mentions: p.mentions
      });
    }
    case "conversation.members.sync": {
      const p = ConversationMembersSyncParams.parse(params);
      return ensureProjectDefaults({
        workspace_dir: p.workspace_dir,
        project_id: p.project_id,
        ceo_actor_id: p.ceo_actor_id,
        executive_manager_agent_id: p.executive_manager_agent_id
      });
    }
    case "agent.profile.snapshot": {
      const p = AgentProfileSnapshotParams.parse(params);
      return buildAgentProfileSnapshot({
        workspace_dir: p.workspace_dir,
        agent_id: p.agent_id,
        project_id: p.project_id
      });
    }
    case "resources.snapshot": {
      const p = ResourcesSnapshotParams.parse(params);
      return buildResourcesSnapshot({
        workspace_dir: p.workspace_dir,
        project_id: p.project_id
      });
    }
    case "pipeline.client_intake.run": {
      const p = PipelineClientIntakeRunParams.parse(params);
      return runClientIntakePipeline({
        workspace_dir: p.workspace_dir,
        project_name: p.project_name,
        ceo_actor_id: p.ceo_actor_id,
        executive_manager_agent_id: p.executive_manager_agent_id,
        intake_text: p.intake_text,
        intake_file: p.intake_file,
        model: p.model
      });
    }
    case "pipeline.department.assign_tasks": {
      const p = PipelineDepartmentAssignTasksParams.parse(params);
      return assignDepartmentTasks({
        workspace_dir: p.workspace_dir,
        project_id: p.project_id,
        department_key: p.department_key,
        director_agent_id: p.director_agent_id,
        worker_agent_ids: p.worker_agent_ids,
        approved_executive_plan_artifact_id: p.approved_executive_plan_artifact_id
      });
    }
    case "worktree.cleanup": {
      const p = WorktreeCleanupParams.parse(params);
      return cleanupWorktrees({
        workspace_dir: p.workspace_dir,
        project_id: p.project_id,
        max_age_hours: p.max_age_hours,
        dry_run: p.dry_run
      });
    }
    case "run.create": {
      const p = RunCreateParams.parse(params);
      return createRun({
        workspace_dir: p.workspace_dir,
        project_id: p.project_id,
        agent_id: p.agent_id,
        provider: p.provider
      });
    }
    case "session.launch": {
      const p = SessionLaunchParams.parse(params);
      return launchSession({
        workspace_dir: p.workspace_dir,
        project_id: p.project_id,
        run_id: p.run_id,
        argv: p.argv,
        repo_id: p.repo_id,
        workdir_rel: p.workdir_rel,
        task_id: p.task_id,
        milestone_id: p.milestone_id,
        prompt_text: p.prompt_text,
        model: p.model,
        budget: p.budget,
        stdin_text: p.stdin_text,
        env: p.env,
        session_ref: p.session_ref,
        lane_priority: p.lane_priority,
        lane_workspace_limit: p.lane_workspace_limit,
        lane_provider_limit: p.lane_provider_limit,
        lane_team_limit: p.lane_team_limit,
        actor_id: p.actor_id,
        actor_role: p.actor_role,
        actor_team_id: p.actor_team_id
      });
    }
    case "session.poll": {
      const p = SessionSingleParams.parse(params);
      return pollSession(p.session_ref, { workspace_dir: p.workspace_dir });
    }
    case "session.collect": {
      const p = SessionSingleParams.parse(params);
      return collectSession(p.session_ref, { workspace_dir: p.workspace_dir });
    }
    case "session.stop": {
      const p = SessionSingleParams.parse(params);
      return stopSession(p.session_ref, { workspace_dir: p.workspace_dir });
    }
    case "session.list": {
      const p = SessionListParams.parse(params ?? {});
      return await listSessions(p);
    }
    case "job.submit": {
      const p = JobSubmitParams.parse(params);
      return submitJob({ job: p.job });
    }
    case "job.poll": {
      const p = JobSingleParams.parse(params);
      return pollJob({
        workspace_dir: p.workspace_dir,
        project_id: p.project_id,
        job_id: p.job_id
      });
    }
    case "job.collect": {
      const p = JobSingleParams.parse(params);
      return collectJob({
        workspace_dir: p.workspace_dir,
        project_id: p.project_id,
        job_id: p.job_id
      });
    }
    case "job.cancel": {
      const p = JobSingleParams.parse(params);
      return cancelJob({
        workspace_dir: p.workspace_dir,
        project_id: p.project_id,
        job_id: p.job_id
      });
    }
    case "job.list": {
      const p = JobListParams.parse(params);
      return listJobs({
        workspace_dir: p.workspace_dir,
        project_id: p.project_id,
        status: p.status,
        limit: p.limit
      });
    }
    case "heartbeat.status": {
      const p = HeartbeatStatusParams.parse(params);
      const service = getDefaultHeartbeatService();
      await service.observeWorkspace(p.workspace_dir);
      return service.getStatus({
        workspace_dir: p.workspace_dir
      });
    }
    case "heartbeat.tick": {
      const p = HeartbeatTickParams.parse(params);
      const service = getDefaultHeartbeatService();
      await service.observeWorkspace(p.workspace_dir);
      return service.tickWorkspace({
        workspace_dir: p.workspace_dir,
        dry_run: p.dry_run,
        reason: p.reason ?? "rpc"
      });
    }
    case "heartbeat.config.get": {
      const p = HeartbeatConfigGetParams.parse(params);
      const service = getDefaultHeartbeatService();
      await service.observeWorkspace(p.workspace_dir);
      return service.getConfig({
        workspace_dir: p.workspace_dir
      });
    }
    case "heartbeat.config.set": {
      const p = HeartbeatConfigSetParams.parse(params);
      const service = getDefaultHeartbeatService();
      await service.observeWorkspace(p.workspace_dir);
      const { workspace_dir, ...patch } = p;
      return service.setConfig({
        workspace_dir,
        config: patch
      });
    }
    case "run.list": {
      const p = RunListParams.parse(params);
      return listRuns({ workspace_dir: p.workspace_dir, project_id: p.project_id });
    }
    case "run.replay": {
      const p = RunReplayParams.parse(params);
      return replayRun({
        workspace_dir: p.workspace_dir,
        project_id: p.project_id,
        run_id: p.run_id,
        tail: p.tail,
        mode: p.mode
      });
    }
    case "sharepack.replay": {
      const p = SharePackReplayParams.parse(params);
      return replaySharePack({
        workspace_dir: p.workspace_dir,
        project_id: p.project_id,
        share_pack_id: p.share_pack_id,
        run_id: p.run_id,
        tail: p.tail,
        mode: p.mode
      });
    }
    case "inbox.list_reviews": {
      const p = InboxListParams.parse(params);
      return listReviews(p.workspace_dir, p.limit);
    }
    case "inbox.list_help_requests": {
      const p = InboxListParams.parse(params);
      return listHelpRequests(p.workspace_dir, p.limit);
    }
    case "inbox.resolve": {
      const p = InboxResolveParams.parse(params);
      return resolveInboxItem(p);
    }
    case "memory.propose_delta": {
      const p = MemoryProposeParams.parse(params);
      return proposeMemoryDelta({
        workspace_dir: p.workspace_dir,
        project_id: p.project_id,
        title: p.title,
        scope_kind: p.scope_kind,
        scope_ref: p.scope_ref,
        sensitivity: p.sensitivity,
        rationale: p.rationale,
        under_heading: p.under_heading,
        insert_lines: p.insert_lines,
        visibility: p.visibility,
        produced_by: p.produced_by,
        run_id: p.run_id,
        context_pack_id: p.context_pack_id,
        evidence: p.evidence
      });
    }
    case "context.plan_for_job": {
      const p = ContextPlanParams.parse(params);
      return planContextForJob({
        workspace_dir: p.workspace_dir,
        project_id: p.project_id,
        worker_agent_id: p.worker_agent_id,
        manager_actor_id: p.manager_actor_id,
        manager_role: p.manager_role,
        manager_team_id: p.manager_team_id,
        job_kind: p.job_kind,
        goal: p.goal,
        constraints: p.constraints,
        deliverables: p.deliverables,
        context_refs: p.context_refs,
        max_refs: p.max_refs
      });
    }
    case "artifact.read": {
      const p = ArtifactReadParams.parse(params);
      return readArtifactWithPolicy({
        workspace_dir: p.workspace_dir,
        project_id: p.project_id,
        artifact_id: p.artifact_id,
        actor_id: p.actor_id,
        actor_role: p.actor_role,
        actor_team_id: p.actor_team_id,
        run_id: p.run_id
      });
    }
    case "memory.approve_delta": {
      const p = MemoryApproveParams.parse(params);
      return approveMemoryDelta({
        workspace_dir: p.workspace_dir,
        project_id: p.project_id,
        artifact_id: p.artifact_id,
        actor_id: p.actor_id,
        actor_role: p.actor_role,
        actor_team_id: p.actor_team_id,
        notes: p.notes
      });
    }
    case "memory.list_deltas": {
      const p = MemoryListParams.parse(params);
      return listMemoryDeltas({
        workspace_dir: p.workspace_dir,
        actor_id: p.actor_id,
        actor_role: p.actor_role,
        actor_team_id: p.actor_team_id,
        project_id: p.project_id,
        status: p.status,
        limit: p.limit
      });
    }
    case "memory.extract_candidates": {
      const p = MemoryExtractCandidatesParams.parse(params);
      return extractSessionCommitCandidates({
        workspace_dir: p.workspace_dir,
        project_id: p.project_id,
        job_id: p.job_id,
        run_id: p.run_id,
        actor_id: p.actor_id,
        actor_role: p.actor_role,
        actor_team_id: p.actor_team_id,
        limit: p.limit
      });
    }
    case "milestone.approve": {
      const p = MilestoneApproveParams.parse(params);
      return approveMilestone({
        workspace_dir: p.workspace_dir,
        project_id: p.project_id,
        task_id: p.task_id,
        milestone_id: p.milestone_id,
        report_artifact_id: p.report_artifact_id,
        actor_id: p.actor_id,
        actor_role: p.actor_role,
        actor_team_id: p.actor_team_id,
        notes: p.notes
      });
    }
    case "agent.record_mistake": {
      const p = AgentRecordMistakeParams.parse(params);
      return recordAgentMistake(p);
    }
    case "agent.self_improve_cycle": {
      const p = AgentSelfImproveCycleParams.parse(params);
      return runSelfImproveCycle(p);
    }
    case "agent.refresh_context": {
      const p = AgentRefreshContextParams.parse(params);
      return refreshAgentContextIndex({
        workspace_dir: p.workspace_dir,
        agent_id: p.agent_id,
        project_id: p.project_id,
        max_tasks: p.max_tasks,
        max_scope_paths: p.max_scope_paths
      });
    }
    case "adapter.status": {
      const p = AdapterStatusParams.parse(params);
      return listAdapterStatuses(p.workspace_dir);
    }
    case "index.rebuild": {
      const p = IndexRebuildParams.parse(params);
      return rebuildSqliteIndex(p.workspace_dir);
    }
    case "index.sync": {
      const p = IndexRebuildParams.parse(params);
      return syncSqliteIndex(p.workspace_dir);
    }
    case "index.stats": {
      const p = IndexRebuildParams.parse(params);
      return readIndexStats(p.workspace_dir);
    }
    case "index.sync_worker_status": {
      EmptyParams.parse((params ?? {}) as unknown);
      return readIndexSyncWorkerStatus();
    }
    case "index.sync_worker_flush": {
      EmptyParams.parse((params ?? {}) as unknown);
      return flushIndexSyncWorker();
    }
    case "index.list_runs": {
      const p = IndexListRunsParams.parse(params);
      return listIndexedRuns({
        workspace_dir: p.workspace_dir,
        project_id: p.project_id,
        status: p.status,
        limit: p.limit
      });
    }
    case "index.list_reviews": {
      const p = IndexListReviewsParams.parse(params);
      return listIndexedReviews({
        workspace_dir: p.workspace_dir,
        project_id: p.project_id,
        decision: p.decision,
        limit: p.limit
      });
    }
    case "index.list_events": {
      const p = IndexListEventsParams.parse(params);
      return listIndexedEvents({
        workspace_dir: p.workspace_dir,
        project_id: p.project_id,
        run_id: p.run_id,
        type: p.type,
        since_seq: p.since_seq,
        limit: p.limit,
        order: p.order
      });
    }
    case "index.list_event_parse_errors": {
      const p = IndexListEventParseErrorsParams.parse(params);
      return listIndexedEventParseErrors({
        workspace_dir: p.workspace_dir,
        project_id: p.project_id,
        run_id: p.run_id,
        limit: p.limit
      });
    }
    case "index.list_help_requests": {
      const p = IndexListHelpRequestsParams.parse(params);
      return listIndexedHelpRequests({
        workspace_dir: p.workspace_dir,
        target_manager: p.target_manager,
        project_id: p.project_id,
        limit: p.limit
      });
    }
    case "monitor.snapshot": {
      const p = MonitorSnapshotParams.parse(params);
      return buildRunMonitorSnapshot({
        workspace_dir: p.workspace_dir,
        project_id: p.project_id,
        limit: p.limit,
        refresh_index: p.refresh_index,
        sync_index: p.sync_index
      });
    }
    case "inbox.snapshot": {
      const p = InboxSnapshotParams.parse(params);
      return buildReviewInboxSnapshot({
        workspace_dir: p.workspace_dir,
        project_id: p.project_id,
        pending_limit: p.pending_limit,
        decisions_limit: p.decisions_limit,
        refresh_index: p.refresh_index,
        sync_index: p.sync_index
      });
    }
    case "usage.analytics": {
      const p = UsageAnalyticsParams.parse(params);
      return buildUsageAnalyticsSnapshot({
        workspace_dir: p.workspace_dir,
        project_id: p.project_id,
        limit: p.limit,
        refresh_index: p.refresh_index,
        sync_index: p.sync_index
      });
    }
    case "usage.reconciliation.record": {
      const p = UsageReconciliationRecordParams.parse(params);
      return recordUsageReconciliationStatement({
        workspace_dir: p.workspace_dir,
        statement_id: p.statement_id,
        provider: p.provider,
        period_start: p.period_start,
        period_end: p.period_end,
        billed_cost_usd: p.billed_cost_usd,
        billed_tokens: p.billed_tokens,
        currency: p.currency,
        source: p.source,
        external_ref: p.external_ref,
        notes: p.notes
      });
    }
    case "usage.reconciliation.snapshot": {
      const p = UsageReconciliationSnapshotParams.parse(params);
      return buildUsageReconciliationSnapshot({
        workspace_dir: p.workspace_dir,
        project_id: p.project_id,
        period_start: p.period_start,
        period_end: p.period_end
      });
    }
    case "ui.snapshot": {
      const p = UiSnapshotParams.parse(params);
      return buildUiSnapshot({
        workspace_dir: p.workspace_dir,
        project_id: p.project_id,
        monitor_limit: p.monitor_limit,
        pending_limit: p.pending_limit,
        decisions_limit: p.decisions_limit,
        refresh_index: p.refresh_index,
        sync_index: p.sync_index
      });
    }
    case "ui.resolve": {
      const p = UiResolveParams.parse(params);
      return resolveInboxAndBuildUiSnapshot({
        workspace_dir: p.workspace_dir,
        project_id: p.project_id,
        artifact_id: p.artifact_id,
        decision: p.decision,
        actor_id: p.actor_id,
        actor_role: p.actor_role,
        actor_team_id: p.actor_team_id,
        notes: p.notes,
        monitor_limit: p.monitor_limit,
        pending_limit: p.pending_limit,
        decisions_limit: p.decisions_limit,
        refresh_index: p.refresh_index,
        sync_index: p.sync_index
      });
    }
    case "comment.add": {
      const p = CommentAddParams.parse(params);
      return createComment({
        workspace_dir: p.workspace_dir,
        project_id: p.project_id,
        author_id: p.author_id,
        author_role: p.author_role,
        body: p.body,
        target_agent_id: p.target_agent_id,
        target_artifact_id: p.target_artifact_id,
        target_run_id: p.target_run_id,
        visibility: p.visibility
      });
    }
    case "comment.list": {
      const p = CommentListParams.parse(params);
      return listComments({
        workspace_dir: p.workspace_dir,
        project_id: p.project_id,
        target_agent_id: p.target_agent_id,
        target_artifact_id: p.target_artifact_id,
        target_run_id: p.target_run_id,
        limit: p.limit
      });
    }
    default:
      throw new RpcUserError(`Unknown method: ${method}`);
  }
}
