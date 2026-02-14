import { z } from "zod";
import { IsoDateTime, SchemaVersion, Visibility } from "./common.js";

export const HeartbeatRisk = z.enum(["low", "medium", "high"]);
export type HeartbeatRisk = z.infer<typeof HeartbeatRisk>;

const HeartbeatActionBase = z
  .object({
    idempotency_key: z.string().min(1),
    risk: HeartbeatRisk,
    needs_approval: z.boolean(),
    visibility: Visibility.optional(),
    summary: z.string().min(1).optional()
  })
  .strict();

export const HeartbeatActionLaunchJob = HeartbeatActionBase.extend({
  kind: z.literal("launch_job"),
  project_id: z.string().min(1),
  job_kind: z.enum(["execution", "heartbeat"]).optional(),
  target_role: z.enum(["director", "worker"]).optional(),
  worker_kind: z.enum(["codex", "claude", "gemini"]).default("codex"),
  worker_agent_id: z.string().min(1).optional(),
  goal: z.string().min(1),
  constraints: z.array(z.string().min(1)).default([]),
  deliverables: z.array(z.string().min(1)).default([]),
  permission_level: z.enum(["read-only", "patch", "run-commands"]).default("read-only"),
  context_note: z.string().min(1).optional(),
  task_id: z.string().min(1).optional(),
  milestone_id: z.string().min(1).optional()
}).strict();

export const HeartbeatActionAddComment = HeartbeatActionBase.extend({
  kind: z.literal("add_comment"),
  project_id: z.string().min(1),
  body: z.string().min(1),
  target_agent_id: z.string().min(1).optional(),
  target_artifact_id: z.string().min(1).optional(),
  target_run_id: z.string().min(1).optional()
})
  .strict()
  .superRefine((v, ctx) => {
    if (!v.target_agent_id && !v.target_artifact_id && !v.target_run_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "add_comment requires one target (agent/artifact/run)",
        path: ["target_run_id"]
      });
    }
  });

export const HeartbeatActionNoop = HeartbeatActionBase.extend({
  kind: z.literal("noop"),
  reason: z.string().min(1)
}).strict();

const HeartbeatActionForProposal = z.discriminatedUnion("kind", [
  HeartbeatActionLaunchJob,
  HeartbeatActionAddComment,
  HeartbeatActionNoop
]);

export const HeartbeatActionCreateApprovalItem = HeartbeatActionBase.extend({
  kind: z.literal("create_approval_item"),
  project_id: z.string().min(1),
  title: z.string().min(1),
  rationale: z.string().min(1).optional(),
  proposed_action: HeartbeatActionForProposal.optional()
}).strict();

export const HeartbeatAction = z.discriminatedUnion("kind", [
  HeartbeatActionLaunchJob,
  HeartbeatActionAddComment,
  HeartbeatActionCreateApprovalItem,
  HeartbeatActionNoop
]);
export type HeartbeatAction = z.infer<typeof HeartbeatAction>;

export const HeartbeatWorkerReportOk = z
  .object({
    schema_version: SchemaVersion.default(1),
    type: z.literal("heartbeat_worker_report").default("heartbeat_worker_report"),
    status: z.literal("ok"),
    token: z.literal("HEARTBEAT_OK"),
    summary: z.string().min(1),
    actions: z.array(HeartbeatAction).max(0).optional()
  })
  .strict();

export const HeartbeatWorkerReportActions = z
  .object({
    schema_version: SchemaVersion.default(1),
    type: z.literal("heartbeat_worker_report").default("heartbeat_worker_report"),
    status: z.literal("actions"),
    summary: z.string().min(1),
    actions: z.array(HeartbeatAction).min(1)
  })
  .strict();

export const HeartbeatWorkerReport = z.discriminatedUnion("status", [
  HeartbeatWorkerReportOk,
  HeartbeatWorkerReportActions
]);
export type HeartbeatWorkerReport = z.infer<typeof HeartbeatWorkerReport>;

