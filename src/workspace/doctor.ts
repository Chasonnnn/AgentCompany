import fs from "node:fs/promises";
import path from "node:path";
import type { Dirent } from "node:fs";
import { validateWorkspace } from "./validate.js";
import { readMachineConfig } from "../machine/machine.js";
import { listAdapterStatuses } from "../adapters/registry.js";
import { indexDbPath, rebuildSqliteIndex, readIndexStats } from "../index/sqlite.js";
import { pathExists } from "../store/fs.js";
import { RunYaml } from "../schemas/run.js";
import { readYamlFile } from "../store/yaml.js";

export type DoctorCheckStatus = "pass" | "warn" | "fail";

export type DoctorCheck = {
  id: string;
  status: DoctorCheckStatus;
  message: string;
  details?: string[];
};

export type WorkspaceDoctorResult = {
  workspace_dir: string;
  ok: boolean;
  checks: DoctorCheck[];
  summary: {
    pass: number;
    warn: number;
    fail: number;
  };
};

export type WorkspaceDoctorArgs = {
  workspace_dir: string;
  rebuild_index?: boolean;
};

function isGitRepoDirMarker(name: string): boolean {
  return name === ".git";
}

async function listProjectRunIds(workspaceDir: string): Promise<Array<{ project_id: string; run_id: string }>> {
  const out: Array<{ project_id: string; run_id: string }> = [];
  const projectsRoot = path.join(workspaceDir, "work/projects");
  let projectEntries: Dirent[] = [];
  try {
    projectEntries = await fs.readdir(projectsRoot, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const p of projectEntries) {
    if (!p.isDirectory()) continue;
    const runsDir = path.join(projectsRoot, p.name, "runs");
    let runEntries: Dirent[] = [];
    try {
      runEntries = await fs.readdir(runsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const r of runEntries) {
      if (!r.isDirectory()) continue;
      out.push({ project_id: p.name, run_id: r.name });
    }
  }
  return out;
}

export async function doctorWorkspace(args: WorkspaceDoctorArgs): Promise<WorkspaceDoctorResult> {
  const checks: DoctorCheck[] = [];

  const validation = await validateWorkspace(args.workspace_dir);
  if (validation.ok) {
    checks.push({
      id: "workspace.schema",
      status: "pass",
      message: "Workspace schema validation passed."
    });
  } else {
    checks.push({
      id: "workspace.schema",
      status: "fail",
      message: `Workspace validation found ${validation.issues.length} issue(s).`,
      details: validation.issues.map((i) => `${i.code}: ${i.message}`).slice(0, 50)
    });
  }

  let machine:
    | Awaited<ReturnType<typeof readMachineConfig>>
    | null = null;
  try {
    machine = await readMachineConfig(args.workspace_dir);
    checks.push({
      id: "machine.config",
      status: "pass",
      message: "Machine config loaded."
    });
  } catch (e) {
    checks.push({
      id: "machine.config",
      status: "fail",
      message: `Failed to read .local/machine.yaml: ${e instanceof Error ? e.message : String(e)}`
    });
  }

  const adapters = await listAdapterStatuses(args.workspace_dir);
  const availableCliAdapters = adapters.filter((a) => a.mode === "cli" && a.available);
  if (availableCliAdapters.length === 0) {
    checks.push({
      id: "providers.cli",
      status: "fail",
      message: "No provider CLI adapter is available.",
      details: adapters
        .filter((a) => a.mode === "cli")
        .map((a) => `${a.name}: ${a.reason ?? "unavailable"}`)
    });
  } else {
    checks.push({
      id: "providers.cli",
      status: "pass",
      message: `Available provider CLIs: ${availableCliAdapters.map((a) => a.name).join(", ")}`
    });
  }
  const unavailableProtocols = adapters.filter((a) => a.mode === "protocol" && !a.available);
  if (unavailableProtocols.length > 0) {
    checks.push({
      id: "providers.protocol",
      status: "warn",
      message: "Some protocol adapters are unavailable.",
      details: unavailableProtocols.map((a) => `${a.name}: ${a.reason ?? "unavailable"}`)
    });
  } else {
    checks.push({
      id: "providers.protocol",
      status: "pass",
      message: "All protocol adapters are available."
    });
  }

  if (machine) {
    const repoChecks: string[] = [];
    const repoEntries = Object.entries(machine.repo_roots);
    if (repoEntries.length === 0) {
      checks.push({
        id: "repos.mappings",
        status: "warn",
        message: "No repo mappings configured in .local/machine.yaml (repo_roots)."
      });
    } else {
      let repoFailures = 0;
      let repoWarnings = 0;
      for (const [repoId, repoPath] of repoEntries) {
        if (!path.isAbsolute(repoPath)) {
          repoFailures += 1;
          repoChecks.push(`${repoId}: path is not absolute (${repoPath})`);
          continue;
        }
        const exists = await pathExists(repoPath);
        if (!exists) {
          repoFailures += 1;
          repoChecks.push(`${repoId}: path does not exist (${repoPath})`);
          continue;
        }
        let dotGitPresent = false;
        try {
          const entries = await fs.readdir(repoPath, { withFileTypes: true });
          dotGitPresent = entries.some((e) => isGitRepoDirMarker(e.name));
        } catch {
          dotGitPresent = false;
        }
        if (!dotGitPresent) {
          repoWarnings += 1;
          repoChecks.push(`${repoId}: path exists but .git marker not found (${repoPath})`);
        } else {
          repoChecks.push(`${repoId}: OK (${repoPath})`);
        }
      }
      checks.push({
        id: "repos.mappings",
        status: repoFailures > 0 ? "fail" : repoWarnings > 0 ? "warn" : "pass",
        message:
          repoFailures > 0
            ? `Repo mapping issues detected (${repoFailures} failure(s)).`
            : repoWarnings > 0
              ? `Repo mappings loaded with ${repoWarnings} warning(s).`
              : "Repo mappings loaded and look healthy.",
        details: repoChecks
      });
    }
  }

  if (args.rebuild_index) {
    const rebuilt = await rebuildSqliteIndex(args.workspace_dir);
    checks.push({
      id: "index.rebuild",
      status: rebuilt.event_parse_errors > 0 ? "warn" : "pass",
      message:
        rebuilt.event_parse_errors > 0
          ? `Index rebuilt with ${rebuilt.event_parse_errors} event parse error(s).`
          : "Index rebuilt successfully.",
      details: [
        `db_path: ${rebuilt.db_path}`,
        `runs_indexed: ${rebuilt.runs_indexed}`,
        `events_indexed: ${rebuilt.events_indexed}`,
        `reviews_indexed: ${rebuilt.reviews_indexed}`,
        `help_requests_indexed: ${rebuilt.help_requests_indexed}`
      ]
    });
  } else {
    const dbPath = indexDbPath(args.workspace_dir);
    const dbExists = await pathExists(dbPath);
    if (!dbExists) {
      checks.push({
        id: "index.rebuild",
        status: "warn",
        message: "SQLite index is missing. Run index:rebuild for fast queries."
      });
    } else {
      try {
        const stats = await readIndexStats(args.workspace_dir);
        checks.push({
          id: "index.rebuild",
          status: stats.event_parse_errors > 0 ? "warn" : "pass",
          message:
            stats.event_parse_errors > 0
              ? `SQLite index loaded with ${stats.event_parse_errors} event parse error(s).`
              : "SQLite index is present and readable.",
          details: [
            `runs: ${stats.runs}`,
            `events: ${stats.events}`,
            `event_parse_errors: ${stats.event_parse_errors}`,
            `reviews: ${stats.reviews}`,
            `help_requests: ${stats.help_requests}`
          ]
        });
      } catch (e) {
        checks.push({
          id: "index.rebuild",
          status: "fail",
          message: `SQLite index exists but could not be read: ${e instanceof Error ? e.message : String(e)}`
        });
      }
    }
  }

  const referencedWorktrees: string[] = [];
  const missingWorktrees: string[] = [];
  const runIds = await listProjectRunIds(args.workspace_dir);
  for (const pr of runIds) {
    const runAbs = path.join(
      args.workspace_dir,
      "work/projects",
      pr.project_id,
      "runs",
      pr.run_id,
      "run.yaml"
    );
    let runDoc: RunYaml;
    try {
      runDoc = RunYaml.parse(await readYamlFile(runAbs));
    } catch {
      continue;
    }
    const rel = runDoc.spec?.worktree_relpath;
    if (!rel) continue;
    referencedWorktrees.push(`${pr.project_id}/${pr.run_id}: ${rel}`);
    const wtAbs = path.join(args.workspace_dir, rel);
    if (!(await pathExists(wtAbs))) {
      missingWorktrees.push(`${pr.project_id}/${pr.run_id}: ${rel}`);
    }
  }
  if (referencedWorktrees.length === 0) {
    checks.push({
      id: "worktrees.references",
      status: "pass",
      message: "No run specs reference isolated worktrees yet."
    });
  } else if (missingWorktrees.length > 0) {
    checks.push({
      id: "worktrees.references",
      status: "warn",
      message: `${missingWorktrees.length} referenced worktree path(s) are missing.`,
      details: missingWorktrees
    });
  } else {
    checks.push({
      id: "worktrees.references",
      status: "pass",
      message: "All referenced worktree paths are present.",
      details: referencedWorktrees
    });
  }

  const summary = {
    pass: checks.filter((c) => c.status === "pass").length,
    warn: checks.filter((c) => c.status === "warn").length,
    fail: checks.filter((c) => c.status === "fail").length
  };
  return {
    workspace_dir: args.workspace_dir,
    ok: summary.fail === 0,
    checks,
    summary
  };
}
