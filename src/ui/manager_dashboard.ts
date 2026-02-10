import readline from "node:readline";
import process from "node:process";
import { buildUiSnapshot, type UiSnapshot } from "../runtime/ui_bundle.js";
import { resolveInboxAndBuildUiSnapshot } from "./resolve_and_snapshot.js";
import type { ActorRole } from "../policy/policy.js";

export type ManagerDashboardArgs = {
  workspace_dir: string;
  project_id: string;
  actor_id: string;
  actor_role: ActorRole;
  actor_team_id?: string;
  monitor_limit?: number;
  pending_limit?: number;
  decisions_limit?: number;
  refresh_index?: boolean;
  sync_index?: boolean;
  once?: boolean;
  clear_screen?: boolean;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
};

export type ManagerDashboardCommand =
  | { kind: "refresh" }
  | { kind: "help" }
  | { kind: "quit" }
  | {
      kind: "resolve";
      decision: "approved" | "denied";
      artifact_id: string;
      notes?: string;
    }
  | { kind: "invalid"; error: string };

export type ManagerDashboardJson = {
  workspace_dir: string;
  generated_at: string;
  index_sync_worker: {
    enabled: boolean;
    running: boolean;
    pending_workspaces: number;
    total_notify_calls: number;
    total_workspace_sync_errors: number;
    last_error_at_ms: number | null;
    last_error_message: string | null;
  };
  counts: {
    pending: number;
    recent_decisions: number;
    runs: number;
  };
  pending: Array<{
    artifact_id: string;
    artifact_type: string;
    project_id: string;
    run_id: string | null;
    created_at: string | null;
    parse_error_count: number;
    title: string | null;
  }>;
  recent_decisions: Array<{
    decision: "approved" | "denied";
    subject_artifact_id: string;
    project_id: string;
    actor_id: string;
    created_at: string;
    parse_error_count: number;
  }>;
  runs: Array<{
    run_id: string;
    project_id: string;
    run_status: string;
    live_status?: string;
    last_event_type?: string;
    parse_error_count: number;
    created_at?: string;
  }>;
};

