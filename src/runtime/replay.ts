import path from "node:path";
import { readEventsJsonl } from "./run_queries.js";
import { verifyReplayEvents, type ReplayVerificationIssue } from "./replay_verify.js";
import { listSessions } from "./session.js";

export const ReplayModes = ["raw", "verified", "deterministic", "live"] as const;
export type ReplayMode = (typeof ReplayModes)[number];

export type ReplayParseIssue = {
  seq: number;
  error: string;
  raw?: string;
};

export type ReplayRunArgs = {
  workspace_dir: string;
  project_id: string;
  run_id: string;
  tail?: number;
  mode?: ReplayMode;
};

export type ReplayRunResult = {
  run_id: string;
  project_id: string;
  mode: ReplayMode;
  events: unknown[];
  parse_issues: ReplayParseIssue[];
  verification_issues: ReplayVerificationIssue[];
  deterministic_ok: boolean;
  live: {
    available: boolean;
    session_ref?: string;
    status?: string;
    error?: string;
  };
};

export function normalizeReplayMode(mode: string | undefined): ReplayMode {
  if (mode === "verified" || mode === "deterministic" || mode === "live") return mode;
  return "raw";
}

function normalizeTail(tail: number | undefined): number | undefined {
  if (tail === undefined) return undefined;
  if (!Number.isInteger(tail) || tail <= 0) return undefined;
  return tail;
}

export async function replayRun(args: ReplayRunArgs): Promise<ReplayRunResult> {
  const mode = normalizeReplayMode(args.mode);
  const eventsPath = path.join(
    args.workspace_dir,
    "work/projects",
    args.project_id,
    "runs",
    args.run_id,
    "events.jsonl"
  );
  const lines = await readEventsJsonl(eventsPath);
  const parsed: unknown[] = [];
  const parseIssues: ReplayParseIssue[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.ok) {
      parsed.push(line.event);
    } else {
      parseIssues.push({
        seq: i + 1,
        error: line.error,
        raw: line.raw
      });
    }
  }

  const tail = normalizeTail(args.tail);
  const startSeq = tail && tail < parsed.length ? parsed.length - tail + 1 : 1;
  const selected = tail ? parsed.slice(-tail) : parsed;
  const shouldVerify = mode === "verified" || mode === "deterministic" || mode === "live";
  const verificationIssues =
    shouldVerify
      ? verifyReplayEvents(parsed).filter((i) => i.seq >= startSeq)
      : [];
  const deterministicOk = shouldVerify && parseIssues.length === 0 && verificationIssues.length === 0;

  let live: ReplayRunResult["live"] = { available: false };
  if (mode === "live") {
    const sessions = await listSessions({
      workspace_dir: args.workspace_dir,
      project_id: args.project_id,
      run_id: args.run_id
    });
    const current = sessions[0];
    if (current) {
      live = {
        available: true,
        session_ref: current.session_ref,
        status: current.status,
        error: current.error
      };
    }
  }

  return {
    run_id: args.run_id,
    project_id: args.project_id,
    mode,
    events: selected,
    parse_issues: parseIssues,
    verification_issues: verificationIssues,
    deterministic_ok: deterministicOk,
    live
  };
}
