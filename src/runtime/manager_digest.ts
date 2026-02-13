import type {
  ResultArtifactPointer,
  ResultCommand,
  ResultFileChange,
  ResultNextAction,
  ResultSpec
} from "../schemas/result.js";

const SUMMARY_MAX_CHARS = 1200;
const FILES_MAX = 20;
const COMMANDS_MAX = 20;

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  if (n <= 3) return s.slice(0, n);
  return `${s.slice(0, n - 3)}...`;
}

function compactFiles(files: ResultFileChange[]): ResultFileChange[] {
  return files.slice(0, FILES_MAX).map((f) => ({
    path: f.path,
    change_type: f.change_type,
    summary: f.summary ? truncate(f.summary, 180) : undefined
  }));
}

function compactCommands(commands: ResultCommand[]): ResultCommand[] {
  return commands.slice(0, COMMANDS_MAX).map((c) => ({
    command: truncate(c.command, 220),
    exit_code: c.exit_code,
    summary: c.summary ? truncate(c.summary, 180) : undefined
  }));
}

function artifactPointersOnly(artifacts: ResultArtifactPointer[]): ResultArtifactPointer[] {
  return artifacts.map((a) => ({
    relpath: a.relpath,
    artifact_id: a.artifact_id,
    kind: a.kind,
    sha256: a.sha256
  }));
}

function compactNextActions(actions: ResultNextAction[]): ResultNextAction[] {
  return actions.slice(0, 20).map((a) => ({
    action: truncate(a.action, 220),
    rationale: a.rationale ? truncate(a.rationale, 220) : undefined
  }));
}

export type ManagerDigest = {
  job_id: string;
  attempt_run_id: string;
  status: ResultSpec["status"];
  summary: string;
  files_changed: ResultFileChange[];
  commands_run: ResultCommand[];
  artifacts: ResultArtifactPointer[];
  next_actions: ResultNextAction[];
  errors: ResultSpec["errors"];
  signals: Record<string, unknown>;
};

export function buildManagerDigest(args: {
  result: ResultSpec;
  signals?: Record<string, unknown>;
}): ManagerDigest {
  return {
    job_id: args.result.job_id,
    attempt_run_id: args.result.attempt_run_id,
    status: args.result.status,
    summary: truncate(args.result.summary, SUMMARY_MAX_CHARS),
    files_changed: compactFiles(args.result.files_changed),
    commands_run: compactCommands(args.result.commands_run),
    artifacts: artifactPointersOnly(args.result.artifacts),
    next_actions: compactNextActions(args.result.next_actions),
    errors: args.result.errors.slice(0, 20),
    signals: args.signals ?? {}
  };
}

