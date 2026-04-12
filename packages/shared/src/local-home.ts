import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_PAPERCLIP_INSTANCE_ID = "default";
const INSTANCE_ID_RE = /^[a-zA-Z0-9_-]+$/;
const DESKTOP_PAPERCLIP_HOME_SEGMENTS = [
  "Library",
  "Application Support",
  "@paperclipai",
  "desktop",
  "paperclip",
] as const;
const INSTANCE_MARKERS = [".env", "companies", "data", "db", "logs", "secrets"] as const;

export type LocalPaperclipHomeResolveOptions = {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  instanceId?: string;
};

export function expandHomePrefix(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.resolve(os.homedir(), value.slice(2));
  return value;
}

export function resolvePaperclipInstanceId(
  override?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = override?.trim() || env.PAPERCLIP_INSTANCE_ID?.trim() || DEFAULT_PAPERCLIP_INSTANCE_ID;
  if (!INSTANCE_ID_RE.test(raw)) {
    throw new Error(
      `Invalid instance id '${raw}'. Allowed characters: letters, numbers, '_' and '-'.`,
    );
  }
  return raw;
}

export function resolveDesktopPaperclipHomeDir(homeDir = os.homedir()): string {
  return path.resolve(homeDir, ...DESKTOP_PAPERCLIP_HOME_SEGMENTS);
}

export function resolvePaperclipInstanceRoot(homeDir: string, instanceId: string): string {
  return path.resolve(homeDir, "instances", instanceId);
}

export function looksLikePaperclipInstanceRoot(instanceRoot: string): boolean {
  if (!existsSync(instanceRoot)) return false;
  return INSTANCE_MARKERS.some((entry) => existsSync(path.resolve(instanceRoot, entry)));
}

export function resolveLocalPaperclipHomeDir(
  options: LocalPaperclipHomeResolveOptions = {},
): string {
  const env = options.env ?? process.env;
  const envHome = env.PAPERCLIP_HOME?.trim();
  if (envHome) return path.resolve(expandHomePrefix(envHome));

  const homeDir = options.homeDir ?? os.homedir();
  const instanceId = resolvePaperclipInstanceId(options.instanceId, env);
  const desktopHome = resolveDesktopPaperclipHomeDir(homeDir);
  const desktopInstanceRoot = resolvePaperclipInstanceRoot(desktopHome, instanceId);
  if (looksLikePaperclipInstanceRoot(desktopInstanceRoot)) {
    return desktopHome;
  }

  return path.resolve(homeDir, ".paperclip");
}
