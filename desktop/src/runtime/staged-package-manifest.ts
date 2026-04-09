import { access, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

type PackageManifest = Record<string, unknown> & {
  name?: string;
  publishConfig?: Record<string, unknown>;
};

const RUNTIME_MANIFEST_KEYS = ["main", "module", "types", "exports", "bin"] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function toRuntimePackageManifest(manifest: PackageManifest): PackageManifest {
  if (!manifest.name?.startsWith("@paperclipai/")) return manifest;
  if (!isObject(manifest.publishConfig)) return manifest;

  let changed = false;
  const nextManifest: PackageManifest = { ...manifest };
  for (const key of RUNTIME_MANIFEST_KEYS) {
    if (manifest.publishConfig[key] === undefined) continue;
    nextManifest[key] = manifest.publishConfig[key];
    changed = true;
  }

  return changed ? nextManifest : manifest;
}

async function collectPaperclipManifestPaths(nodeModulesRoot: string): Promise<string[]> {
  const manifestPaths = new Set<string>();

  async function collectScopePackages(scopeDir: string) {
    const entries = await readdir(scopeDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const packageDir = path.join(scopeDir, entry.name);
      const resolvedDir = await realpath(packageDir).catch(() => packageDir);
      const manifestPath = path.join(resolvedDir, "package.json");
      try {
        await access(manifestPath);
        manifestPaths.add(manifestPath);
      } catch {
        continue;
      }
    }
  }

  async function walk(currentDir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name === ".bin") continue;
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "@paperclipai") {
          await collectScopePackages(entryPath);
          continue;
        }
        await walk(entryPath);
      }
    }
  }

  await walk(nodeModulesRoot);
  return [...manifestPaths].sort();
}

export async function normalizeStagedWorkspacePackages(stageDir: string): Promise<number> {
  const manifestPaths = await collectPaperclipManifestPaths(path.join(stageDir, "node_modules"));
  let rewrittenCount = 0;

  for (const manifestPath of manifestPaths) {
    const originalText = await readFile(manifestPath, "utf8");
    const originalManifest = JSON.parse(originalText) as PackageManifest;
    const runtimeManifest = toRuntimePackageManifest(originalManifest);

    if (runtimeManifest === originalManifest) continue;

    const nextText = `${JSON.stringify(runtimeManifest, null, 2)}\n`;
    if (nextText === originalText) continue;

    await writeFile(manifestPath, nextText);
    rewrittenCount += 1;
  }

  return rewrittenCount;
}
