import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentTemplateRevisions, agentTemplates } from "@paperclipai/db";
import {
  agentTemplateSnapshotSchema,
  type AgentTemplateImportPackRequest,
} from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";
import { parseFrontmatterMarkdown } from "./frontmatter.js";
import { readAgentTemplateMode, withAgentTemplateMode } from "./agent-template-metadata.js";

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function asNullableString(value: unknown): string | null {
  if (value == null) return null;
  return asString(value);
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function normalizeTemplatePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\/+/, "");
}

function isTemplateMarkdownPath(path: string): boolean {
  const normalized = normalizeTemplatePath(path);
  const base = normalized.split("/").pop()?.toLowerCase() ?? "";
  return normalized.toLowerCase().endsWith(".md") && base !== "readme.md" && !base.startsWith(".");
}

function snapshotsEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function buildTemplateSnapshotFromFrontmatter(frontmatter: Record<string, unknown>, body: string) {
  const metadata = asObject(frontmatter.metadata);
  const parsed = agentTemplateSnapshotSchema.safeParse({
    name: asString(frontmatter.name),
    role: frontmatter.role,
    title: asNullableString(frontmatter.title),
    icon: frontmatter.icon ?? null,
    reportsTo: frontmatter.reportsTo ?? null,
    orgLevel: frontmatter.orgLevel,
    operatingClass: frontmatter.operatingClass,
    capabilityProfileKey: frontmatter.capabilityProfileKey,
    archetypeKey: asString(frontmatter.archetypeKey),
    departmentKey: frontmatter.departmentKey,
    departmentName: asNullableString(frontmatter.departmentName),
    capabilities: asNullableString(frontmatter.capabilities),
    adapterType: frontmatter.adapterType ?? null,
    adapterConfig: asObject(frontmatter.adapterConfig),
    runtimeConfig: asObject(frontmatter.runtimeConfig),
    budgetMonthlyCents:
      typeof frontmatter.budgetMonthlyCents === "number"
        ? frontmatter.budgetMonthlyCents
        : 0,
    metadata: Object.keys(metadata).length ? metadata : null,
    instructionsBody: body,
  });
  if (!parsed.success) {
    throw unprocessable("Invalid agent template frontmatter", parsed.error.issues);
  }
  return parsed.data;
}

