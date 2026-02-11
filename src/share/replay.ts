import path from "node:path";
import { SharePackManifestYaml } from "../schemas/share_pack.js";
import { readYamlFile } from "../store/yaml.js";
import { readEventsJsonl } from "../runtime/run_queries.js";

export type ReplaySharePackArgs = {
  workspace_dir: string;
  project_id: string;
  share_pack_id: string;
  run_id?: string;
  tail?: number;
};

export type ReplaySharePackResult = {
  share_pack_id: string;
  project_id: string;
  runs: Array<{
    run_id: string;
    source_relpath: string;
    bundle_relpath: string;
    events: any[];
    parse_issues: Array<{ raw: string; error: string }>;
  }>;
};

export async function replaySharePack(args: ReplaySharePackArgs): Promise<ReplaySharePackResult> {
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
  for (const run of selectedRuns) {
    const bundleAbs = path.join(args.workspace_dir, run.bundle_relpath);
    const lines = await readEventsJsonl(bundleAbs);
    const parsed = lines.filter((l): l is { ok: true; event: any } => l.ok).map((l) => l.event);
    const issues = lines
      .filter((l): l is { ok: false; raw: string; error: string } => !l.ok)
      .map((l) => ({ raw: l.raw, error: l.error }));
    outRuns.push({
      run_id: run.run_id,
      source_relpath: run.source_relpath,
      bundle_relpath: run.bundle_relpath,
      events: args.tail && args.tail > 0 ? parsed.slice(-args.tail) : parsed,
      parse_issues: issues
    });
  }

  return {
    share_pack_id: args.share_pack_id,
    project_id: args.project_id,
    runs: outRuns
  };
}
