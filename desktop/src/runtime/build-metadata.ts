import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type DesktopBuildMetadata = {
  channel: string;
  feedUrl: string | null;
  commitSha: string | null;
  builtAt: string;
  version: string;
};

function trimOrNull(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function sanitizeChannel(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "") || "main";
}

function normalizeFeedUrl(value: string | null): string | null {
  if (!value) return null;
  return value.replace(/\/+$/, "");
}

export function resolveDesktopBuildVersion(input: {
  packageVersion: string;
  channel?: string | null;
  runNumber?: string | null;
}): string {
  const channel = input.channel?.trim();
  const runNumber = input.runNumber?.trim();
  if (!channel || !runNumber) return input.packageVersion;

  return `${input.packageVersion}-${sanitizeChannel(channel)}.${runNumber}`;
}

export function createDesktopBuildMetadata(input: {
  packageVersion: string;
  env?: NodeJS.ProcessEnv;
  builtAt?: string;
}): DesktopBuildMetadata {
  const env = input.env ?? process.env;
  const channel = trimOrNull(env.PAPERCLIP_DESKTOP_RELEASE_CHANNEL) ?? "local";
  const version = trimOrNull(env.PAPERCLIP_DESKTOP_BUILD_VERSION)
    ?? resolveDesktopBuildVersion({
      packageVersion: input.packageVersion,
      channel,
      runNumber: trimOrNull(env.GITHUB_RUN_NUMBER),
    });

  return {
    channel,
    feedUrl: normalizeFeedUrl(trimOrNull(env.PAPERCLIP_DESKTOP_FEED_URL)),
    commitSha: trimOrNull(env.GITHUB_SHA),
    builtAt: input.builtAt ?? trimOrNull(env.PAPERCLIP_DESKTOP_BUILT_AT) ?? new Date().toISOString(),
    version,
  };
}

export function resolveDesktopBuildMetadataPath(baseDir: string): string {
  return path.resolve(baseDir, "dist", "build-metadata.json");
}

export async function writeDesktopBuildMetadata(input: {
  baseDir: string;
  metadata: DesktopBuildMetadata;
}): Promise<string> {
  const targetPath = resolveDesktopBuildMetadataPath(input.baseDir);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, `${JSON.stringify(input.metadata, null, 2)}\n`);
  return targetPath;
}

export async function readDesktopPackageVersion(packageJsonPath: string): Promise<string> {
  const raw = JSON.parse(await readFile(packageJsonPath, "utf8")) as { version?: string };
  if (!raw.version) {
    throw new Error(`Desktop package version missing from ${packageJsonPath}.`);
  }
  return raw.version;
}

export function loadDesktopBuildMetadata(metadataPath: string): DesktopBuildMetadata | null {
  if (!existsSync(metadataPath)) return null;
  return JSON.parse(readFileSync(metadataPath, "utf8")) as DesktopBuildMetadata;
}
