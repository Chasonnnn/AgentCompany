import { resolveInboxItem, type ResolveInboxItemResult } from "../inbox/resolve.js";
import { buildUiSnapshot, type UiSnapshot } from "../runtime/ui_bundle.js";
import type { ActorRole } from "../policy/policy.js";

export type ResolveAndSnapshotArgs = {
  workspace_dir: string;
  project_id: string;
  artifact_id: string;
  decision: "approved" | "denied";
  actor_id: string;
  actor_role: ActorRole;
  actor_team_id?: string;
  notes?: string;
  monitor_limit?: number;
  pending_limit?: number;
  decisions_limit?: number;
  refresh_index?: boolean;
  sync_index?: boolean;
};

export type ResolveAndSnapshotResult = {
  resolved: ResolveInboxItemResult;
  snapshot: UiSnapshot;
};

export async function resolveInboxAndBuildUiSnapshot(
  args: ResolveAndSnapshotArgs
): Promise<ResolveAndSnapshotResult> {
  const resolved = await resolveInboxItem({
    workspace_dir: args.workspace_dir,
    project_id: args.project_id,
    artifact_id: args.artifact_id,
    decision: args.decision,
    actor_id: args.actor_id,
    actor_role: args.actor_role,
    actor_team_id: args.actor_team_id,
    notes: args.notes
  });

  const snapshot = await buildUiSnapshot({
    workspace_dir: args.workspace_dir,
    project_id: args.project_id,
    monitor_limit: args.monitor_limit,
    pending_limit: args.pending_limit,
    decisions_limit: args.decisions_limit,
    refresh_index: args.refresh_index,
    sync_index: args.sync_index
  });

  return { resolved, snapshot };
}