export function agentTemplateService(db: Db) {
  return {
    list: async (companyId: string) => {
      const templates = await db
        .select()
        .from(agentTemplates)
        .where(and(eq(agentTemplates.companyId, companyId), isNull(agentTemplates.archivedAt)))
        .orderBy(agentTemplates.name);
      return templates.filter((template) => readAgentTemplateMode(template.metadata) === "reusable");
    },

    listRevisions: async (templateId: string) => {
      return db
        .select()
        .from(agentTemplateRevisions)
        .where(eq(agentTemplateRevisions.templateId, templateId))
        .orderBy(desc(agentTemplateRevisions.revisionNumber));
    },

    getTemplate: async (templateId: string) => {
      return db
        .select()
        .from(agentTemplates)
        .where(eq(agentTemplates.id, templateId))
        .then((rows) => rows[0] ?? null);
    },

    resolveRevisionForInstantiation: async (companyId: string, input: {
      templateId?: string | null;
      templateRevisionId?: string | null;
    }) => {
      if (!input.templateId && !input.templateRevisionId) return null;

      if (input.templateRevisionId) {
        const revision = await db
          .select({
            revision: agentTemplateRevisions,
            template: agentTemplates,
          })
          .from(agentTemplateRevisions)
          .innerJoin(agentTemplates, eq(agentTemplates.id, agentTemplateRevisions.templateId))
          .where(eq(agentTemplateRevisions.id, input.templateRevisionId))
          .then((rows) => rows[0] ?? null);
        if (!revision || revision.template.companyId !== companyId || revision.template.archivedAt) {
          throw notFound("Agent template revision not found");
        }
        if (input.templateId && revision.template.id !== input.templateId) {
          throw unprocessable("templateRevisionId does not belong to templateId");
        }
        return revision;
      }

      const template = await db
        .select()
        .from(agentTemplates)
        .where(eq(agentTemplates.id, input.templateId!))
        .then((rows) => rows[0] ?? null);
      if (!template || template.companyId !== companyId || template.archivedAt) {
        throw notFound("Agent template not found");
      }
      const revision = await db
        .select()
        .from(agentTemplateRevisions)
        .where(eq(agentTemplateRevisions.templateId, template.id))
        .orderBy(desc(agentTemplateRevisions.revisionNumber))
        .then((rows) => rows[0] ?? null);
      if (!revision) throw unprocessable("Agent template has no revisions");
      return { template, revision };
    },

    importPack: async (
      companyId: string,
      request: AgentTemplateImportPackRequest,
      actor?: { createdByAgentId?: string | null; createdByUserId?: string | null },
    ) => {
      const entries = Object.entries(request.files)
        .map(([filePath, content]) => [normalizeTemplatePath(filePath), content] as const)
        .filter(([filePath]) => isTemplateMarkdownPath(filePath))
        .sort(([left], [right]) => left.localeCompare(right));

      const items: Array<{
        path: string;
        template: typeof agentTemplates.$inferSelect;
        revision: typeof agentTemplateRevisions.$inferSelect;
        created: boolean;
        revisionCreated: boolean;
      }> = [];
      const warnings: string[] = [];

      for (const [filePath, markdown] of entries) {
        const parsed = parseFrontmatterMarkdown(markdown);
        if (!parsed.body.trim().length) {
          warnings.push(`Skipped ${filePath}: template body is empty.`);
          continue;
        }

        const snapshot = buildTemplateSnapshotFromFrontmatter(parsed.frontmatter, parsed.body);
        const key = snapshot.archetypeKey;

        const existing = await db
          .select()
          .from(agentTemplates)
          .where(
            and(
              eq(agentTemplates.companyId, companyId),
              eq(agentTemplates.archetypeKey, key),
              isNull(agentTemplates.archivedAt),
            ),
          )
          .then((rows) => rows.find((row) => readAgentTemplateMode(row.metadata) === "reusable") ?? null);

        const result = await db.transaction(async (tx) => {
          const now = new Date();
          let template = existing;
          let created = false;
          if (!template) {
            created = true;
            const inserted = await tx
              .insert(agentTemplates)
              .values({
                companyId,
                name: snapshot.name,
                role: snapshot.role,
                operatingClass: snapshot.operatingClass,
                capabilityProfileKey: snapshot.capabilityProfileKey,
                archetypeKey: snapshot.archetypeKey,
                metadata: withAgentTemplateMode(snapshot.metadata, "reusable", {
                  sourcePath: filePath,
                  importedRootPath: request.rootPath ?? null,
                }),
                updatedAt: now,
              })
              .returning()
              .then((rows) => rows[0] ?? null);
            if (!inserted) throw unprocessable("Unable to create agent template");
            template = inserted;
          } else {
            await tx
              .update(agentTemplates)
              .set({
                name: snapshot.name,
                role: snapshot.role,
                operatingClass: snapshot.operatingClass,
                capabilityProfileKey: snapshot.capabilityProfileKey,
                archetypeKey: snapshot.archetypeKey,
                metadata: withAgentTemplateMode(snapshot.metadata, "reusable", {
                  sourcePath: filePath,
                  importedRootPath: request.rootPath ?? null,
                }),
                updatedAt: now,
              })
              .where(eq(agentTemplates.id, template.id));
            template = {
              ...template,
              name: snapshot.name,
              role: snapshot.role,
              operatingClass: snapshot.operatingClass,
              capabilityProfileKey: snapshot.capabilityProfileKey,
              archetypeKey: snapshot.archetypeKey,
              metadata: withAgentTemplateMode(snapshot.metadata, "reusable", {
                sourcePath: filePath,
                importedRootPath: request.rootPath ?? null,
              }),
              updatedAt: now,
            };
          }

          const latestRevision = await tx
            .select()
            .from(agentTemplateRevisions)
            .where(eq(agentTemplateRevisions.templateId, template.id))
            .orderBy(desc(agentTemplateRevisions.revisionNumber))
            .then((rows) => rows[0] ?? null);

          let revision = latestRevision;
          let revisionCreated = false;
          if (!latestRevision || !snapshotsEqual(latestRevision.snapshot, snapshot)) {
            revisionCreated = true;
            revision = await tx
              .insert(agentTemplateRevisions)
              .values({
                companyId,
                templateId: template.id,
                revisionNumber: (latestRevision?.revisionNumber ?? 0) + 1,
                snapshot,
                createdByAgentId: actor?.createdByAgentId ?? null,
                createdByUserId: actor?.createdByUserId ?? null,
                createdAt: now,
              })
              .returning()
              .then((rows) => rows[0] ?? null);
          }

          if (!revision) throw unprocessable("Unable to create agent template revision");
          return { template, revision, created, revisionCreated };
        });

        items.push({ path: filePath, ...result });
      }

      return { items, warnings };
    },
  };
}
