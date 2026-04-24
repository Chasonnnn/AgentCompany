#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path, { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DOC_FILE_NAMES = new Set(["AGENTS.md", "TOOLS.md"]);
const SKIP_DIR_NAMES = new Set([".git", "node_modules", ".stage", "dist"]);
const HEADING_RE = /^(#{1,2})\s+(.+?)\s*$/;
const NUMBERED_HEADING_RE = /^(\d+(?:\.\d+)*)\.\s+/;

function getRepoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
}

function collectManagedDocs(rootDir, currentDir = rootDir, files = []) {
  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      collectManagedDocs(rootDir, path.join(currentDir, entry.name), files);
      continue;
    }

    if (!entry.isFile() || !DOC_FILE_NAMES.has(entry.name)) continue;
    files.push(path.join(currentDir, entry.name));
  }

  return files;
}

function normalizeHeading(rawHeading) {
  return rawHeading.trim().replace(/\s+/g, " ");
}

function findDuplicateHeadings(filePath, repoRoot) {
  const relativePath = path.relative(repoRoot, filePath) || path.basename(filePath);
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  const seenHeadingText = new Map();
  const seenSectionNumbers = new Map();
  const errors = [];

  lines.forEach((line, index) => {
    const match = line.match(HEADING_RE);
    if (!match) return;

    const headingText = normalizeHeading(match[2]);
    const lineNumber = index + 1;
    const firstHeadingMatch = seenHeadingText.get(headingText);

    if (firstHeadingMatch) {
      errors.push(
        `${relativePath}:${lineNumber} duplicates heading "${headingText}" first seen at ` +
          `${relativePath}:${firstHeadingMatch.lineNumber}`,
      );
    } else {
      seenHeadingText.set(headingText, { lineNumber });
    }

    const numberedMatch = headingText.match(NUMBERED_HEADING_RE);
    if (!numberedMatch) return;

    const sectionNumber = numberedMatch[1];
    const firstSectionMatch = seenSectionNumbers.get(sectionNumber);
    if (firstSectionMatch) {
      errors.push(
        `${relativePath}:${lineNumber} reuses section number "${sectionNumber}." first seen at ` +
          `${relativePath}:${firstSectionMatch.lineNumber}`,
      );
      return;
    }

    seenSectionNumbers.set(sectionNumber, { lineNumber });
  });

  return errors;
}

export function runHeadingDuplicateCheck({ repoRoot = getRepoRoot(), log = console.log, error = console.error } = {}) {
  const files = collectManagedDocs(repoRoot)
    .filter((filePath) => statSync(filePath).isFile())
    .sort((left, right) => left.localeCompare(right));

  const errors = files.flatMap((filePath) => findDuplicateHeadings(filePath, repoRoot));

  if (errors.length > 0) {
    error("ERROR: Duplicate H1/H2 headings found in tracked AGENTS.md/TOOLS.md files:\n");
    for (const issue of errors) {
      error(`  ${issue}`);
    }
    return 1;
  }

  log(`  ✓  Checked ${files.length} AGENTS.md/TOOLS.md files for duplicate H1/H2 headings.`);
  return 0;
}

function main() {
  process.exit(runHeadingDuplicateCheck());
}

const isMainModule = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  main();
}
