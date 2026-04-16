import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export type DesktopUiBundleVerificationMode = "staged" | "package" | "dist";

export type DesktopUiBundleVerificationPaths = {
  mode: DesktopUiBundleVerificationMode;
  sourceDir: string;
  targetDir: string;
  targetLabel: string;
};

export type DesktopUiBundleDiff = {
  sourceFileCount: number;
  targetFileCount: number;
  missingInTarget: string[];
  extraInTarget: string[];
  mismatched: string[];
};

function normalizeRelativePath(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join("/");
}

async function collectFileHashes(root: string): Promise<Map<string, string>> {
  if (!existsSync(root)) {
    throw new Error(`UI bundle directory not found at ${root}.`);
  }

  const files = new Map<string, string>();

  async function visit(currentDir: string): Promise<void> {
    const entries = await readdir(currentDir, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;

      const relativePath = normalizeRelativePath(root, entryPath);
      const contents = await readFile(entryPath);
      const hash = createHash("sha256").update(contents).digest("hex");
      files.set(relativePath, hash);
    }
  }

  await visit(root);
  return files;
}

function compareFileSets(sourceFiles: Map<string, string>, targetFiles: Map<string, string>): DesktopUiBundleDiff {
  const missingInTarget: string[] = [];
  const extraInTarget: string[] = [];
  const mismatched: string[] = [];

  for (const [relativePath, sourceHash] of sourceFiles.entries()) {
    const targetHash = targetFiles.get(relativePath);
    if (targetHash == null) {
      missingInTarget.push(relativePath);
      continue;
    }
    if (targetHash !== sourceHash) {
      mismatched.push(relativePath);
    }
  }

  for (const relativePath of targetFiles.keys()) {
    if (!sourceFiles.has(relativePath)) {
      extraInTarget.push(relativePath);
    }
  }

  missingInTarget.sort();
  extraInTarget.sort();
  mismatched.sort();

  return {
    sourceFileCount: sourceFiles.size,
    targetFileCount: targetFiles.size,
    missingInTarget,
    extraInTarget,
    mismatched,
  };
}

function formatPathList(label: string, paths: string[], limit = 10): string | null {
  if (paths.length === 0) return null;
  const lines = [`${label} (${paths.length}):`];
  for (const relativePath of paths.slice(0, limit)) {
    lines.push(`  - ${relativePath}`);
  }
  if (paths.length > limit) {
    lines.push(`  - ... ${paths.length - limit} more`);
  }
  return lines.join("\n");
}

export async function diffDesktopUiBundle(paths: DesktopUiBundleVerificationPaths): Promise<DesktopUiBundleDiff> {
  const [sourceFiles, targetFiles] = await Promise.all([
    collectFileHashes(paths.sourceDir),
    collectFileHashes(paths.targetDir),
  ]);

  return compareFileSets(sourceFiles, targetFiles);
}

export function formatDesktopUiBundleDiff(
  paths: DesktopUiBundleVerificationPaths,
  diff: DesktopUiBundleDiff,
): string {
  const sections = [
    `Desktop UI bundle verification failed for ${paths.mode}.`,
    `Source: ${paths.sourceDir}`,
    `Target (${paths.targetLabel}): ${paths.targetDir}`,
    `Source files: ${diff.sourceFileCount}`,
    `Target files: ${diff.targetFileCount}`,
  ];

  for (const section of [
    formatPathList("Missing in target", diff.missingInTarget),
    formatPathList("Extra in target", diff.extraInTarget),
    formatPathList("Mismatched content", diff.mismatched),
  ]) {
    if (section) sections.push(section);
  }

  return sections.join("\n");
}

export async function verifyDesktopUiBundle(paths: DesktopUiBundleVerificationPaths): Promise<DesktopUiBundleDiff> {
  let diff: DesktopUiBundleDiff;
  try {
    diff = await diffDesktopUiBundle(paths);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      [
        `Desktop UI bundle verification failed for ${paths.mode}.`,
        `Source: ${paths.sourceDir}`,
        `Target (${paths.targetLabel}): ${paths.targetDir}`,
        message,
      ].join("\n"),
    );
  }

  if (
    diff.missingInTarget.length > 0
    || diff.extraInTarget.length > 0
    || diff.mismatched.length > 0
  ) {
    throw new Error(formatDesktopUiBundleDiff(paths, diff));
  }

  return diff;
}

export function resolveDesktopUiBundleVerificationPaths(input: {
  repoRoot: string;
  desktopDir: string;
  mode: DesktopUiBundleVerificationMode;
}): DesktopUiBundleVerificationPaths {
  const sourceDir = path.resolve(input.repoRoot, "server", "ui-dist");

  switch (input.mode) {
    case "staged":
      return {
        mode: input.mode,
        sourceDir,
        targetDir: path.resolve(input.desktopDir, ".stage", "server", "ui-dist"),
        targetLabel: "desktop staged runtime",
      };
    case "package":
      return {
        mode: input.mode,
        sourceDir,
        targetDir: path.resolve(
          input.desktopDir,
          "dist",
          "package",
          "mac-arm64",
          "Paperclip.app",
          "Contents",
          "Resources",
          "server",
          "ui-dist",
        ),
        targetLabel: "packaged desktop app",
      };
    case "dist":
      return {
        mode: input.mode,
        sourceDir,
        targetDir: path.resolve(
          input.desktopDir,
          "dist",
          "release",
          "raw",
          "mac-arm64",
          "Paperclip.app",
          "Contents",
          "Resources",
          "server",
          "ui-dist",
        ),
        targetLabel: "dist raw desktop app bundle",
      };
  }
}
