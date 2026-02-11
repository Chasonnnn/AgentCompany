import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { readMachineConfig } from "../machine/machine.js";
import { readYamlFile } from "../store/yaml.js";
import { pathExists } from "../store/fs.js";
import { RunYaml } from "../schemas/run.js";

export type WorktreeCleanupArgs = {
  workspace_dir: string;
  project_id?: string;
  max_age_hours?: number;
  dry_run?: boolean;
};

export type WorktreeCleanupItem = {
  project_id: string;
  run_id: string;
  repo_id: string | null;
  worktree_relpath: string;
  worktree_abs: string;
  branch: string | null;
  status: string;
  ended_at: string | null;
  action: "kept" | "removed" | "missing" | "failed";
  reason: string;
};

export type WorktreeCleanupResult = {
  workspace_dir: string;
  dry_run: boolean;
  max_age_hours: number;
  scanned: number;
  eligible: number;
  removed: number;
  missing: number;
  failed: number;
  kept: number;
  items: WorktreeCleanupItem[];
};

async function listProjectIds(workspaceDir: string): Promise<string[]> {
  const root = path.join(workspaceDir, "work/projects");
  let entries: string[] = [];
  try {
    entries = await fs.readdir(root);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries.sort()) {
    try {
      const st = await fs.stat(path.join(root, name));
      if (st.isDirectory()) out.push(name);
    } catch {
      // ignore race
    }
  }
  return out;
}

async function listRunIds(workspaceDir: string, projectId: string): Promise<string[]> {
  const root = path.join(workspaceDir, "work/projects", projectId, "runs");
  let entries: string[] = [];
  try {
    entries = await fs.readdir(root);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries.sort()) {
    try {
      const st = await fs.stat(path.join(root, name));
      if (st.isDirectory()) out.push(name);
    } catch {
      // ignore race
    }
  }
  return out;
}

function parseIsoMs(v: string | undefined): number | null {
  if (!v) return null;
  const n = Date.parse(v);
  return Number.isNaN(n) ? null : n;
}

async function runGitWorktreeRemove(repoRoot: string, worktreeAbs: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const p = spawn("git", ["worktree", "remove", "--force", worktreeAbs], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    p.stderr.on("data", (buf: Buffer) => {
      stderr += buf.toString("utf8");
    });
    p.on("error", (e) => reject(e));
    p.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git worktree remove failed (code=${code}): ${stderr.trim()}`));
    });
  });
}

export async function cleanupWorktrees(args: WorktreeCleanupArgs): Promise<WorktreeCleanupResult> {
  const dryRun = args.dry_run === true;
  const maxAgeHours = Math.max(0, args.max_age_hours ?? 72);
  const cutoffMs = Date.now() - maxAgeHours * 60 * 60 * 1000;
  const machine = await readMachineConfig(args.workspace_dir);
  const projectIds = args.project_id ? [args.project_id] : await listProjectIds(args.workspace_dir);

  const items: WorktreeCleanupItem[] = [];
  let scanned = 0;
  let eligible = 0;
  let removed = 0;
  let missing = 0;
  let failed = 0;
  let kept = 0;

  for (const projectId of projectIds) {
    const runIds = await listRunIds(args.workspace_dir, projectId);
    for (const runId of runIds) {
      const runYamlPath = path.join(
        args.workspace_dir,
        "work/projects",
        projectId,
        "runs",
        runId,
        "run.yaml"
      );
      let runDoc: RunYaml;
      try {
        runDoc = RunYaml.parse(await readYamlFile(runYamlPath));
      } catch {
        continue;
      }
      const worktreeRel = runDoc.spec?.worktree_relpath;
      if (!worktreeRel) continue;
      scanned += 1;

      const worktreeAbs = path.join(args.workspace_dir, worktreeRel);
      const endedAtMs = parseIsoMs(runDoc.ended_at) ?? parseIsoMs(runDoc.created_at) ?? 0;
      const terminal = runDoc.status === "ended" || runDoc.status === "failed" || runDoc.status === "stopped";
      const oldEnough = endedAtMs <= cutoffMs;

      const base: Omit<WorktreeCleanupItem, "action" | "reason"> = {
        project_id: projectId,
        run_id: runId,
        repo_id: runDoc.spec?.repo_id ?? null,
        worktree_relpath: worktreeRel,
        worktree_abs: worktreeAbs,
        branch: runDoc.spec?.worktree_branch ?? null,
        status: runDoc.status,
        ended_at: runDoc.ended_at ?? null
      };

      if (!terminal) {
        kept += 1;
        items.push({ ...base, action: "kept", reason: "run still active" });
        continue;
      }
      if (!oldEnough) {
        kept += 1;
        items.push({ ...base, action: "kept", reason: "younger than retention threshold" });
        continue;
      }
      eligible += 1;

      const exists = await pathExists(worktreeAbs);
      if (!exists) {
        missing += 1;
        items.push({ ...base, action: "missing", reason: "worktree path already absent" });
        continue;
      }

      if (dryRun) {
        kept += 1;
        items.push({ ...base, action: "kept", reason: "dry-run eligible for removal" });
        continue;
      }

      try {
        const repoId = runDoc.spec?.repo_id;
        const repoRoot = repoId ? machine.repo_roots[repoId] : undefined;
        if (repoRoot && (await pathExists(repoRoot))) {
          await runGitWorktreeRemove(repoRoot, worktreeAbs);
        } else {
          await fs.rm(worktreeAbs, { recursive: true, force: true });
        }
        removed += 1;
        items.push({ ...base, action: "removed", reason: "removed by retention policy" });
      } catch (e) {
        failed += 1;
        items.push({
          ...base,
          action: "failed",
          reason: e instanceof Error ? e.message : String(e)
        });
      }
    }
  }

  return {
    workspace_dir: args.workspace_dir,
    dry_run: dryRun,
    max_age_hours: maxAgeHours,
    scanned,
    eligible,
    removed,
    missing,
    failed,
    kept,
    items
  };
}
