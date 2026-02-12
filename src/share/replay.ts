import path from "node:path";
import { SharePackManifestYaml } from "../schemas/share_pack.js";
import { readYamlFile } from "../store/yaml.js";
import { readEventsJsonl } from "../runtime/run_queries.js";
import {
  normalizeReplayMode,
  type ReplayMode,
  type ReplayParseIssue
} from "../runtime/replay.js";
import { verifyReplayEvents, type ReplayVerificationIssue } from "../runtime/replay_verify.js";

export type ReplaySharePackArgs = {
  workspace_dir: string;
  project_id: string;
  share_pack_id: string;
  run_id?: string;
  tail?: number;
  mode?: ReplayMode;
};

export type ReplaySharePackResult = {
  share_pack_id: string;
  project_id: string;
  mode: ReplayMode;
  runs: Array<{
    run_id: string;
    source_relpath: string;
    bundle_relpath: string;
    events: any[];
    parse_issues: ReplayParseIssue[];
    verification_issues: ReplayVerificationIssue[];
  }>;
};

function normalizeTail(tail: number | undefined): number | undefined {
  if (tail === undefined) return undefined;
  if (!Number.isInteger(tail) || tail <= 0) return undefined;
  return tail;
}

export async function replaySharePack(args: ReplaySharePackArgs): Promise<ReplaySharePackResult> {
  const mode = normalizeReplayMode(args.mode);
  const manifestPath = path.join(
    args.workspace_dir,
    "work/projects",
    args.project_id,
    "share_packs",
    args.share_pack_id,
    "manifest.yaml"
  );
  const manifest = SharePackManifestYaml.parse(await readYamlFile(manifestPath));
  if (manifest.project_id !== args.project_id) {
    throw new Error(
      `Share pack ${args.share_pack_id} belongs to project ${manifest.project_id}, not ${args.project_id}.`
    );
  }
  const includedRuns = manifest.included_runs ?? [];
  const selectedRuns = args.run_id
    ? includedRuns.filter((r) => r.run_id === args.run_id)
    : includedRuns;
  if (args.run_id && selectedRuns.length === 0) {
    throw new Error(`Run ${args.run_id} is not included in share pack ${args.share_pack_id}.`);
  }

  const outRuns: ReplaySharePackResult["runs"] = [];
  const tail = normalizeTail(args.tail);
  for (const run of selectedRuns) {
    const bundleAbs = path.join(args.workspace_dir, run.bundle_relpath);
    const lines = await readEventsJsonl(bundleAbs);
    const parsed: any[] = [];
    const parseIssues: ReplayParseIssue[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.ok) parsed.push(line.event);
      else parseIssues.push({ seq: i + 1, raw: line.raw, error: line.error });
    }
    const startSeq = tail && tail < parsed.length ? parsed.length - tail + 1 : 1;
    const verificationIssues =
      mode === "verified"
        ? verifyReplayEvents(parsed).filter((i) => i.seq >= startSeq)
        : [];
    outRuns.push({
      run_id: run.run_id,
      source_relpath: run.source_relpath,
      bundle_relpath: run.bundle_relpath,
      events: tail ? parsed.slice(-tail) : parsed,
      parse_issues: parseIssues,
      verification_issues: verificationIssues
    });
  }

  return {
    share_pack_id: args.share_pack_id,
    project_id: args.project_id,
    mode,
    runs: outRuns
  };
}
