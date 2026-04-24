import fs from "node:fs/promises";
import path from "node:path";
import type {
  AgentMemoryOverview,
  CompanyMemoryOverview,
  MemoryFileDetail,
  MemoryFileSummary,
  MemoryHealthStatus,
  MemoryMigrationResult,
} from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { agentInstructionsService } from "./agent-instructions.js";

const HOT_MEMORY_PATH = "hot/MEMORY.md";
const LEGACY_MEMORY_PATH = "MEMORY.md";
const WARNING_BYTES = 6 * 1024;
const TARGET_BYTES = 8 * 1024;
const HARD_LIMIT_BYTES = 16 * 1024;
const PREVIEW_BYTES = 64 * 1024;

type AgentLike = {
  id: string;
  companyId: string;
  name: string;
  role?: string | null;
  adapterConfig: unknown;
};

function normalizeRelativeFilePath(candidatePath: string): string {
  const normalized = path.posix.normalize(candidatePath.replaceAll("\\", "/")).replace(/^\/+/, "");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw unprocessable("Memory file path must stay within the memory root");
  }
  return normalized;
}

function resolvePathWithinRoot(rootPath: string, relativePath: string): string {
  const normalizedRelativePath = normalizeRelativeFilePath(relativePath);
  const absoluteRoot = path.resolve(rootPath);
  const absolutePath = path.resolve(absoluteRoot, normalizedRelativePath);
  const relativeToRoot = path.relative(absoluteRoot, absolutePath);
  if (relativeToRoot === ".." || relativeToRoot.startsWith(`..${path.sep}`)) {
    throw unprocessable("Memory file path must stay within the memory root");
  }
  return absolutePath;
}

function inferLanguage(relativePath: string): string {
  const lower = relativePath.toLowerCase();
  if (lower.endsWith(".md")) return "markdown";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml";
  return "text";
}

function isMarkdown(relativePath: string) {
  return relativePath.toLowerCase().endsWith(".md");
}

function agentMemoryRoot(agent: AgentLike): string {
  return path.resolve(resolvePaperclipInstanceRoot(), "companies", agent.companyId, "agents", agent.id, "memory");
}

function companyMemoryRoot(companyId: string): string {
  return path.resolve(resolvePaperclipInstanceRoot(), "companies", companyId, "memory");
}

async function statIfExists(targetPath: string) {
  return fs.stat(targetPath).catch(() => null);
}

async function readIfExists(targetPath: string) {
  return fs.readFile(targetPath, "utf8").catch(() => null);
}

async function writeFileIfMissing(rootPath: string, relativePath: string, content: string) {
  const absolutePath = resolvePathWithinRoot(rootPath, relativePath);
  const stat = await statIfExists(absolutePath);
  if (stat?.isFile()) return false;
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content, "utf8");
  return true;
}

async function listFilesRecursive(rootPath: string): Promise<string[]> {
  const output: string[] = [];
  async function walk(currentPath: string, relativeDir: string) {
    const entries = await fs.readdir(currentPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name === ".DS_Store" || entry.name === "Thumbs.db") continue;
      const absolutePath = path.join(currentPath, entry.name);
      const relativePath = normalizeRelativeFilePath(relativeDir ? path.posix.join(relativeDir, entry.name) : entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath, relativePath);
      } else if (entry.isFile()) {
        output.push(relativePath);
      }
    }
  }
  await walk(rootPath, "");
  return output.sort((left, right) => left.localeCompare(right));
}

function layerForPath(relativePath: string) {
  const first = relativePath.split("/")[0] ?? "";
  return first.includes(".") || !first ? "root" : first;
}

function statusForHotBytes(bytes: number): MemoryHealthStatus {
  if (bytes > TARGET_BYTES) return "over_limit";
  if (bytes >= WARNING_BYTES) return "warning";
  return "ok";
}