function compact(text: string | null | undefined, max = 64): string {
  if (!text) return "-";
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(1, max - 1))}…`;
}

function isTty(out: NodeJS.WritableStream): boolean {
  return (out as NodeJS.WriteStream).isTTY === true;
}

function maybeClearScreen(out: NodeJS.WritableStream, enabled: boolean): void {
  if (enabled && isTty(out)) {
    out.write("\x1Bc");
  }
}

export function managerDashboardHelpText(): string {
  return [
    "Commands:",
    "  r | refresh                       Refresh snapshot",
    "  a | approve <artifact_id> [note] Resolve pending item as approved",
    "  d | deny <artifact_id> [note]    Resolve pending item as denied",
    "  h | help                          Show this help",
    "  q | quit                          Exit dashboard"
  ].join("\n");
}

export function parseManagerDashboardCommand(input: string): ManagerDashboardCommand {
  const trimmed = input.trim();
  if (!trimmed) return { kind: "refresh" };
  const parts = trimmed.split(/\s+/);
  const op = parts[0]?.toLowerCase();

  if (op === "r" || op === "refresh") return { kind: "refresh" };
  if (op === "h" || op === "help" || op === "?") return { kind: "help" };
  if (op === "q" || op === "quit" || op === "exit") return { kind: "quit" };

  if (op === "a" || op === "approve" || op === "d" || op === "deny") {
    const artifactId = parts[1]?.trim();
    if (!artifactId) {
      return { kind: "invalid", error: "artifact_id is required" };
    }
    const notes = parts.slice(2).join(" ").trim();
    return {
      kind: "resolve",
      decision: op === "a" || op === "approve" ? "approved" : "denied",
      artifact_id: artifactId,
      notes: notes || undefined
    };
  }

  return { kind: "invalid", error: `Unknown command: ${parts[0]}` };
}

export function formatManagerDashboardSnapshot(snapshot: UiSnapshot): string {
  const pending = snapshot.review_inbox.pending;
  const decisions = snapshot.review_inbox.recent_decisions;
  const rows = snapshot.monitor.rows;

  const lines: string[] = [];
  lines.push("=== Manager Dashboard ===");
  lines.push(`workspace: ${snapshot.workspace_dir}`);
  lines.push(`generated_at: ${snapshot.generated_at}`);
  lines.push(
    `index_sync_worker: enabled=${snapshot.index_sync_worker.enabled} running=${snapshot.index_sync_worker.running} pending_workspaces=${snapshot.index_sync_worker.pending_workspaces}`
  );
  lines.push("");

  lines.push(`Pending approvals (${pending.length}):`);
  if (pending.length === 0) {
    lines.push("- none");
  } else {
    for (const p of pending.slice(0, 12)) {
      lines.push(
        `- ${p.artifact_id} [${p.artifact_type}] project=${p.project_id} parse_errors=${p.parse_error_count} title=${compact(p.title, 48)}`
      );
    }
    if (pending.length > 12) {
      lines.push(`- ... ${pending.length - 12} more`);
    }
  }
  lines.push("");

  lines.push(`Recent decisions (${decisions.length}):`);
  if (decisions.length === 0) {
    lines.push("- none");
  } else {
    for (const d of decisions.slice(0, 10)) {
      lines.push(
        `- ${d.decision} ${d.subject_artifact_id} project=${d.project_id} by=${d.actor_id} at=${d.created_at}`
      );
    }
    if (decisions.length > 10) {
      lines.push(`- ... ${decisions.length - 10} more`);
    }
  }
  lines.push("");

  lines.push(`Runs (${rows.length}):`);
  if (rows.length === 0) {
    lines.push("- none");
  } else {
    for (const r of rows.slice(0, 12)) {
      const live = r.live_status ? ` live=${r.live_status}` : "";
      const last = r.last_event ? ` last=${r.last_event.type}` : "";
      lines.push(
        `- ${r.run_id} project=${r.project_id} status=${r.run_status}${live}${last} parse_errors=${r.parse_error_count}`
      );
    }
    if (rows.length > 12) {
      lines.push(`- ... ${rows.length - 12} more`);
    }
  }

  lines.push("");
  lines.push(managerDashboardHelpText());
  return `${lines.join("\n")}\n`;
}

export function compactManagerDashboardSnapshot(snapshot: UiSnapshot): ManagerDashboardJson {
  return {
    workspace_dir: snapshot.workspace_dir,
    generated_at: snapshot.generated_at,
    index_sync_worker: {
      enabled: snapshot.index_sync_worker.enabled,
      running: snapshot.index_sync_worker.running,
      pending_workspaces: snapshot.index_sync_worker.pending_workspaces,
      total_notify_calls: snapshot.index_sync_worker.total_notify_calls,
      total_workspace_sync_errors: snapshot.index_sync_worker.total_workspace_sync_errors,
      last_error_at_ms: snapshot.index_sync_worker.last_error_at_ms,
      last_error_message: snapshot.index_sync_worker.last_error_message
    },
    counts: {
      pending: snapshot.review_inbox.pending.length,
      recent_decisions: snapshot.review_inbox.recent_decisions.length,
      runs: snapshot.monitor.rows.length
    },
    pending: snapshot.review_inbox.pending.map((p) => ({
      artifact_id: p.artifact_id,
      artifact_type: p.artifact_type,
      project_id: p.project_id,
      run_id: p.run_id,
      created_at: p.created_at,
      parse_error_count: p.parse_error_count,
      title: p.title
    })),
    recent_decisions: snapshot.review_inbox.recent_decisions.map((d) => ({
      decision: d.decision,
      subject_artifact_id: d.subject_artifact_id,
      project_id: d.project_id,
      actor_id: d.actor_id,
      created_at: d.created_at,
      parse_error_count: d.parse_error_count
    })),
    runs: snapshot.monitor.rows.map((r) => ({
      run_id: r.run_id,
      project_id: r.project_id,
      run_status: r.run_status,
      live_status: r.live_status,
      last_event_type: r.last_event?.type,
      parse_error_count: r.parse_error_count,
      created_at: r.created_at
    }))
  };
}

async function fetchSnapshot(args: ManagerDashboardArgs): Promise<UiSnapshot> {
  return buildUiSnapshot({
    workspace_dir: args.workspace_dir,
    project_id: args.project_id,
    monitor_limit: args.monitor_limit,
    pending_limit: args.pending_limit,
    decisions_limit: args.decisions_limit,
    refresh_index: args.refresh_index,
    sync_index: args.sync_index
  });
}

export async function buildManagerDashboardText(
  args: Omit<ManagerDashboardArgs, "once" | "clear_screen" | "input" | "output">
): Promise<string> {
  const snapshot = await fetchSnapshot(args);
  return formatManagerDashboardSnapshot(snapshot);
}

export async function buildManagerDashboardJson(
  args: Omit<ManagerDashboardArgs, "once" | "clear_screen" | "input" | "output">
): Promise<ManagerDashboardJson> {
  const snapshot = await fetchSnapshot(args);
  return compactManagerDashboardSnapshot(snapshot);
}

function question(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer));
  });
}

export async function runManagerDashboard(args: ManagerDashboardArgs): Promise<void> {
  const out = args.output ?? process.stdout;
  const clearScreen = args.clear_screen !== false;

  let current = await fetchSnapshot(args);
  maybeClearScreen(out, clearScreen);
  out.write(formatManagerDashboardSnapshot(current));

  if (args.once) return;

  const input = args.input ?? process.stdin;
  const rl = readline.createInterface({ input, output: out, terminal: isTty(out) });

  try {
    while (true) {
      const line = await question(rl, "manager-dashboard> ");
      const cmd = parseManagerDashboardCommand(line);

      if (cmd.kind === "quit") {
        out.write("Exiting manager dashboard.\n");
        break;
      }

      if (cmd.kind === "help") {
        out.write(`${managerDashboardHelpText()}\n`);
        continue;
      }

      if (cmd.kind === "invalid") {
        out.write(`ERROR: ${cmd.error}\n`);
        continue;
      }

      try {
        if (cmd.kind === "resolve") {
          const res = await resolveInboxAndBuildUiSnapshot({
            workspace_dir: args.workspace_dir,
            project_id: args.project_id,
            artifact_id: cmd.artifact_id,
            decision: cmd.decision,
            actor_id: args.actor_id,
            actor_role: args.actor_role,
            actor_team_id: args.actor_team_id,
            notes: cmd.notes,
            monitor_limit: args.monitor_limit,
            pending_limit: args.pending_limit,
            decisions_limit: args.decisions_limit,
            refresh_index: args.refresh_index,
            sync_index: args.sync_index
          });
          current = res.snapshot;
          out.write(
            `Resolved ${res.resolved.decision}: ${res.resolved.artifact_id} (${res.resolved.subject_kind})\n`
          );
        } else {
          current = await fetchSnapshot(args);
        }
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        out.write(`ERROR: ${err.message}\n`);
      }

      maybeClearScreen(out, clearScreen);
      out.write(formatManagerDashboardSnapshot(current));
    }
  } finally {
    rl.close();
  }
}
