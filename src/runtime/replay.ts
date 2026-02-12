import path from "node:path";
import { readEventsJsonl } from "./run_queries.js";
import { verifyReplayEvents, type ReplayVerificationIssue } from "./replay_verify.js";

export const ReplayModes = ["raw", "verified"] as const;
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
};

export function normalizeReplayMode(mode: string | undefined): ReplayMode {
  return mode === "verified" ? "verified" : "raw";
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
  const verificationIssues =
    mode === "verified"
      ? verifyReplayEvents(parsed).filter((i) => i.seq >= startSeq)
      : [];

  return {
    run_id: args.run_id,
    project_id: args.project_id,
    mode,
    events: selected,
    parse_issues: parseIssues,
    verification_issues: verificationIssues
  };
}