function defaultAgentIndex(agent: AgentLike) {
  return [
    "# Agent memory",
    "",
    "Use this directory for durable memory that should survive sessions without bloating the prompt.",
    "",
    "- `hot/MEMORY.md`: compact facts needed in every fresh session.",
    "- `daily/YYYY-MM-DD.md`: append-only daily continuity notes.",
    "- `operations/*.md`: recurring lessons with current summary above `---` and evidence below.",
    "- `archive/`: immutable snapshots created before compaction or migration.",
    "",
    "Routing rules:",
    "",
    "- Put agent behavior preferences and high-value recurring lessons in hot memory.",
    "- Put tool quirks, adapter behavior, and repo lessons in operations memory.",
    "- Put one-day observations in daily memory.",
    "- Put issue-specific state in issue docs/comments, not memory.",
    "- Put shared company knowledge in the company memory root.",
    "- Never dump full logs, transcripts, or large pasted output into hot memory.",
    "",
    `Agent: ${agent.name}`,
    "",
  ].join("\n");
}

function defaultHotMemory(agent: AgentLike) {
  return [
    "# MEMORY.md",
    "",
    "Compact hot memory for this agent. Keep this under 8 KB.",
    "",
    "- Store only always-relevant operating notes, preferences, tool quirks, and recurring lessons.",
    "- Move details to `memory/daily/` or `memory/operations/`.",
    `- Agent: ${agent.name}`,
    "",
  ].join("\n");
}

function defaultOperationsGeneral() {
  return [
    "# General operations",
    "",
    "## Current Summary",
    "",
    "No synthesized operating lessons yet.",
    "",
    "## Rules / Lessons",
    "",
    "- Keep hot memory compact.",
    "",
    "---",
    "",
    "## Timeline",
    "",
  ].join("\n");
}

function defaultCompanyResolver(companyId: string) {
  return [
    "# Company memory resolver",
    "",
    "Use this company memory root for knowledge that should be shared across agents in this company.",
    "",
    "Primary homes:",
    "",
    "- `projects/`: project context and durable project notes.",
    "- `decisions/`: company or product decisions worth reusing.",
    "- `systems/`: technical systems, architecture, and runtime conventions.",
    "- `playbooks/`: repeatable workflows and operating procedures.",
    "- `people/`: company-relevant people notes.",
    "- `archive/`: immutable snapshots and retired memory.",
    "",
    "Do not store issue-specific execution state here unless it has become reusable company knowledge.",
    "",
    `Company: ${companyId}`,
    "",
  ].join("\n");
}

function defaultCompanyIndex(companyId: string) {
  return [
    "# Company memory",
    "",
    "Shared durable knowledge for this Paperclip company.",
    "",
    "Read `RESOLVER.md` before creating new pages.",
    "",
    `Company: ${companyId}`,
    "",
  ].join("\n");
}

function migrationHotMemory(archivePath: string) {
  return [
    "# MEMORY.md",
    "",
    "This hot memory was compacted during layered-memory migration.",
    "",
    "- Keep this file under 8 KB.",
    "- Use `memory/daily/` for raw continuity notes.",
    "- Use `memory/operations/` for recurring lessons.",
    `- Pre-migration memory archive: \`${archivePath}\``,
    "",
  ].join("\n");
}

function migrationDailyNote(date: string, archivePath: string, oldBytes: number, newHotBytes: number) {
  return [
    `# ${date}`,
    "",
    "- Migrated oversized hot memory into layered memory.",
    `- Archived original MEMORY.md at \`${archivePath}\` (${oldBytes} bytes).`,
    `- Replaced hot memory with compact migration pointer (${newHotBytes} bytes).`,
    "",
  ].join("\n");
}

function timestampForArchive(now = new Date()) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
}

