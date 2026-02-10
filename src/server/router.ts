import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { initWorkspace } from "../workspace/init.js";
import { validateWorkspace } from "../workspace/validate.js";
import { doctorWorkspace } from "../workspace/doctor.js";
import { createRun } from "../runtime/run.js";
import {
  launchSession,
  pollSession,
  collectSession,
  stopSession,
  listSessions
} from "../runtime/session.js";
import { buildRunMonitorSnapshot } from "../runtime/run_monitor.js";
import { buildReviewInboxSnapshot } from "../runtime/review_inbox.js";
import { buildUiSnapshot } from "../runtime/ui_bundle.js";
import { readIndexSyncWorkerStatus, flushIndexSyncWorker } from "../runtime/index_sync_service.js";
import { resolveInboxItem } from "../inbox/resolve.js";
import { listRuns, readEventsJsonl } from "../runtime/run_queries.js";
import { proposeMemoryDelta } from "../memory/propose_memory_delta.js";
import { approveMemoryDelta } from "../memory/approve_memory_delta.js";
import { approveMilestone } from "../milestones/approve_milestone.js";
import { recordAgentMistake } from "../eval/mistake_loop.js";
import { refreshAgentContextIndex } from "../eval/agent_context_index.js";
import { readYamlFile } from "../store/yaml.js";
import { ReviewYaml } from "../schemas/review.js";
import { validateHelpRequestMarkdown } from "../help/help_request.js";
import { parseFrontMatter } from "../artifacts/frontmatter.js";
import { readArtifactWithPolicy } from "../artifacts/read_artifact.js";
import { listAdapterStatuses } from "../adapters/registry.js";
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

const WorkspaceDoctorParams = z.object({
  workspace_dir: z.string().min(1),
  rebuild_index: z.boolean().default(false),
  sync_index: z.boolean().default(false)
});

const RunCreateParams = z.object({
  workspace_dir: z.string().min(1),
  project_id: z.string().min(1),
  agent_id: z.string().min(1),
  provider: z.string().min(1)
});

const SessionLaunchParams = z.object({
  workspace_dir: z.string().min(1),
  project_id: z.string().min(1),
  run_id: z.string().min(1),
  argv: z.array(z.string().min(1)).min(1),
  repo_id: z.string().min(1).optional(),
  workdir_rel: z.string().min(1).optional(),
  task_id: z.string().min(1).optional(),
  milestone_id: z.string().min(1).optional(),
  stdin_text: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  session_ref: z.string().min(1).optional()
});

const SessionSingleParams = z.object({
  session_ref: z.string().min(1)
});

const SessionListParams = z.object({
  workspace_dir: z.string().min(1).optional(),
  project_id: z.string().min(1).optional(),
  run_id: z.string().min(1).optional(),
  status: z.enum(["running", "ended", "failed", "stopped"]).optional()
});

const RunListParams = z.object({
  workspace_dir: z.string().min(1),
  project_id: z.string().min(1).optional()
});

const RunReplayParams = z.object({
  workspace_dir: z.string().min(1),
  project_id: z.string().min(1),
  run_id: z.string().min(1),
  tail: z.number().int().positive().optional()
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
  target_file: z.string().min(1).optional(),
  under_heading: z.string().min(1),
  insert_lines: z.array(z.string().min(1)).min(1),
  visibility: z.enum(["private_agent", "team", "managers", "org"]),
  produced_by: z.string().min(1),
  run_id: z.string().min(1),
  context_pack_id: z.string().min(1),
  evidence: z.array(z.string().min(1)).optional()
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
        stdin_text: p.stdin_text,
        env: p.env,
        session_ref: p.session_ref
      });
    }
    case "session.poll": {
      const p = SessionSingleParams.parse(params);
      return pollSession(p.session_ref);
    }
    case "session.collect": {
      const p = SessionSingleParams.parse(params);
      return collectSession(p.session_ref);
    }
    case "session.stop": {
      const p = SessionSingleParams.parse(params);
      return stopSession(p.session_ref);
    }
    case "session.list": {
      const p = SessionListParams.parse(params ?? {});
      return listSessions(p);
    }
    case "run.list": {
      const p = RunListParams.parse(params);
      return listRuns({ workspace_dir: p.workspace_dir, project_id: p.project_id });
    }
    case "run.replay": {
      const p = RunReplayParams.parse(params);
      const eventsPath = path.join(
        p.workspace_dir,
        "work/projects",
        p.project_id,
        "runs",
        p.run_id,
        "events.jsonl"
      );
      const lines = await readEventsJsonl(eventsPath);
      const parsed = lines
        .filter((l): l is { ok: true; event: any } => l.ok)
        .map((l) => l.event);
      return {
        run_id: p.run_id,
        project_id: p.project_id,
        events: p.tail ? parsed.slice(-p.tail) : parsed,
        parse_issues: lines.filter((l) => !l.ok)
      };
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
        target_file: p.target_file,
        under_heading: p.under_heading,
        insert_lines: p.insert_lines,
        visibility: p.visibility,
        produced_by: p.produced_by,
        run_id: p.run_id,
        context_pack_id: p.context_pack_id,
        evidence: p.evidence
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
    default:
      throw new RpcUserError(`Unknown method: ${method}`);
  }
}
