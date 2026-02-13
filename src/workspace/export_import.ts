import fs from "node:fs/promises";
import path from "node:path";
import { ensureDir, pathExists } from "../store/fs.js";
import { writeYamlFile } from "../store/yaml.js";
import { validateWorkspace } from "./validate.js";

const CANONICAL_EXPORT_ENTRIES = ["company", "org", "work", "inbox"] as const;

export type ExportWorkspaceArgs = {
  workspace_dir: string;
  out_dir: string;
  include_local?: boolean;
  force?: boolean;
};

export type ExportWorkspaceResult = {
  workspace_dir: string;
  out_dir: string;
  include_local: boolean;
  exported_entries: string[];
};

export type ImportWorkspaceArgs = {
  src_dir: string;
  workspace_dir: string;
  include_local?: boolean;
  force?: boolean;
};

export type ImportWorkspaceResult = {
  src_dir: string;
  workspace_dir: string;
  include_local: boolean;
  imported_entries: string[];
  validation_ok: boolean;
  validation_issues: number;
};

async function ensureWritableTarget(targetDir: string, force?: boolean): Promise<void> {
  const exists = await pathExists(targetDir);
  if (!exists) {
    await ensureDir(targetDir);
    return;
  }
  const entries = await fs.readdir(targetDir);
  if (entries.length === 0) return;
  if (!force) {
    throw new Error(
      `Refusing to write into non-empty directory (${targetDir}). Use --force to replace contents.`
    );
  }
  await fs.rm(targetDir, { recursive: true, force: true });
  await ensureDir(targetDir);
}

async function copyEntry(srcRoot: string, dstRoot: string, rel: string): Promise<boolean> {
  const src = path.join(srcRoot, rel);
  if (!(await pathExists(src))) return false;
  const dst = path.join(dstRoot, rel);
  await fs.cp(src, dst, { recursive: true, force: true });
  return true;
}

async function ensureMachineOverlay(workspaceDir: string): Promise<void> {
  await ensureDir(path.join(workspaceDir, ".local"));
  const machinePath = path.join(workspaceDir, ".local/machine.yaml");
  if (await pathExists(machinePath)) return;
  await writeYamlFile(machinePath, {
    schema_version: 1,
    type: "machine",
    repo_roots: {},
    provider_bins: {},
    provider_execution_policy: {
      codex: {
        channel: "subscription_cli",
        require_subscription_proof: true,
        proof_strategy: "codex_cli",
        allowed_bin_patterns: ["codex"]
      },
      codex_app_server: {
        channel: "subscription_cli",
        require_subscription_proof: true,
        proof_strategy: "codex_cli",
        allowed_bin_patterns: ["codex"]
      },
      claude: {
        channel: "subscription_cli",
        require_subscription_proof: true,
        proof_strategy: "claude_cli",
        allowed_bin_patterns: ["claude"]
      },
      claude_code: {
        channel: "subscription_cli",
        require_subscription_proof: true,
        proof_strategy: "claude_cli",
        allowed_bin_patterns: ["claude"]
      },
      gemini: {
        channel: "api",
        require_subscription_proof: false,
        allowed_bin_patterns: ["gemini"]
      },
      manager: {
        channel: "api",
        require_subscription_proof: false,
        allowed_bin_patterns: []
      }
    },
    provider_pricing_usd_per_1k_tokens: {}
  });
}

function isPortableValidationIssueAllowed(issue: { code: string; path?: string }): boolean {
  if (issue.code !== "missing_dir" && issue.code !== "missing_file") return false;
  return issue.path === ".local" || issue.path === ".local/machine.yaml";
}

export async function exportWorkspace(args: ExportWorkspaceArgs): Promise<ExportWorkspaceResult> {
  const sourceValidation = await validateWorkspace(args.workspace_dir);
  if (!sourceValidation.ok) {
    throw new Error(
      `Cannot export invalid workspace (${args.workspace_dir}). Run workspace:validate first.`
    );
  }

  const includeLocal = args.include_local === true;
  await ensureWritableTarget(args.out_dir, args.force);

  const exported: string[] = [];
  for (const rel of CANONICAL_EXPORT_ENTRIES) {
    if (await copyEntry(args.workspace_dir, args.out_dir, rel)) exported.push(rel);
  }
  if (includeLocal && (await copyEntry(args.workspace_dir, args.out_dir, ".local"))) {
    exported.push(".local");
  }

  return {
    workspace_dir: args.workspace_dir,
    out_dir: args.out_dir,
    include_local: includeLocal,
    exported_entries: exported
  };
}

export async function importWorkspace(args: ImportWorkspaceArgs): Promise<ImportWorkspaceResult> {
  const includeLocal = args.include_local === true;
  const srcValidation = await validateWorkspace(args.src_dir);
  if (
    !srcValidation.ok &&
    srcValidation.issues.some((issue) => !isPortableValidationIssueAllowed(issue))
  ) {
    throw new Error(`Cannot import invalid source workspace (${args.src_dir}).`);
  }

  await ensureWritableTarget(args.workspace_dir, args.force);

  const imported: string[] = [];
  for (const rel of CANONICAL_EXPORT_ENTRIES) {
    if (await copyEntry(args.src_dir, args.workspace_dir, rel)) imported.push(rel);
  }
  if (includeLocal && (await copyEntry(args.src_dir, args.workspace_dir, ".local"))) {
    imported.push(".local");
  }
  await ensureMachineOverlay(args.workspace_dir);

  const validation = await validateWorkspace(args.workspace_dir);
  return {
    src_dir: args.src_dir,
    workspace_dir: args.workspace_dir,
    include_local: includeLocal,
    imported_entries: imported,
    validation_ok: validation.ok,
    validation_issues: validation.ok ? 0 : validation.issues.length
  };
}