function dateStamp(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

async function fileSummary(rootPath: string, relativePath: string): Promise<MemoryFileSummary> {
  const absolutePath = resolvePathWithinRoot(rootPath, relativePath);
  const stat = await fs.stat(absolutePath);
  const normalized = normalizeRelativeFilePath(relativePath);
  return {
    path: normalized,
    layer: layerForPath(normalized),
    size: stat.size,
    language: inferLanguage(normalized),
    markdown: isMarkdown(normalized),
    editable: !normalized.startsWith("archive/"),
    archived: normalized.startsWith("archive/"),
  };
}

async function ensureAgentDefaults(agent: AgentLike) {
  const rootPath = agentMemoryRoot(agent);
  await fs.mkdir(rootPath, { recursive: true });
  await writeFileIfMissing(rootPath, "index.md", defaultAgentIndex(agent));
  await writeFileIfMissing(rootPath, HOT_MEMORY_PATH, defaultHotMemory(agent));
  await fs.mkdir(resolvePathWithinRoot(rootPath, "daily"), { recursive: true });
  await fs.mkdir(resolvePathWithinRoot(rootPath, "operations"), { recursive: true });
  await fs.mkdir(resolvePathWithinRoot(rootPath, "archive"), { recursive: true });
  return { rootPath };
}

async function ensureCompanyDefaults(companyId: string) {
  const rootPath = companyMemoryRoot(companyId);
  await fs.mkdir(rootPath, { recursive: true });
  await writeFileIfMissing(rootPath, "RESOLVER.md", defaultCompanyResolver(companyId));
  await writeFileIfMissing(rootPath, "index.md", defaultCompanyIndex(companyId));
  for (const dir of ["projects", "decisions", "systems", "playbooks", "people", "archive"]) {
    await fs.mkdir(resolvePathWithinRoot(rootPath, dir), { recursive: true });
  }
  return { rootPath };
}

async function readMemoryFile(rootPath: string, relativePath: string): Promise<MemoryFileDetail> {
  const normalized = normalizeRelativeFilePath(relativePath);
  const absolutePath = resolvePathWithinRoot(rootPath, normalized);
  const stat = await statIfExists(absolutePath);
  if (!stat?.isFile()) throw notFound("Memory file not found");
  const content = await fs.readFile(absolutePath, "utf8");
  const truncated = stat.size > PREVIEW_BYTES;
  return {
    ...(await fileSummary(rootPath, normalized)),
    content: truncated ? content.slice(0, PREVIEW_BYTES) : content,
    truncated,
    fullSize: stat.size,
  };
}

export function memoryService() {
  const instructions = agentInstructionsService();

  async function getAgentMemory(agent: AgentLike): Promise<AgentMemoryOverview> {
    const { rootPath } = await ensureAgentDefaults(agent);
    const hotPath = resolvePathWithinRoot(rootPath, HOT_MEMORY_PATH);
    const hotStat = await statIfExists(hotPath);
    const hotBytes = hotStat?.isFile() ? hotStat.size : 0;
    const bundle = await instructions.getBundle(agent).catch(() => null);
    const legacyBundleMemoryPath = bundle?.rootPath ? path.join(bundle.rootPath, LEGACY_MEMORY_PATH) : null;
    const files = await Promise.all((await listFilesRecursive(rootPath)).map((relativePath) => fileSummary(rootPath, relativePath)));
    const warnings: string[] = [];
    if (hotBytes >= WARNING_BYTES) warnings.push(`Hot memory is ${hotBytes} bytes; keep it under ${TARGET_BYTES} bytes.`);
    if (!legacyBundleMemoryPath) warnings.push("No managed instructions MEMORY.md mirror is currently configured.");
    return {
      agentId: agent.id,
      companyId: agent.companyId,
      rootPath,
      hotPath,
      legacyBundleMemoryPath,
      hotBytes,
      warningBytes: WARNING_BYTES,
      targetBytes: TARGET_BYTES,
      hardLimitBytes: HARD_LIMIT_BYTES,
      status: statusForHotBytes(hotBytes),
      files,
      warnings,
    };
  }

  async function readAgentMemoryFile(agent: AgentLike, relativePath: string) {
    const { rootPath } = await ensureAgentDefaults(agent);
    return readMemoryFile(rootPath, relativePath);
  }

  async function writeAgentMemoryFile(agent: AgentLike, relativePath: string, content: string) {
    const normalized = normalizeRelativeFilePath(relativePath);
    if (normalized.startsWith("archive/")) throw unprocessable("Archived memory files are immutable");
    if (normalized === HOT_MEMORY_PATH && Buffer.byteLength(content, "utf8") > HARD_LIMIT_BYTES) {
      throw unprocessable("Hot memory exceeds the hard limit; use migrate-hot or move detail to deeper memory files");
    }
    const { rootPath } = await ensureAgentDefaults(agent);
    const absolutePath = resolvePathWithinRoot(rootPath, normalized);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, "utf8");

    let adapterConfig: Record<string, unknown> | null = null;
    if (normalized === HOT_MEMORY_PATH) {
      const mirrored = await instructions.writeFile(agent, LEGACY_MEMORY_PATH, content, { resetMemory: true });
      adapterConfig = mirrored.adapterConfig;
    }

    return {
      file: await readMemoryFile(rootPath, normalized),
      overview: await getAgentMemory(adapterConfig ? { ...agent, adapterConfig } : agent),
      adapterConfig,
    };
  }

  async function migrateAgentHotMemory(agent: AgentLike): Promise<{
    result: MemoryMigrationResult;
    adapterConfig: Record<string, unknown> | null;
  }> {
    const { rootPath } = await ensureAgentDefaults(agent);
    const bundle = await instructions.getBundle(agent).catch(() => null);
    const legacyContent = bundle?.rootPath ? await readIfExists(path.join(bundle.rootPath, LEGACY_MEMORY_PATH)) : null;
    const hotContent = await readIfExists(resolvePathWithinRoot(rootPath, HOT_MEMORY_PATH));
    const sourceContent = legacyContent ?? hotContent ?? "";
    if (!sourceContent.trim()) throw notFound("No hot memory content found to migrate");

    const now = new Date();
    const archivePath = `archive/${timestampForArchive(now)}-MEMORY.md`;
    const archiveAbsolutePath = resolvePathWithinRoot(rootPath, archivePath);
    await fs.mkdir(path.dirname(archiveAbsolutePath), { recursive: true });
    await fs.writeFile(archiveAbsolutePath, sourceContent, "utf8");

    const oldBytes = Buffer.byteLength(sourceContent, "utf8");
    const nextHot = migrationHotMemory(archivePath);
    await fs.writeFile(resolvePathWithinRoot(rootPath, HOT_MEMORY_PATH), nextHot, "utf8");
    const newHotBytes = Buffer.byteLength(nextHot, "utf8");
    const dayPath = `daily/${dateStamp(now)}.md`;
    await writeFileIfMissing(rootPath, dayPath, migrationDailyNote(dateStamp(now), archivePath, oldBytes, newHotBytes));
    await writeFileIfMissing(rootPath, "operations/general.md", defaultOperationsGeneral());

    const mirrored = await instructions.writeFile(agent, LEGACY_MEMORY_PATH, nextHot, { resetMemory: true });
    const nextAgent = { ...agent, adapterConfig: mirrored.adapterConfig };
    return {
      adapterConfig: mirrored.adapterConfig,
      result: {
        archivePath,
        oldBytes,
        newHotBytes,
        createdFiles: [archivePath, dayPath, "operations/general.md"],
        updatedFiles: [HOT_MEMORY_PATH, LEGACY_MEMORY_PATH],
        overview: await getAgentMemory(nextAgent),
      },
    };
  }

  async function getCompanyMemory(companyId: string): Promise<CompanyMemoryOverview> {
    const { rootPath } = await ensureCompanyDefaults(companyId);
    const files = await Promise.all((await listFilesRecursive(rootPath)).map((relativePath) => fileSummary(rootPath, relativePath)));
    return { companyId, rootPath, files, warnings: [] };
  }

  async function readCompanyMemoryFile(companyId: string, relativePath: string) {
    const { rootPath } = await ensureCompanyDefaults(companyId);
    return readMemoryFile(rootPath, relativePath);
  }

  async function writeCompanyMemoryFile(companyId: string, relativePath: string, content: string) {
    const normalized = normalizeRelativeFilePath(relativePath);
    if (normalized.startsWith("archive/")) throw unprocessable("Archived memory files are immutable");
    const { rootPath } = await ensureCompanyDefaults(companyId);
    const absolutePath = resolvePathWithinRoot(rootPath, normalized);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, "utf8");
    return {
      file: await readMemoryFile(rootPath, normalized),
      overview: await getCompanyMemory(companyId),
    };
  }

  return {
    getAgentMemory,
    readAgentMemoryFile,
    writeAgentMemoryFile,
    migrateAgentHotMemory,
    getCompanyMemory,
    readCompanyMemoryFile,
    writeCompanyMemoryFile,
  };
}
