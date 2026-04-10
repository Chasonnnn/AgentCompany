import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdapterSkillContext,
  AdapterSkillSnapshot,
} from "@paperclipai/adapter-utils";
import {
  buildPersistentSkillSnapshot,
  ensurePaperclipSkillSymlink,
  prepareManagedAdapterHome,
  readPaperclipRuntimeSkillEntries,
  readInstalledSkillTargets,
  resolveManagedLocalAdapterHomeDir,
  resolveSharedLocalAdapterHomeDir,
  resolvePaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

function resolveGeminiSkillsHome(config: Record<string, unknown>, companyId?: string) {
  return path.join(resolveGeminiManagedHome(config, companyId), ".gemini", "skills");
}

function resolveGeminiManagedHome(config: Record<string, unknown>, companyId?: string) {
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
  return resolveManagedLocalAdapterHomeDir(runtimeEnv, "gemini", companyId);
}

function resolveSharedGeminiSkillsHome(config: Record<string, unknown>) {
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
  return path.join(resolveSharedLocalAdapterHomeDir(runtimeEnv), ".gemini", "skills");
}

async function buildGeminiSkillSnapshot(config: Record<string, unknown>, companyId?: string): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = resolvePaperclipDesiredSkillNames(config, availableEntries);
  const skillsHome = resolveGeminiSkillsHome(config, companyId);
  const installed = await readInstalledSkillTargets(skillsHome);
  const diagnosticInstalled = await readInstalledSkillTargets(resolveSharedGeminiSkillsHome(config));
  return buildPersistentSkillSnapshot({
    adapterType: "gemini_local",
    availableEntries,
    desiredSkills,
    installed,
    diagnosticInstalled,
    skillsHome,
    locationLabel: "~/.paperclip/.../gemini-home/.gemini/skills",
    missingDetail: "Granted but not currently linked into the Paperclip-managed Gemini skills home.",
    externalConflictDetail: "Paperclip blocked this runtime slot because it is occupied by an unmanaged installation.",
    externalDetail: "Installed outside Paperclip management and blocked from this agent.",
    diagnosticLocationLabel: "~/.gemini/skills",
    diagnosticExternalDetail: "Detected in the shared Gemini skills home, but blocked from this agent.",
  });
}

export async function listGeminiSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildGeminiSkillSnapshot(ctx.config, ctx.companyId);
}

export async function syncGeminiSkills(
  ctx: AdapterSkillContext,
  desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(ctx.config, __moduleDir);
  const desiredSet = new Set([
    ...desiredSkills,
    ...availableEntries.filter((entry) => entry.required).map((entry) => entry.key),
  ]);
  const runtimeEnv =
    typeof ctx.config.env === "object" && ctx.config.env !== null && !Array.isArray(ctx.config.env)
      ? ({
          ...process.env,
          ...Object.fromEntries(
            Object.entries(ctx.config.env as Record<string, unknown>).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          ),
        } as NodeJS.ProcessEnv)
      : process.env;
  const managedHome = await prepareManagedAdapterHome({
    env: runtimeEnv,
    adapterKey: "gemini",
    companyId: ctx.companyId,
    sharedHomeDir: resolveSharedLocalAdapterHomeDir(runtimeEnv),
    logLabel: "Gemini",
    subtrees: [{ relativePath: ".gemini", excludeChildren: ["skills"] }],
  });
  const skillsHome = path.join(managedHome, ".gemini", "skills");
  await fs.mkdir(skillsHome, { recursive: true });
  const installed = await readInstalledSkillTargets(skillsHome);
  const availableByRuntimeName = new Map(availableEntries.map((entry) => [entry.runtimeName, entry]));

  for (const available of availableEntries) {
    if (!desiredSet.has(available.key)) continue;
    const target = path.join(skillsHome, available.runtimeName);
    await ensurePaperclipSkillSymlink(available.source, target);
  }

  for (const [name, installedEntry] of installed.entries()) {
    const available = availableByRuntimeName.get(name);
    if (!available) continue;
    if (desiredSet.has(available.key)) continue;
    if (installedEntry.targetPath !== available.source) continue;
    await fs.unlink(path.join(skillsHome, name)).catch(() => {});
  }

  return buildGeminiSkillSnapshot(ctx.config, ctx.companyId);
}

export function resolveGeminiDesiredSkillNames(
  config: Record<string, unknown>,
  availableEntries: Array<{ key: string; required?: boolean }>,
) {
  return resolvePaperclipDesiredSkillNames(config, availableEntries);
}
