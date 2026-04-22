import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdapterSkillContext,
  AdapterSkillEntry,
  AdapterSkillSnapshot,
} from "@paperclipai/adapter-utils";
import {
  readPaperclipRuntimeSkillEntries,
  readInstalledSkillTargets,
  resolveSharedLocalAdapterHomeDir,
  resolvePaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

function resolveClaudeSharedSkillsHome(config: Record<string, unknown>) {
  const env =
    typeof config.env === "object" && config.env !== null && !Array.isArray(config.env)
      ? (config.env as Record<string, unknown>)
      : {};
  const runtimeEnv = {
    ...process.env,
    ...Object.fromEntries(
      Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    ),
  };
  return path.join(resolveSharedLocalAdapterHomeDir(runtimeEnv), ".claude", "skills");
}

export interface ClaudeSharedHostSkillEntry {
  key: string;
  runtimeName: string;
  sourcePath: string;
  targetPath: string | null;
  state: "external" | "blocked";
  originLabel: string;
  detail: string;
  locationLabel: string;
}

function buildClaudeSharedHostSkillKey(runtimeName: string) {
  return `host/claude/${runtimeName}`;
}

export async function listClaudeSharedHostSkillEntries(
  config: Record<string, unknown>,
  managedRuntimeNames: Iterable<string> = [],
): Promise<ClaudeSharedHostSkillEntry[]> {
  const env =
    typeof config.env === "object" && config.env !== null && !Array.isArray(config.env)
      ? (config.env as Record<string, unknown>)
      : {};
  if (env.PAPERCLIP_DISABLE_SHARED_HOST_SKILLS === "1") {
    return [];
  }
  const sharedSkillsHome = resolveClaudeSharedSkillsHome(config);
  const managedNames = new Set(managedRuntimeNames);
  const installed = await readInstalledSkillTargets(sharedSkillsHome);

  return Array.from(installed.entries())
    .map(([runtimeName, installedEntry]) => {
      const shadowed = managedNames.has(runtimeName);
      return {
        key: buildClaudeSharedHostSkillKey(runtimeName),
        runtimeName,
        sourcePath: path.join(sharedSkillsHome, runtimeName),
        targetPath: installedEntry.targetPath ?? path.join(sharedSkillsHome, runtimeName),
        state: shadowed ? ("blocked" as const) : ("external" as const),
        originLabel: shadowed ? "Shadowed host skill" : "Shared host skill",
        detail: shadowed
          ? "Detected in ~/.claude/skills, but a Paperclip-managed Claude skill with the same runtime name takes precedence."
          : "Loaded automatically from the shared Claude skills home.",
        locationLabel: "~/.claude/skills",
      };
    })
    .sort((left, right) => left.runtimeName.localeCompare(right.runtimeName));
}

async function buildClaudeSkillSnapshot(
  config: Record<string, unknown>,
): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const availableByKey = new Map(availableEntries.map((entry) => [entry.key, entry]));
  const desiredSkills = resolvePaperclipDesiredSkillNames(config, availableEntries);
  const desiredSet = new Set(desiredSkills);
  const entries: AdapterSkillEntry[] = availableEntries.map((entry) => ({
    key: entry.key,
    runtimeName: entry.runtimeName,
    desired: desiredSet.has(entry.key),
    managed: true,
    state: desiredSet.has(entry.key) ? "configured" : "available",
    origin: entry.required ? "paperclip_required" : "company_managed",
    originLabel: entry.required ? "Required by Paperclip" : "Managed by Paperclip",
    readOnly: false,
    sourcePath: entry.source,
    targetPath: null,
    detail: desiredSet.has(entry.key)
      ? "Will be materialized into the stable Paperclip-managed Claude prompt bundle on the next run."
      : null,
    required: Boolean(entry.required),
    requiredReason: entry.requiredReason ?? null,
  }));
  const warnings: string[] = [];
  const managedRuntimeNames = availableEntries
    .filter((entry) => desiredSet.has(entry.key))
    .map((entry) => entry.runtimeName);
  const sharedHostEntries = await listClaudeSharedHostSkillEntries(config, managedRuntimeNames);

  for (const desiredSkill of desiredSkills) {
    if (availableByKey.has(desiredSkill)) continue;
    warnings.push(`Desired skill "${desiredSkill}" is not available from the Paperclip skills directory.`);
    entries.push({
      key: desiredSkill,
      runtimeName: null,
      desired: true,
      managed: true,
      state: "missing",
      origin: "external_unknown",
      originLabel: "External or unavailable",
      readOnly: false,
      sourcePath: undefined,
      targetPath: undefined,
      detail: "Paperclip cannot find this skill in the local runtime skills directory.",
    });
  }

  for (const sharedHostEntry of sharedHostEntries) {
    entries.push({
      key: sharedHostEntry.key,
      runtimeName: sharedHostEntry.runtimeName,
      desired: false,
      managed: false,
      state: sharedHostEntry.state,
      origin: "user_installed",
      originLabel: sharedHostEntry.originLabel,
      locationLabel: sharedHostEntry.locationLabel,
      readOnly: true,
      sourcePath: null,
      targetPath: sharedHostEntry.targetPath,
      detail: sharedHostEntry.detail,
    });
  }

  entries.sort((left, right) => left.key.localeCompare(right.key));

  return {
    adapterType: "claude_local",
    supported: true,
    mode: "ephemeral",
    desiredSkills,
    warnings,
    entries,
  };
}

export async function listClaudeSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildClaudeSkillSnapshot(ctx.config);
}

export async function syncClaudeSkills(
  ctx: AdapterSkillContext,
  _desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  return buildClaudeSkillSnapshot(ctx.config);
}

export function resolveClaudeDesiredSkillNames(
  config: Record<string, unknown>,
  availableEntries: Array<{ key: string; required?: boolean }>,
) {
  return resolvePaperclipDesiredSkillNames(config, availableEntries);
}
