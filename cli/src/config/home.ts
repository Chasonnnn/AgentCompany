import path from "node:path";
import {
  expandHomePrefix,
  type LocalPaperclipHomeResolveOptions,
  resolveLocalPaperclipHomeDir,
  resolvePaperclipInstanceId as resolveSharedPaperclipInstanceId,
  resolvePaperclipInstanceRoot as resolveSharedPaperclipInstanceRoot,
} from "@paperclipai/shared/local-home";

export type HomePathResolveOptions = LocalPaperclipHomeResolveOptions;
export { expandHomePrefix };

export function resolvePaperclipHomeDir(options: HomePathResolveOptions = {}): string {
  return resolveLocalPaperclipHomeDir(options);
}

export function resolvePaperclipInstanceId(
  override?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolveSharedPaperclipInstanceId(override, env);
}

export function resolvePaperclipInstanceRoot(
  instanceId?: string,
  options: HomePathResolveOptions = {},
): string {
  const id = resolvePaperclipInstanceId(instanceId, options.env);
  return resolveSharedPaperclipInstanceRoot(resolvePaperclipHomeDir(options), id);
}

export function resolveDefaultConfigPath(
  instanceId?: string,
  options: HomePathResolveOptions = {},
): string {
  return path.resolve(resolvePaperclipInstanceRoot(instanceId, options), "config.json");
}

export function resolveDefaultContextPath(options: HomePathResolveOptions = {}): string {
  return path.resolve(resolvePaperclipHomeDir(options), "context.json");
}

export function resolveDefaultCliAuthPath(options: HomePathResolveOptions = {}): string {
  return path.resolve(resolvePaperclipHomeDir(options), "auth.json");
}

export function resolveDefaultEmbeddedPostgresDir(
  instanceId?: string,
  options: HomePathResolveOptions = {},
): string {
  return path.resolve(resolvePaperclipInstanceRoot(instanceId, options), "db");
}

export function resolveDefaultLogsDir(
  instanceId?: string,
  options: HomePathResolveOptions = {},
): string {
  return path.resolve(resolvePaperclipInstanceRoot(instanceId, options), "logs");
}

export function resolveDefaultSecretsKeyFilePath(
  instanceId?: string,
  options: HomePathResolveOptions = {},
): string {
  return path.resolve(resolvePaperclipInstanceRoot(instanceId, options), "secrets", "master.key");
}

export function resolveDefaultStorageDir(
  instanceId?: string,
  options: HomePathResolveOptions = {},
): string {
  return path.resolve(resolvePaperclipInstanceRoot(instanceId, options), "data", "storage");
}

export function resolveDefaultBackupDir(
  instanceId?: string,
  options: HomePathResolveOptions = {},
): string {
  return path.resolve(resolvePaperclipInstanceRoot(instanceId, options), "data", "backups");
}

export function describeLocalInstancePaths(
  instanceId?: string,
  options: HomePathResolveOptions = {},
) {
  const resolvedInstanceId = resolvePaperclipInstanceId(instanceId, options.env);
  const instanceRoot = resolvePaperclipInstanceRoot(resolvedInstanceId, options);
  return {
    homeDir: resolvePaperclipHomeDir(options),
    instanceId: resolvedInstanceId,
    instanceRoot,
    configPath: resolveDefaultConfigPath(resolvedInstanceId, options),
    embeddedPostgresDataDir: resolveDefaultEmbeddedPostgresDir(resolvedInstanceId, options),
    backupDir: resolveDefaultBackupDir(resolvedInstanceId, options),
    logDir: resolveDefaultLogsDir(resolvedInstanceId, options),
    secretsKeyFilePath: resolveDefaultSecretsKeyFilePath(resolvedInstanceId, options),
    storageDir: resolveDefaultStorageDir(resolvedInstanceId, options),
  };
}
