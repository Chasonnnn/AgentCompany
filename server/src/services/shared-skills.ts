import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { parseDocument } from "yaml";
import {
  companySkills,
  heartbeatRuns,
  sharedSkillProposalComments,
  sharedSkillProposals,
  sharedSkills,
} from "@paperclipai/db";
import { normalizeAgentUrlKey } from "@paperclipai/shared";
import type {
  CompanySkillCompatibilityMetadata,
  CompanySkillFileInventoryEntry,
  CompanySkillVerificationState,
  GlobalSkillCatalogItem,
  GlobalSkillCatalogSourceRoot,
  SharedSkill,
  SharedSkillMirrorSyncRequest,
  SharedSkillMirrorSyncResult,
  SharedSkillProposal,
  SharedSkillProposalComment,
  SharedSkillProposalCreateRequest,
  SharedSkillProposalPayload,
  SharedSkillProposalVerificationResults,
  SharedSkillProposalVerificationUpdateRequest,
  SharedSkillRuntimeContext,
  SharedSkillSourceDriftState,
  SharedSkillMirrorState,
  SkillVerificationMetadata,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

type SharedSkillRow = typeof sharedSkills.$inferSelect;
type SharedSkillProposalRow = typeof sharedSkillProposals.$inferSelect;
type SharedSkillProposalCommentRow = typeof sharedSkillProposalComments.$inferSelect;

type SkillSourceMeta = {
  owner?: string;
  repo?: string;
  hostname?: string;
  sourceKind?: string;
  skillKey?: string;
  sharedSkillId?: string;
  sharedSkillKey?: string;
  sharedMirrorState?: string;
  sharedSourceDriftState?: string;
};

type DiscoveredSharedSkill = {
  sourceRoot: GlobalSkillCatalogSourceRoot;
  sourcePath: string;
  key: string;
  slug: string;
  name: string;
  description: string | null;
  markdown: string;
  fileInventory: CompanySkillFileInventoryEntry[];
  trustLevel: SharedSkill["trustLevel"];
  compatibility: SharedSkill["compatibility"];
  metadata: Record<string, unknown> | null;
  sourceDigest: string;
};

type ProposalActor = {
  actorType: "agent" | "user";
  actorId: string;
  companyId: string | null;
  runId: string | null;
};

const GLOBAL_SOURCE_ROOTS: Array<{ sourceRoot: GlobalSkillCatalogSourceRoot; relativeRoot: string }> = [
  { sourceRoot: "agents", relativeRoot: ".agents/skills" },
  { sourceRoot: "codex", relativeRoot: ".codex/skills" },
  { sourceRoot: "claude", relativeRoot: ".claude/skills" },
];
const OPEN_PROPOSAL_STATUSES = ["pending", "revision_requested"] as const;

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePortablePath(input: string) {
  const parts: string[] = [];
  for (const segment of input.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (parts.length > 0) parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join("/");
}

function normalizeSkillSlug(value: string | null | undefined) {
  return value ? normalizeAgentUrlKey(value) ?? null : null;
}

function normalizeSkillKey(value: string | null | undefined) {
  if (!value) return null;
  const segments = value
    .split("/")
    .map((segment) => normalizeSkillSlug(segment))
    .filter((segment): segment is string => Boolean(segment));
  return segments.length > 0 ? segments.join("/") : null;
}

function hashValue(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 10);
}

function digestString(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeVerificationState(value: unknown): CompanySkillVerificationState {
  return value === "pending" || value === "verified" || value === "failed" ? value : "verified";
}

function emptyCompatibilityMetadata(): CompanySkillCompatibilityMetadata {
  return {
    paperclipApiRange: null,
    minAdapterVersion: null,
    requiredTools: [],
    requiredCapabilities: [],
  };
}

function readCompatibilityMetadata(value: unknown): CompanySkillCompatibilityMetadata | null {
  if (!isPlainRecord(value)) return null;
  return {
    paperclipApiRange: asString(value.paperclipApiRange),
    minAdapterVersion: asString(value.minAdapterVersion),
    requiredTools: Array.isArray(value.requiredTools)
      ? value.requiredTools.flatMap((entry) => asString(entry) ?? [])
      : [],
    requiredCapabilities: Array.isArray(value.requiredCapabilities)
      ? value.requiredCapabilities.flatMap((entry) => asString(entry) ?? [])
      : [],
  };
}

function buildSharedSkillRuntimeName(key: string, slug: string) {
  if (key.startsWith("paperclipai/paperclip/")) return slug;
  return `${slug}--${hashValue(key)}`;
}

function resolveGlobalSkillCatalogHome() {
  const envHome = process.env.HOME?.trim();
  if (envHome) return path.resolve(envHome);
  return path.resolve(os.homedir());
}

function resolveSharedSkillMirrorRoot() {
  return path.resolve(resolvePaperclipInstanceRoot(), "shared-skills");
}

function resolveSharedSkillMirrorDir(input: { key: string; slug: string }) {
  return path.resolve(resolveSharedSkillMirrorRoot(), buildSharedSkillRuntimeName(input.key, input.slug));
}

function classifyInventoryKind(relativePath: string): CompanySkillFileInventoryEntry["kind"] {
  const normalized = normalizePortablePath(relativePath);
  const fileName = path.posix.basename(normalized).toLowerCase();
  if (fileName === "skill.md") return "skill";
  if (normalized.startsWith("references/")) return "reference";
  if (normalized.startsWith("scripts/")) return "script";
  if (normalized.startsWith("assets/")) return "asset";
  if (fileName.endsWith(".md")) return "markdown";
  return "other";
}

function deriveTrustLevel(fileInventory: CompanySkillFileInventoryEntry[]): SharedSkill["trustLevel"] {
  if (fileInventory.some((entry) => entry.kind === "script")) return "scripts_executables";
  if (fileInventory.some((entry) => entry.kind === "asset" || entry.kind === "reference")) return "assets";
  return "markdown_only";
}

function parseYamlFrontmatter(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  const document = parseDocument(raw, {
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw unprocessable(`Invalid shared skill frontmatter: ${document.errors[0]?.message ?? "failed to parse YAML"}`);
  }
  const parsed = document.toJSON();
  return isPlainRecord(parsed) ? parsed : {};
}

function parseFrontmatterMarkdown(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { frontmatter: {}, body: normalized.trim() };
  }
  const closing = normalized.indexOf("\n---\n", 4);
  if (closing < 0) {
    return { frontmatter: {}, body: normalized.trim() };
  }
  const frontmatterRaw = normalized.slice(4, closing).trim();
  const body = normalized.slice(closing + 5).trim();
  return { frontmatter: parseYamlFrontmatter(frontmatterRaw), body };
}

async function statPath(targetPath: string) {
  return fs.stat(targetPath).catch(() => null);
}

async function walkLocalFiles(rootDir: string, currentDir: string, out: string[]) {
  const entries = await fs.readdir(currentDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const absolutePath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await walkLocalFiles(rootDir, absolutePath, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const relativePath = normalizePortablePath(path.relative(rootDir, absolutePath));
    if (relativePath) out.push(relativePath);
  }
}

async function collectLocalSkillInventory(skillDir: string): Promise<CompanySkillFileInventoryEntry[]> {
  const skillFilePath = path.join(skillDir, "SKILL.md");
  const skillFileStat = await statPath(skillFilePath);
  if (!skillFileStat?.isFile()) {
    throw unprocessable(`No SKILL.md file was found in ${skillDir}.`);
  }

  const discoveredFiles: string[] = [];
  await walkLocalFiles(skillDir, skillDir, discoveredFiles);
  return Array.from(new Set(["SKILL.md", ...discoveredFiles]))
    .map((relativePath) => ({
      path: normalizePortablePath(relativePath),
      kind: classifyInventoryKind(relativePath),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function readSkillMeta(metadata: Record<string, unknown> | null): SkillSourceMeta {
  return isPlainRecord(metadata) ? metadata as SkillSourceMeta : {};
}

function readCanonicalSkillKey(
  frontmatter: Record<string, unknown>,
  metadata: Record<string, unknown> | null,
) {
  const direct = normalizeSkillKey(
    asString(frontmatter.key)
    ?? asString(frontmatter.skillKey)
    ?? asString(metadata?.skillKey)
    ?? asString(metadata?.canonicalKey)
    ?? asString(metadata?.paperclipSkillKey),
  );
  if (direct) return direct;
  const paperclip = isPlainRecord(metadata?.paperclip) ? metadata.paperclip as Record<string, unknown> : null;
  return normalizeSkillKey(asString(paperclip?.skillKey) ?? asString(paperclip?.key));
}

function buildSharedSkillKey(
  sourceRoot: GlobalSkillCatalogSourceRoot,
  sourcePath: string,
  slug: string,
  frontmatter: Record<string, unknown>,
  metadata: Record<string, unknown> | null,
) {
  const explicitKey = readCanonicalSkillKey(frontmatter, metadata);
  if (explicitKey) return explicitKey;
  const meta = readSkillMeta(metadata);
  const owner = normalizeSkillSlug(asString(meta.owner));
  const repo = normalizeSkillSlug(asString(meta.repo));
  if (owner && repo) return `${owner}/${repo}/${slug}`;
  return `global/${sourceRoot}/${hashValue(sourcePath)}/${slug}`;
}

async function readSharedSkillFromDirectory(
  sourceRoot: GlobalSkillCatalogSourceRoot,
  sourcePath: string,
): Promise<DiscoveredSharedSkill> {
  const skillDir = path.resolve(sourcePath);
  const markdown = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8");
  const parsed = parseFrontmatterMarkdown(markdown);
  const slug = normalizeSkillSlug(asString(parsed.frontmatter.slug) ?? path.basename(skillDir)) ?? "skill";
  const parsedMetadata = isPlainRecord(parsed.frontmatter.metadata) ? parsed.frontmatter.metadata : null;
  const fileInventory = await collectLocalSkillInventory(skillDir);
  const sourceDigest = await digestDirectory(skillDir, fileInventory);
  const metadata = {
    ...(parsedMetadata ?? {}),
    sourceKind: "global_catalog",
    catalogSourceRoot: sourceRoot,
    catalogSourcePath: skillDir,
  };
  return {
    sourceRoot,
    sourcePath: skillDir,
    key: buildSharedSkillKey(sourceRoot, skillDir, slug, parsed.frontmatter, metadata),
    slug,
    name: asString(parsed.frontmatter.name) ?? slug,
    description: asString(parsed.frontmatter.description),
    markdown,
    fileInventory,
    trustLevel: deriveTrustLevel(fileInventory),
    compatibility: "compatible",
    metadata,
    sourceDigest,
  };
}

async function digestDirectory(skillDir: string, fileInventory: CompanySkillFileInventoryEntry[]) {
  const hash = createHash("sha256");
  for (const entry of [...fileInventory].sort((left, right) => left.path.localeCompare(right.path))) {
    const absolutePath = path.resolve(skillDir, entry.path);
    const content = await fs.readFile(absolutePath);
    hash.update(`${entry.path}\n`);
    hash.update(content);
    hash.update("\n");
  }
  return hash.digest("hex");
}

async function copySkillDirectory(sourceDir: string, targetDir: string, fileInventory: CompanySkillFileInventoryEntry[]) {
  await fs.rm(targetDir, { recursive: true, force: true });
  await fs.mkdir(targetDir, { recursive: true });
  for (const entry of fileInventory) {
    const sourcePath = path.resolve(sourceDir, entry.path);
    const targetPath = path.resolve(targetDir, entry.path);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.copyFile(sourcePath, targetPath);
  }
}

async function readMirrorSkillFromPath(row: SharedSkillRow): Promise<DiscoveredSharedSkill> {
  const mirrorDir = resolveSharedSkillMirrorDir({ key: row.key, slug: row.slug });
  const fileInventory = await collectLocalSkillInventory(mirrorDir);
  const markdown = await fs.readFile(path.join(mirrorDir, "SKILL.md"), "utf8");
  const parsed = parseFrontmatterMarkdown(markdown);
  return {
    sourceRoot: row.sourceRoot as GlobalSkillCatalogSourceRoot,
    sourcePath: row.sourcePath,
    key: row.key,
    slug: normalizeSkillSlug(asString(parsed.frontmatter.slug) ?? row.slug) ?? row.slug,
    name: asString(parsed.frontmatter.name) ?? row.name,
    description: asString(parsed.frontmatter.description) ?? row.description,
    markdown,
    fileInventory,
    trustLevel: deriveTrustLevel(fileInventory),
    compatibility: "compatible",
    metadata: isPlainRecord(row.metadata) ? row.metadata : null,
    sourceDigest: await digestDirectory(mirrorDir, fileInventory),
  };
}

function serializeFileInventory(fileInventory: CompanySkillFileInventoryEntry[]) {
  return fileInventory.map((entry) => ({
    path: entry.path,
    kind: entry.kind,
    sha256: entry.sha256 ?? null,
  }));
}

function toSharedSkill(row: SharedSkillRow): SharedSkill {
  return {
    id: row.id,
    key: row.key,
    slug: row.slug,
    name: row.name,
    description: row.description ?? null,
    markdown: row.markdown,
    fileInventory: Array.isArray(row.fileInventory)
      ? row.fileInventory.flatMap((entry) => {
        if (!isPlainRecord(entry)) return [];
        return [{
          path: String(entry.path ?? ""),
          kind: String(entry.kind ?? "other") as CompanySkillFileInventoryEntry["kind"],
          sha256: asString(entry.sha256),
        }];
      })
      : [],
    trustLevel: row.trustLevel as SharedSkill["trustLevel"],
    compatibility: row.compatibility as SharedSkill["compatibility"],
    sourceRoot: row.sourceRoot as GlobalSkillCatalogSourceRoot,
    sourcePath: row.sourcePath,
    sourceDigest: row.sourceDigest ?? null,
    lastMirroredSourceDigest: row.lastMirroredSourceDigest ?? null,
    mirrorDigest: row.mirrorDigest ?? null,
    lastAppliedMirrorDigest: row.lastAppliedMirrorDigest ?? null,
    mirrorState: row.mirrorState as SharedSkillMirrorState,
    sourceDriftState: row.sourceDriftState as SharedSkillSourceDriftState,
    metadata: isPlainRecord(row.metadata) ? row.metadata : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toProposal(row: SharedSkillProposalRow): SharedSkillProposal {
  return {
    id: row.id,
    sharedSkillId: row.sharedSkillId,
    companyId: row.companyId ?? null,
    issueId: row.issueId ?? null,
    runId: row.runId ?? null,
    proposedByAgentId: row.proposedByAgentId ?? null,
    proposedByUserId: row.proposedByUserId ?? null,
    kind: row.kind as SharedSkillProposal["kind"],
    status: row.status as SharedSkillProposal["status"],
    summary: row.summary,
    rationale: row.rationale,
    baseMirrorDigest: row.baseMirrorDigest ?? null,
    baseSourceDigest: row.baseSourceDigest ?? null,
    proposalFingerprint: row.proposalFingerprint,
    payload: isPlainRecord(row.payload)
      ? row.payload as unknown as SharedSkillProposal["payload"]
      : { changes: [], evidence: {} },
    decisionNote: row.decisionNote ?? null,
    decidedByUserId: row.decidedByUserId ?? null,
    decidedAt: row.decidedAt ?? null,
    appliedMirrorDigest: row.appliedMirrorDigest ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toProposalComment(row: SharedSkillProposalCommentRow): SharedSkillProposalComment {
  return {
    id: row.id,
    proposalId: row.proposalId,
    authorAgentId: row.authorAgentId ?? null,
    authorUserId: row.authorUserId ?? null,
    body: row.body,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function buildSharedSkillCompanyMetadata(sharedSkill: SharedSkill, existing: Record<string, unknown> | null) {
  return {
    ...(existing ?? {}),
    sourceKind: "shared_mirror",
    sharedSkillId: sharedSkill.id,
    sharedSkillKey: sharedSkill.key,
    sharedSourceRoot: sharedSkill.sourceRoot,
    sharedSourcePath: sharedSkill.sourcePath,
    sharedMirrorState: sharedSkill.mirrorState,
    sharedSourceDriftState: sharedSkill.sourceDriftState,
  };
}

function normalizeProposalChanges(changes: SharedSkillProposalCreateRequest["changes"]) {
  return [...changes]
    .map((change) => ({
      path: normalizePortablePath(change.path),
      op: change.op,
      ...(typeof change.oldText === "string" ? { oldText: change.oldText } : {}),
      ...(typeof change.newText === "string" ? { newText: change.newText } : {}),
      ...(typeof change.content === "string" ? { content: change.content } : {}),
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function normalizeStringList(values: string[] | null | undefined) {
  return Array.from(
    new Set(
      (values ?? [])
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  ).sort((left, right) => left.localeCompare(right));
}

function normalizeRequiredVerification(
  verification: SkillVerificationMetadata | null | undefined,
): SkillVerificationMetadata | null {
  if (!verification) return null;
  return {
    unitCommands: normalizeStringList(verification.unitCommands),
    integrationCommands: normalizeStringList(verification.integrationCommands),
    promptfooCaseIds: normalizeStringList(verification.promptfooCaseIds),
    architectureScenarioIds: normalizeStringList(verification.architectureScenarioIds),
    smokeChecklist: normalizeStringList(verification.smokeChecklist),
  };
}

function normalizeVerificationResults(
  results: Partial<SharedSkillProposalVerificationResults> | null | undefined,
): SharedSkillProposalVerificationResults {
  return {
    passedUnitCommands: normalizeStringList(results?.passedUnitCommands),
    passedIntegrationCommands: normalizeStringList(results?.passedIntegrationCommands),
    passedPromptfooCaseIds: normalizeStringList(results?.passedPromptfooCaseIds),
    passedArchitectureScenarioIds: normalizeStringList(results?.passedArchitectureScenarioIds),
    completedSmokeChecklist: normalizeStringList(results?.completedSmokeChecklist),
  };
}

function verificationResultsCover(
  required: SkillVerificationMetadata | null | undefined,
  results: SharedSkillProposalVerificationResults | null | undefined,
) {
  if (!required) return true;
  if (!results) return false;
  const containsAll = (requiredItems: string[], actualItems: string[]) =>
    requiredItems.every((item) => actualItems.includes(item));
  return (
    containsAll(required.unitCommands, results.passedUnitCommands)
    && containsAll(required.integrationCommands, results.passedIntegrationCommands)
    && containsAll(required.promptfooCaseIds, results.passedPromptfooCaseIds)
    && containsAll(required.architectureScenarioIds, results.passedArchitectureScenarioIds)
    && containsAll(required.smokeChecklist, results.completedSmokeChecklist)
  );
}

function mergeVerificationResults(
  current: SharedSkillProposalVerificationResults | null | undefined,
  update: SharedSkillProposalVerificationUpdateRequest,
): SharedSkillProposalVerificationResults {
  return normalizeVerificationResults({
    passedUnitCommands: [...(current?.passedUnitCommands ?? []), ...(update.passedUnitCommands ?? [])],
    passedIntegrationCommands: [...(current?.passedIntegrationCommands ?? []), ...(update.passedIntegrationCommands ?? [])],
    passedPromptfooCaseIds: [...(current?.passedPromptfooCaseIds ?? []), ...(update.passedPromptfooCaseIds ?? [])],
    passedArchitectureScenarioIds: [
      ...(current?.passedArchitectureScenarioIds ?? []),
      ...(update.passedArchitectureScenarioIds ?? []),
    ],
    completedSmokeChecklist: [...(current?.completedSmokeChecklist ?? []), ...(update.completedSmokeChecklist ?? [])],
  });
}

function buildProposalFingerprint(sharedSkillId: string, input: SharedSkillProposalCreateRequest) {
  return digestString(JSON.stringify({
    sharedSkillId,
    kind: input.kind,
    baseMirrorDigest: input.baseMirrorDigest ?? null,
    changes: normalizeProposalChanges(input.changes),
  }));
}

async function applyProposalChanges(mirrorDir: string, changes: SharedSkillProposalCreateRequest["changes"]) {
  for (const change of changes) {
    const normalizedPath = normalizePortablePath(change.path);
    if (!normalizedPath || normalizedPath.startsWith("../")) {
      throw unprocessable(`Invalid shared skill file path: ${change.path}`);
    }
    const absolutePath = path.resolve(mirrorDir, normalizedPath);
    if (!absolutePath.startsWith(`${mirrorDir}${path.sep}`) && absolutePath !== path.resolve(mirrorDir)) {
      throw unprocessable(`Shared skill file path escapes the mirror root: ${change.path}`);
    }

    if (change.op === "remove_file") {
      await fs.rm(absolutePath, { force: true });
      continue;
    }

    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    if (change.op === "replace_file" || change.op === "write_file") {
      const content = change.content ?? change.newText ?? "";
      await fs.writeFile(absolutePath, content, "utf8");
      continue;
    }

    const current = await fs.readFile(absolutePath, "utf8").catch(() => null);
    if (current == null) {
      throw unprocessable(`Shared skill patch target does not exist: ${change.path}`);
    }
    if (typeof change.oldText !== "string" || typeof change.newText !== "string") {
      throw unprocessable(`patch_text requires oldText and newText for ${change.path}`);
    }
    if (!current.includes(change.oldText)) {
      throw conflict(`Shared skill patch base did not match current file contents for ${change.path}.`);
    }
    await fs.writeFile(absolutePath, current.replace(change.oldText, change.newText), "utf8");
  }
}

export function sharedSkillService(db: Db) {
  async function listRows() {
    const rows = await db.select().from(sharedSkills).orderBy(asc(sharedSkills.name), asc(sharedSkills.key));
    return rows;
  }

  async function ensureBootstrap(sourceRoots?: GlobalSkillCatalogSourceRoot[]) {
    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(sharedSkills);
    if (count > 0) return;
    await syncMirrors({ mode: "bootstrap", ...(sourceRoots ? { sourceRoots } : {}) });
  }

  async function discoverSourceSkills(sourceRoots?: GlobalSkillCatalogSourceRoot[]) {
    const selectedRoots = sourceRoots?.length ? new Set(sourceRoots) : null;
    const homeDir = resolveGlobalSkillCatalogHome();
    const out: DiscoveredSharedSkill[] = [];
    const seenRealPaths = new Set<string>();
    for (const entry of GLOBAL_SOURCE_ROOTS) {
      if (selectedRoots && !selectedRoots.has(entry.sourceRoot)) continue;
      const absoluteRoot = path.resolve(homeDir, entry.relativeRoot);
      const rootStat = await statPath(absoluteRoot);
      if (!rootStat?.isDirectory()) continue;
      const children = await fs.readdir(absoluteRoot, { withFileTypes: true }).catch(() => []);
      children.sort((left, right) => left.name.localeCompare(right.name));
      for (const child of children) {
        if (!child.isDirectory() || child.name.startsWith(".")) continue;
        const candidate = path.resolve(absoluteRoot, child.name);
        if (!(await statPath(path.join(candidate, "SKILL.md")))?.isFile()) continue;
        const realPath = await fs.realpath(candidate).catch(() => candidate);
        if (seenRealPaths.has(realPath)) continue;
        const discovered = await readSharedSkillFromDirectory(entry.sourceRoot, realPath).catch(() => null);
        if (!discovered) continue;
        seenRealPaths.add(realPath);
        out.push(discovered);
      }
    }
    return out.sort((left, right) => left.name.localeCompare(right.name) || left.key.localeCompare(right.key));
  }

  async function refreshLinkedCompanySkills(sharedSkillId: string) {
    const row = await db.select().from(sharedSkills).where(eq(sharedSkills.id, sharedSkillId)).then((rows) => rows[0] ?? null);
    if (!row) return;
    const sharedSkill = toSharedSkill(row);
    const mirrorDir = resolveSharedSkillMirrorDir(sharedSkill);
    await db
      .update(companySkills)
      .set({
        slug: sharedSkill.slug,
        name: sharedSkill.name,
        description: sharedSkill.description,
        markdown: sharedSkill.markdown,
        sourceType: "shared_mirror",
        sourceLocator: mirrorDir,
        sourceRef: sharedSkill.mirrorDigest,
        trustLevel: sharedSkill.trustLevel,
        compatibility: sharedSkill.compatibility,
        fileInventory: serializeFileInventory(sharedSkill.fileInventory),
        metadata: buildSharedSkillCompanyMetadata(sharedSkill, null),
        updatedAt: new Date(),
      })
      .where(eq(companySkills.sharedSkillId, sharedSkillId));
  }

  async function upsertDiscoveredSharedSkill(
    discovered: DiscoveredSharedSkill,
    options: { applyPristineUpdates: boolean },
  ) {
    const existing = await db
      .select()
      .from(sharedSkills)
      .where(and(eq(sharedSkills.sourceRoot, discovered.sourceRoot), eq(sharedSkills.sourcePath, discovered.sourcePath)))
      .then((rows) => rows[0] ?? null);

    const mirrorDir = resolveSharedSkillMirrorDir({ key: discovered.key, slug: discovered.slug });
    if (!existing) {
      await copySkillDirectory(discovered.sourcePath, mirrorDir, discovered.fileInventory);
      const mirrorDigest = await digestDirectory(mirrorDir, discovered.fileInventory);
      const inserted = await db
        .insert(sharedSkills)
        .values({
          key: discovered.key,
          slug: discovered.slug,
          name: discovered.name,
          description: discovered.description,
          markdown: discovered.markdown,
          fileInventory: serializeFileInventory(discovered.fileInventory),
          trustLevel: discovered.trustLevel,
          compatibility: discovered.compatibility,
          sourceRoot: discovered.sourceRoot,
          sourcePath: discovered.sourcePath,
          sourceDigest: discovered.sourceDigest,
          lastMirroredSourceDigest: discovered.sourceDigest,
          mirrorDigest,
          lastAppliedMirrorDigest: mirrorDigest,
          mirrorState: "pristine",
          sourceDriftState: "in_sync",
          metadata: discovered.metadata,
          updatedAt: new Date(),
        })
        .returning()
        .then((rows) => rows[0]!);
      return {
        row: inserted,
        item: {
          sharedSkillId: inserted.id,
          key: inserted.key,
          name: inserted.name,
          sourceRoot: inserted.sourceRoot as GlobalSkillCatalogSourceRoot,
          sourcePath: inserted.sourcePath,
          action: "bootstrapped" as const,
          mirrorState: "pristine" as const,
          sourceDriftState: "in_sync" as const,
        },
      };
    }

    const existingMirrorDir = resolveSharedSkillMirrorDir({ key: existing.key, slug: existing.slug });
    const mirrorExists = (await statPath(path.join(existingMirrorDir, "SKILL.md")))?.isFile() ?? false;
    if (!mirrorExists) {
      await copySkillDirectory(discovered.sourcePath, existingMirrorDir, discovered.fileInventory);
    }
    const mirrorSnapshot = await readMirrorSkillFromPath(existing).catch(() => null);
    const currentMirrorDigest = mirrorSnapshot?.sourceDigest ?? null;
    const mirrorState: SharedSkillMirrorState = currentMirrorDigest && currentMirrorDigest === existing.lastMirroredSourceDigest
      ? "pristine"
      : "paperclip_modified";
    const sourceChanged = discovered.sourceDigest !== (existing.lastMirroredSourceDigest ?? null);

    if (sourceChanged && options.applyPristineUpdates && mirrorState === "pristine") {
      await copySkillDirectory(discovered.sourcePath, existingMirrorDir, discovered.fileInventory);
      const updatedMirrorDigest = await digestDirectory(existingMirrorDir, discovered.fileInventory);
      const updated = await db
        .update(sharedSkills)
        .set({
          key: discovered.key,
          slug: discovered.slug,
          name: discovered.name,
          description: discovered.description,
          markdown: discovered.markdown,
          fileInventory: serializeFileInventory(discovered.fileInventory),
          trustLevel: discovered.trustLevel,
          compatibility: discovered.compatibility,
          sourceDigest: discovered.sourceDigest,
          lastMirroredSourceDigest: discovered.sourceDigest,
          mirrorDigest: updatedMirrorDigest,
          lastAppliedMirrorDigest: updatedMirrorDigest,
          mirrorState: "pristine",
          sourceDriftState: "in_sync",
          metadata: discovered.metadata,
          updatedAt: new Date(),
        })
        .where(eq(sharedSkills.id, existing.id))
        .returning()
        .then((rows) => rows[0]!);
      await refreshLinkedCompanySkills(updated.id);
      return {
        row: updated,
        item: {
          sharedSkillId: updated.id,
          key: updated.key,
          name: updated.name,
          sourceRoot: updated.sourceRoot as GlobalSkillCatalogSourceRoot,
          sourcePath: updated.sourcePath,
          action: "updated_pristine_mirror" as const,
          mirrorState: "pristine" as const,
          sourceDriftState: "in_sync" as const,
        },
      };
    }

    const nextSourceDriftState: SharedSkillSourceDriftState = sourceChanged
      ? (mirrorState === "pristine" ? "upstream_update_available" : "diverged_needs_review")
      : "in_sync";
    const nextSharedSkillData = mirrorSnapshot ?? discovered;
    const updated = await db
      .update(sharedSkills)
      .set({
        key: existing.key,
        slug: nextSharedSkillData.slug,
        name: nextSharedSkillData.name,
        description: nextSharedSkillData.description,
        markdown: nextSharedSkillData.markdown,
        fileInventory: serializeFileInventory(nextSharedSkillData.fileInventory),
        trustLevel: nextSharedSkillData.trustLevel,
        compatibility: nextSharedSkillData.compatibility,
        sourceDigest: discovered.sourceDigest,
        mirrorDigest: currentMirrorDigest,
        mirrorState,
        sourceDriftState: nextSourceDriftState,
        metadata: discovered.metadata,
        updatedAt: new Date(),
      })
      .where(eq(sharedSkills.id, existing.id))
      .returning()
      .then((rows) => rows[0]!);
    await refreshLinkedCompanySkills(updated.id);
    return {
      row: updated,
      item: {
        sharedSkillId: updated.id,
        key: updated.key,
        name: updated.name,
        sourceRoot: updated.sourceRoot as GlobalSkillCatalogSourceRoot,
        sourcePath: updated.sourcePath,
        action: sourceChanged ? "classified_only" as const : "unchanged" as const,
        mirrorState: updated.mirrorState as SharedSkillMirrorState,
        sourceDriftState: updated.sourceDriftState as SharedSkillSourceDriftState,
      },
    };
  }

  async function markMissingSources(sourceRoots?: GlobalSkillCatalogSourceRoot[]) {
    const selectedRoots = sourceRoots?.length ? new Set(sourceRoots) : null;
    const rows = await listRows();
    const results: SharedSkillMirrorSyncResult["items"] = [];
    for (const row of rows) {
      if (selectedRoots && !selectedRoots.has(row.sourceRoot as GlobalSkillCatalogSourceRoot)) continue;
      const sourceStat = await statPath(path.join(row.sourcePath, "SKILL.md"));
      if (sourceStat?.isFile()) continue;
      const updated = await db
        .update(sharedSkills)
        .set({
          sourceDigest: null,
          mirrorState: "source_missing",
          sourceDriftState: "source_missing",
          updatedAt: new Date(),
        })
        .where(eq(sharedSkills.id, row.id))
        .returning()
        .then((found) => found[0] ?? row);
      await refreshLinkedCompanySkills(updated.id);
      results.push({
        sharedSkillId: updated.id,
        key: updated.key,
        name: updated.name,
        sourceRoot: updated.sourceRoot as GlobalSkillCatalogSourceRoot,
        sourcePath: updated.sourcePath,
        action: "classified_only",
        mirrorState: "source_missing",
        sourceDriftState: "source_missing",
      });
    }
    return results;
  }

  async function syncMirrors(input: SharedSkillMirrorSyncRequest): Promise<SharedSkillMirrorSyncResult> {
    const discovered = await discoverSourceSkills(input.sourceRoots);
    const items: SharedSkillMirrorSyncResult["items"] = [];
    for (const entry of discovered) {
      const synced = await upsertDiscoveredSharedSkill(entry, { applyPristineUpdates: input.mode === "refresh" });
      items.push(synced.item);
    }
    const missing = await markMissingSources(input.sourceRoots);
    for (const item of missing) {
      if (!items.some((existing) => existing.sharedSkillId === item.sharedSkillId)) {
        items.push(item);
      }
    }
    items.sort((left, right) => left.name.localeCompare(right.name) || left.key.localeCompare(right.key));
    return {
      mode: input.mode,
      totalCount: items.length,
      bootstrappedCount: items.filter((item) => item.action === "bootstrapped").length,
      updatedCount: items.filter((item) => item.action === "updated_pristine_mirror").length,
      unchangedCount: items.filter((item) => item.action === "unchanged").length,
      classifiedCount: items.filter((item) => item.action === "classified_only").length,
      items,
    };
  }

  async function list() {
    await ensureBootstrap();
    return (await listRows()).map((row) => toSharedSkill(row));
  }

  async function detail(sharedSkillId: string) {
    await ensureBootstrap();
    const row = await db.select().from(sharedSkills).where(eq(sharedSkills.id, sharedSkillId)).then((rows) => rows[0] ?? null);
    return row ? toSharedSkill(row) : null;
  }

  async function drift(sharedSkillId: string) {
    const skill = await detail(sharedSkillId);
    if (!skill) return null;
    return {
      sharedSkillId: skill.id,
      sourceRoot: skill.sourceRoot,
      sourcePath: skill.sourcePath,
      sourceDigest: skill.sourceDigest,
      lastMirroredSourceDigest: skill.lastMirroredSourceDigest,
      mirrorDigest: skill.mirrorDigest,
      lastAppliedMirrorDigest: skill.lastAppliedMirrorDigest,
      mirrorState: skill.mirrorState,
      sourceDriftState: skill.sourceDriftState,
    };
  }

  async function listCatalogEntries(companyId: string): Promise<GlobalSkillCatalogItem[]> {
    await ensureBootstrap();
    const [skills, installedRows] = await Promise.all([
      list(),
      db
        .select({
          id: companySkills.id,
          key: companySkills.key,
          sharedSkillId: companySkills.sharedSkillId,
          sourceType: companySkills.sourceType,
          metadata: companySkills.metadata,
        })
        .from(companySkills)
        .where(eq(companySkills.companyId, companyId)),
    ]);

    return skills.map((skill) => {
      const installed = installedRows.find((row) => {
        if (row.sharedSkillId === skill.id) return true;
        const metadata = isPlainRecord(row.metadata) ? row.metadata : null;
        return row.sourceType === "catalog"
          && asString(metadata?.catalogSourceRoot) === skill.sourceRoot
          && asString(metadata?.catalogSourcePath) === skill.sourcePath;
      }) ?? null;
      return {
        catalogKey: skill.id,
        slug: skill.slug,
        name: skill.name,
        description: skill.description,
        sourceRoot: skill.sourceRoot,
        sourcePath: skill.sourcePath,
        trustLevel: skill.trustLevel,
        compatibility: skill.compatibility,
        manifestVersion: 1,
        identityDigest: digestString(skill.key),
        contentDigest: skill.mirrorDigest ?? digestString(skill.markdown),
        verificationState: "verified",
        compatibilityMetadata: emptyCompatibilityMetadata(),
        fileInventory: skill.fileInventory,
        installedSkillId: installed?.id ?? null,
        installedSkillKey: installed?.key ?? null,
      };
    });
  }

  async function attachMirrorToCompany(companyId: string, sharedSkillId: string) {
    const sharedSkill = await detail(sharedSkillId);
    if (!sharedSkill) throw notFound("Shared skill not found.");

    const existingBySharedId = await db
      .select()
      .from(companySkills)
      .where(and(eq(companySkills.companyId, companyId), eq(companySkills.sharedSkillId, sharedSkillId)))
      .then((rows) => rows[0] ?? null);

    const legacyGlobalCatalog = await db
      .select()
      .from(companySkills)
      .where(and(eq(companySkills.companyId, companyId), eq(companySkills.sourceType, "catalog")))
      .then((rows) =>
        rows.find((row) => {
          const metadata = isPlainRecord(row.metadata) ? row.metadata : null;
          return asString(metadata?.catalogSourceRoot) === sharedSkill.sourceRoot
            && asString(metadata?.catalogSourcePath) === sharedSkill.sourcePath;
        }) ?? null);

    const existingByKey = await db
      .select()
      .from(companySkills)
      .where(and(eq(companySkills.companyId, companyId), eq(companySkills.key, sharedSkill.key)))
      .then((rows) => rows[0] ?? null);

    const targetRow = existingBySharedId ?? legacyGlobalCatalog ?? null;
    if (existingByKey && existingByKey.id !== targetRow?.id) {
      throw conflict(`Cannot install ${sharedSkill.name}: skill key ${sharedSkill.key} is already used by ${existingByKey.name}.`, {
        conflictingSkillId: existingByKey.id,
        conflictingSkillKey: existingByKey.key,
      });
    }

    const mirrorDir = resolveSharedSkillMirrorDir(sharedSkill);
    const values = {
      sharedSkillId: sharedSkill.id,
      key: targetRow?.key ?? sharedSkill.key,
      slug: sharedSkill.slug,
      name: sharedSkill.name,
      description: sharedSkill.description,
      markdown: sharedSkill.markdown,
      sourceType: "shared_mirror" as const,
      sourceLocator: mirrorDir,
      sourceRef: sharedSkill.mirrorDigest,
      trustLevel: sharedSkill.trustLevel,
      compatibility: sharedSkill.compatibility,
      fileInventory: serializeFileInventory(sharedSkill.fileInventory),
      metadata: buildSharedSkillCompanyMetadata(sharedSkill, targetRow && isPlainRecord(targetRow.metadata) ? targetRow.metadata : null),
      updatedAt: new Date(),
    };

    if (targetRow) {
      const updated = await db
        .update(companySkills)
        .set(values)
        .where(eq(companySkills.id, targetRow.id))
        .returning()
        .then((rows) => rows[0]!);
      return updated.id;
    }

    const inserted = await db
      .insert(companySkills)
      .values({
        companyId,
        ...values,
      })
      .returning()
      .then((rows) => rows[0]!);
    return inserted.id;
  }

  async function listProposals(status?: SharedSkillProposal["status"]) {
    const filters = status ? [eq(sharedSkillProposals.status, status)] : [];
    const rows = await db
      .select()
      .from(sharedSkillProposals)
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(desc(sharedSkillProposals.createdAt));
    return rows.map((row) => toProposal(row));
  }

  async function proposalDetail(proposalId: string) {
    const proposalRow = await db
      .select()
      .from(sharedSkillProposals)
      .where(eq(sharedSkillProposals.id, proposalId))
      .then((rows) => rows[0] ?? null);
    if (!proposalRow) return null;
    const commentRows = await db
      .select()
      .from(sharedSkillProposalComments)
      .where(eq(sharedSkillProposalComments.proposalId, proposalId))
      .orderBy(asc(sharedSkillProposalComments.createdAt));
    return {
      proposal: toProposal(proposalRow),
      comments: commentRows.map((row) => toProposalComment(row)),
    };
  }

  async function listOpenProposalSummaries(sharedSkillIds: string[]) {
    if (sharedSkillIds.length === 0) return new Map<string, SharedSkillRuntimeContext["openProposal"]>();
    const rows = await db
      .select()
      .from(sharedSkillProposals)
      .where(
        and(
          inArray(sharedSkillProposals.sharedSkillId, sharedSkillIds),
          inArray(sharedSkillProposals.status, [...OPEN_PROPOSAL_STATUSES]),
        ),
      )
      .orderBy(desc(sharedSkillProposals.createdAt));
    const bySkill = new Map<string, SharedSkillRuntimeContext["openProposal"]>();
    for (const row of rows) {
      if (bySkill.has(row.sharedSkillId)) continue;
      bySkill.set(row.sharedSkillId, {
        id: row.id,
        kind: row.kind as SharedSkillProposal["kind"],
        status: row.status as SharedSkillProposal["status"],
        summary: row.summary,
        createdAt: row.createdAt.toISOString(),
      });
    }
    return bySkill;
  }

  async function buildRuntimeContext(sharedSkillIds: string[]) {
    if (sharedSkillIds.length === 0) return [];
    const rows = await db
      .select()
      .from(sharedSkills)
      .where(inArray(sharedSkills.id, sharedSkillIds))
      .orderBy(asc(sharedSkills.name));
    const openSummaries = await listOpenProposalSummaries(sharedSkillIds);
    return rows.map((row): SharedSkillRuntimeContext => ({
      sharedSkillId: row.id,
      key: row.key,
      name: row.name,
      mirrorState: row.mirrorState as SharedSkillMirrorState,
      sourceDriftState: row.sourceDriftState as SharedSkillSourceDriftState,
      proposalAllowed: true,
      applyAllowed: false,
      openProposal: openSummaries.get(row.id) ?? null,
    }));
  }

  async function createProposal(
    companyId: string,
    sharedSkillId: string,
    input: SharedSkillProposalCreateRequest,
    actor: ProposalActor,
  ) {
    const sharedSkill = await detail(sharedSkillId);
    if (!sharedSkill) throw notFound("Shared skill not found.");

    const fingerprint = buildProposalFingerprint(sharedSkillId, input);
    const existing = await db
      .select()
      .from(sharedSkillProposals)
      .where(
        and(
          eq(sharedSkillProposals.proposalFingerprint, fingerprint),
          inArray(sharedSkillProposals.status, [...OPEN_PROPOSAL_STATUSES]),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (existing) return toProposal(existing);

    const inserted = await db
      .insert(sharedSkillProposals)
      .values({
        sharedSkillId,
        companyId,
        issueId: input.evidence.issueId ?? null,
        runId: input.evidence.runId ?? actor.runId,
        proposedByAgentId: actor.actorType === "agent" ? actor.actorId : null,
        proposedByUserId: actor.actorType === "user" ? actor.actorId : null,
        kind: input.kind,
        status: "pending",
        summary: input.summary,
        rationale: input.rationale,
        baseMirrorDigest: input.baseMirrorDigest,
        baseSourceDigest: input.baseSourceDigest,
        proposalFingerprint: fingerprint,
        payload: {
          changes: normalizeProposalChanges(input.changes),
          evidence: input.evidence,
          ...(input.requiredVerification
            ? { requiredVerification: normalizeRequiredVerification(input.requiredVerification) }
            : {}),
          ...(input.verificationResults
            ? { verificationResults: normalizeVerificationResults(input.verificationResults) }
            : {}),
          ...(input.upstreamDecision ? { upstreamDecision: input.upstreamDecision } : {}),
        },
        updatedAt: new Date(),
      })
      .returning()
      .then((rows) => rows[0]!);
    return toProposal(inserted);
  }

  async function approveProposal(proposalId: string, actorUserId: string, decisionNote?: string | null) {
    const proposalRow = await db
      .select()
      .from(sharedSkillProposals)
      .where(eq(sharedSkillProposals.id, proposalId))
      .then((rows) => rows[0] ?? null);
    if (!proposalRow) throw notFound("Shared skill proposal not found.");
    if (!OPEN_PROPOSAL_STATUSES.includes(proposalRow.status as typeof OPEN_PROPOSAL_STATUSES[number])) {
      throw conflict("Only pending or revision-requested proposals can be approved.");
    }

    const sharedSkill = await detail(proposalRow.sharedSkillId);
    if (!sharedSkill) throw notFound("Shared skill not found.");
    if (proposalRow.baseMirrorDigest && sharedSkill.mirrorDigest && proposalRow.baseMirrorDigest !== sharedSkill.mirrorDigest) {
      throw conflict("Shared skill mirror changed since this proposal was created.");
    }

    const mirrorDir = resolveSharedSkillMirrorDir(sharedSkill);
    const payload = isPlainRecord(proposalRow.payload)
      ? proposalRow.payload as unknown as SharedSkillProposal["payload"]
      : null;
    const requiredVerification = normalizeRequiredVerification(payload?.requiredVerification ?? null);
    const verificationResults = payload?.verificationResults
      ? normalizeVerificationResults(payload.verificationResults)
      : null;
    if (requiredVerification && !verificationResultsCover(requiredVerification, verificationResults)) {
      throw unprocessable("Required verification is incomplete for this shared-skill proposal.");
    }
    const changes = Array.isArray(payload?.changes) ? payload!.changes : [];
    await applyProposalChanges(mirrorDir, changes);
    const refreshedMirror = await readMirrorSkillFromPath({
      ...proposalRow,
      ...sharedSkill,
      sourceRoot: sharedSkill.sourceRoot,
      sourcePath: sharedSkill.sourcePath,
      trustLevel: sharedSkill.trustLevel,
      compatibility: sharedSkill.compatibility,
      mirrorState: sharedSkill.mirrorState,
      sourceDriftState: sharedSkill.sourceDriftState,
      fileInventory: serializeFileInventory(sharedSkill.fileInventory),
      metadata: sharedSkill.metadata,
      createdAt: sharedSkill.createdAt,
      updatedAt: sharedSkill.updatedAt,
    } as unknown as SharedSkillRow);
    const sourceStillExists = (await statPath(path.join(sharedSkill.sourcePath, "SKILL.md")))?.isFile() ?? false;
    const sourceDigest = sourceStillExists
      ? await digestDirectory(sharedSkill.sourcePath, sharedSkill.fileInventory).catch(() => null)
      : null;
    const driftState: SharedSkillSourceDriftState = !sourceStillExists
      ? "source_missing"
      : sourceDigest && sourceDigest !== sharedSkill.lastMirroredSourceDigest
        ? "diverged_needs_review"
        : "in_sync";
    const updatedSharedSkillRow = await db
      .update(sharedSkills)
      .set({
        slug: refreshedMirror.slug,
        name: refreshedMirror.name,
        description: refreshedMirror.description,
        markdown: refreshedMirror.markdown,
        fileInventory: serializeFileInventory(refreshedMirror.fileInventory),
        trustLevel: refreshedMirror.trustLevel,
        compatibility: refreshedMirror.compatibility,
        sourceDigest,
        mirrorDigest: refreshedMirror.sourceDigest,
        lastAppliedMirrorDigest: refreshedMirror.sourceDigest,
        mirrorState: "paperclip_modified",
        sourceDriftState: driftState,
        updatedAt: new Date(),
      })
      .where(eq(sharedSkills.id, sharedSkill.id))
      .returning()
      .then((rows) => rows[0]!);
    await refreshLinkedCompanySkills(updatedSharedSkillRow.id);

    const updatedProposal = await db
      .update(sharedSkillProposals)
      .set({
        status: "approved",
        decisionNote: decisionNote ?? null,
        decidedByUserId: actorUserId,
        decidedAt: new Date(),
        appliedMirrorDigest: refreshedMirror.sourceDigest,
        updatedAt: new Date(),
      })
      .where(eq(sharedSkillProposals.id, proposalId))
      .returning()
      .then((rows) => rows[0]!);
    return toProposal(updatedProposal);
  }

  async function rejectProposal(proposalId: string, actorUserId: string, status: "rejected" | "revision_requested", decisionNote?: string | null) {
    const row = await db
      .update(sharedSkillProposals)
      .set({
        status,
        decisionNote: decisionNote ?? null,
        decidedByUserId: actorUserId,
        decidedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(sharedSkillProposals.id, proposalId))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Shared skill proposal not found.");
    return toProposal(row);
  }

  async function addComment(proposalId: string, actor: ProposalActor, body: string) {
    const proposal = await db
      .select({ id: sharedSkillProposals.id })
      .from(sharedSkillProposals)
      .where(eq(sharedSkillProposals.id, proposalId))
      .then((rows) => rows[0] ?? null);
    if (!proposal) throw notFound("Shared skill proposal not found.");

    const inserted = await db
      .insert(sharedSkillProposalComments)
      .values({
        proposalId,
        authorAgentId: actor.actorType === "agent" ? actor.actorId : null,
        authorUserId: actor.actorType === "user" ? actor.actorId : null,
        body,
      })
      .returning()
      .then((rows) => rows[0]!);
    return toProposalComment(inserted);
  }

  async function updateProposalVerification(
    proposalId: string,
    input: SharedSkillProposalVerificationUpdateRequest,
  ) {
    const proposalRow = await db
      .select()
      .from(sharedSkillProposals)
      .where(eq(sharedSkillProposals.id, proposalId))
      .then((rows) => rows[0] ?? null);
    if (!proposalRow) throw notFound("Shared skill proposal not found.");

    const payload: SharedSkillProposalPayload = isPlainRecord(proposalRow.payload)
      ? proposalRow.payload as unknown as SharedSkillProposalPayload
      : { changes: [], evidence: {} };
    const nextPayload: SharedSkillProposalPayload = {
      ...payload,
      verificationResults: mergeVerificationResults(payload.verificationResults ?? null, input),
    };

    const updated = await db
      .update(sharedSkillProposals)
      .set({
        payload: nextPayload as unknown as Record<string, unknown>,
        updatedAt: new Date(),
      })
      .where(eq(sharedSkillProposals.id, proposalId))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!updated) throw notFound("Shared skill proposal not found.");
    return toProposal(updated);
  }

  async function listLinkedCompanyIds(sharedSkillId: string) {
    const rows = await db
      .select({ companyId: companySkills.companyId })
      .from(companySkills)
      .where(eq(companySkills.sharedSkillId, sharedSkillId));
    return Array.from(new Set(rows.map((row) => row.companyId)));
  }

  async function isSkillVisibleToCompany(sharedSkillId: string, companyId: string) {
    const row = await db
      .select({ id: companySkills.id })
      .from(companySkills)
      .where(and(eq(companySkills.companyId, companyId), eq(companySkills.sharedSkillId, sharedSkillId)))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return Boolean(row);
  }

  async function isSkillAvailableForRun(runId: string, sharedSkillId: string, companyId: string) {
    const run = await db
      .select({
        id: heartbeatRuns.id,
        companyId: heartbeatRuns.companyId,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    if (!run || run.companyId !== companyId) return false;
    const context = isPlainRecord(run.contextSnapshot) ? run.contextSnapshot : {};
    const sharedSkillContext = Array.isArray(context.paperclipSharedSkills)
      ? context.paperclipSharedSkills.filter((entry): entry is Record<string, unknown> => isPlainRecord(entry))
      : [];
    return sharedSkillContext.some((entry) => entry.sharedSkillId === sharedSkillId);
  }

  async function shouldEnqueueFallbackReview(runId: string, sharedSkillIds: string[]) {
    if (sharedSkillIds.length === 0) return false;
    const existing = await db
      .select({ id: sharedSkillProposals.id })
      .from(sharedSkillProposals)
      .where(
        and(
          eq(sharedSkillProposals.runId, runId),
          inArray(sharedSkillProposals.sharedSkillId, sharedSkillIds),
          inArray(sharedSkillProposals.status, [...OPEN_PROPOSAL_STATUSES]),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return !existing;
  }

  return {
    list,
    detail,
    drift,
    syncMirrors,
    listCatalogEntries,
    attachMirrorToCompany,
    listProposals,
    proposalDetail,
    createProposal,
    approveProposal,
    rejectProposal,
    addComment,
    updateProposalVerification,
    buildRuntimeContext,
    listLinkedCompanyIds,
    listOpenProposalSummaries,
    isSkillVisibleToCompany,
    isSkillAvailableForRun,
    shouldEnqueueFallbackReview,
  };
}