export const HeartbeatConfig = z
  .object({
    schema_version: SchemaVersion.default(1),
    type: z.literal("heartbeat_config").default("heartbeat_config"),
    enabled: z.boolean().default(true),
    tick_interval_minutes: z.number().int().min(1).max(24 * 60).default(20),
    top_k_workers: z.number().int().min(1).max(100).default(2),
    min_wake_score: z.number().int().min(0).max(100).default(3),
    ok_suppression_minutes: z.number().int().min(0).max(24 * 60).default(60),
    due_horizon_minutes: z.number().int().min(1).max(24 * 60).default(120),
    max_auto_actions_per_tick: z.number().int().min(1).max(10_000).default(10),
    max_auto_actions_per_hour: z.number().int().min(1).max(100_000).default(60),
    hierarchy_mode: z.enum(["standard", "enterprise_v1"]).default("standard"),
    executive_manager_agent_id: z.string().min(1).optional(),
    allow_director_to_spawn_workers: z.boolean().default(false),
    quiet_hours_start_hour: z.number().int().min(0).max(23).default(22),
    quiet_hours_end_hour: z.number().int().min(0).max(23).default(7),
    stuck_job_running_minutes: z.number().int().min(1).max(24 * 60).default(30),
    idempotency_ttl_days: z.number().int().min(1).max(365).default(14),
    jitter_max_seconds: z.number().int().min(0).max(3600).default(90)
  })
  .strict();
export type HeartbeatConfig = z.infer<typeof HeartbeatConfig>;

export const HeartbeatWorkerState = z
  .object({
    last_ok_at: IsoDateTime.optional(),
    last_context_hash: z.string().min(1).optional(),
    suppressed_until: IsoDateTime.optional(),
    last_wake_at: IsoDateTime.optional(),
    last_report_status: z.enum(["ok", "actions"]).optional()
  })
  .strict();
export type HeartbeatWorkerState = z.infer<typeof HeartbeatWorkerState>;

export const HeartbeatIdempotencyEntry = z
  .object({
    idempotency_key: z.string().min(1),
    action_kind: z.string().min(1),
    first_seen_at: IsoDateTime,
    last_seen_at: IsoDateTime,
    expires_at: IsoDateTime,
    status: z.enum(["queued", "executed"]),
    execution_count: z.number().int().min(0).default(0)
  })
  .strict();
export type HeartbeatIdempotencyEntry = z.infer<typeof HeartbeatIdempotencyEntry>;

export const HeartbeatState = z
  .object({
    schema_version: SchemaVersion.default(1),
    type: z.literal("heartbeat_state").default("heartbeat_state"),
    running: z.boolean().default(false),
    last_tick_id: z.string().min(1).optional(),
    last_tick_at: IsoDateTime.optional(),
    last_tick_reason: z.string().min(1).optional(),
    next_tick_at: IsoDateTime.optional(),
    run_event_cursors: z.record(z.string(), z.number().int().nonnegative()).default({}),
    worker_state: z.record(z.string(), HeartbeatWorkerState).default({}),
    idempotency: z.record(z.string(), HeartbeatIdempotencyEntry).default({}),
    hourly_action_counters: z.record(z.string(), z.number().int().nonnegative()).default({}),
    stats: z
      .object({
        ticks_total: z.number().int().nonnegative().default(0),
        workers_woken_total: z.number().int().nonnegative().default(0),
        reports_ok_total: z.number().int().nonnegative().default(0),
        reports_actions_total: z.number().int().nonnegative().default(0),
        actions_executed_total: z.number().int().nonnegative().default(0),
        approvals_queued_total: z.number().int().nonnegative().default(0),
        deduped_actions_total: z.number().int().nonnegative().default(0)
      })
      .default({
        ticks_total: 0,
        workers_woken_total: 0,
        reports_ok_total: 0,
        reports_actions_total: 0,
        actions_executed_total: 0,
        approvals_queued_total: 0,
        deduped_actions_total: 0
      })
  })
  .strict();
export type HeartbeatState = z.infer<typeof HeartbeatState>;

export const DEFAULT_HEARTBEAT_CONFIG: HeartbeatConfig = HeartbeatConfig.parse({
  schema_version: 1,
  type: "heartbeat_config"
});

export const DEFAULT_HEARTBEAT_STATE: HeartbeatState = HeartbeatState.parse({
  schema_version: 1,
  type: "heartbeat_state"
});
