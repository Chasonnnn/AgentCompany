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

function resolvePiSkillsHome(config: Record<string, unknown>, companyId?: string) {
  return path.join(resolvePiManagedHome(config, companyId), ".pi", "agent", "skills");
}

function resolvePiManagedHome(config: Record<string, unknown>, companyId?: string) {
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
  return resolveManagedLocalAdapterHomeDir(runtimeEnv, "pi", companyId);
}

function resolveSharedPiSkillsHome(config: Record<string, unknown>) {
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
  return path.join(resolveSharedLocalAdapterHomeDir(runtimeEnv), ".pi", "agent", "skills");
}

async function buildPiSkillSnapshot(config: Record<string, unknown>, companyId?: string): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = resolvePaperclipDesiredSkillNames(config, availableEntries);
  const skillsHome = resolvePiSkillsHome(config, companyId);
  const installed = await readInstalledSkillTargets(skillsHome);
  const diagnosticInstalled = await readInstalledSkillTargets(resolveSharedPiSkillsHome(config));
  return buildPersistentSkillSnapshot({
    adapterType: "pi_local",
    availableEntries,
    desiredSkills,
    installed,
    diagnosticInstalled,
    skillsHome,
    locationLabel: "~/.paperclip/.../pi-home/.pi/agent/skills",
    missingDetail: "Granted but not currently linked into the Paperclip-managed Pi skills home.",
    externalConflictDetail: "Paperclip blocked this runtime slot because it is occupied by an unmanaged installation.",
    externalDetail: "Installed outside Paperclip management and blocked from this agent.",
    diagnosticLocationLabel: "~/.pi/agent/skills",
    diagnosticExternalDetail: "Detected in the shared Pi skills home, but blocked from this agent.",
  });
}

export async function listPiSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildPiSkillSnapshot(ctx.config, ctx.companyId);
}

export async function syncPiSkills(
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
    adapterKey: "pi",
    companyId: ctx.companyId,
    sharedHomeDir: resolveSharedLocalAdapterHomeDir(runtimeEnv),
    logLabel: "Pi",
    subtrees: [{ relativePath: ".pi", excludeChildren: ["agent/skills", "paperclips"] }],
  });
  const skillsHome = path.join(managedHome, ".pi", "agent", "skills");
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

  return buildPiSkillSnapshot(ctx.config, ctx.companyId);
}

export function resolvePiDesiredSkillNames(
  config: Record<string, unknown>,
  availableEntries: Array<{ key: string; required?: boolean }>,
) {
  return resolvePaperclipDesiredSkillNames(config, availableEntries);
}
