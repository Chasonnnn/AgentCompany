import fs from "node:fs/promises";
import path from "node:path";
import type { Dirent } from "node:fs";
import { RunYaml } from "../schemas/run.js";
import { readYamlFile } from "../store/yaml.js";

export type ListedRun = {
  project_id: string;
  run_id: string;
  created_at: string;
  status: string;
  provider: string;
  agent_id: string;
};

export async function listRuns(args: {
  workspace_dir: string;
  project_id?: string;
}): Promise<ListedRun[]> {
  const projectsRoot = path.join(args.workspace_dir, "work/projects");
  const projectIds = args.project_id
    ? [args.project_id]
    : (await fs.readdir(projectsRoot, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name);

  const runs: ListedRun[] = [];

  for (const projectId of projectIds) {
    const runsDir = path.join(projectsRoot, projectId, "runs");
    let entries: Dirent[] = [];
    try {
      entries = await fs.readdir(runsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const runId = ent.name;
      const runYamlPath = path.join(runsDir, runId, "run.yaml");
      try {
        const doc = RunYaml.parse(await readYamlFile(runYamlPath));
        runs.push({
          project_id: projectId,
          run_id: doc.id,
          created_at: doc.created_at,
          status: doc.status,
          provider: doc.provider,
          agent_id: doc.agent_id
        });
      } catch {
        // If run.yaml is invalid, workspace:validate should report it. listRuns stays best-effort.
      }
    }
  }

  runs.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  return runs;
}

export type ParsedEventLine =
  | { ok: true; event: any }
  | { ok: false; raw: string; error: string };

export async function readEventsJsonl(eventsFilePath: string): Promise<ParsedEventLine[]> {
  const s = await fs.readFile(eventsFilePath, { encoding: "utf8" });
  const lines = s.split("\n").filter((l) => l.trim().length > 0);
  const out: ParsedEventLine[] = [];
  for (const l of lines) {
    try {
      out.push({ ok: true, event: JSON.parse(l) });
    } catch (e) {
      out.push({ ok: false, raw: l, error: (e as Error).message });
    }
  }
  return out;
}
