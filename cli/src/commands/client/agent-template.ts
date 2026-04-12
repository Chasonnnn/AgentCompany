import { Command } from "commander";
import type { AgentTemplate } from "@paperclipai/shared";
import { resolveInlineSourceFromPath } from "./company.js";
import {
  addCommonClientOptions,
  formatInlineRecord,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
  type ResolvedClientContext,
} from "./common.js";

interface AgentTemplateCommandOptions extends BaseClientOptions {
  companyId?: string;
}

interface AgentTemplateImportPackOptions extends AgentTemplateCommandOptions {}

interface AgentTemplateRevisionSnapshot {
  name: string;
  role: string;
  operatingClass: string;
  capabilityProfileKey: string;
  archetypeKey: string;
}

interface AgentTemplateRevisionRecord {
  id: string;
  templateId: string;
  revisionNumber: number;
  snapshot: AgentTemplateRevisionSnapshot;
  createdAt: string;
}

interface AgentTemplateImportPackResult {
  items: Array<{
    path: string;
    template: AgentTemplate;
    revision: AgentTemplateRevisionRecord;
    created: boolean;
    revisionCreated: boolean;
  }>;
  warnings: string[];
}

interface AgentTemplateImportPackPayload {
  rootPath: string | null;
  files: Record<string, string>;
}

export function matchAgentTemplateRef(
  templates: AgentTemplate[],
  templateRef: string,
): AgentTemplate {
  const normalized = templateRef.trim();
  if (!normalized) {
    throw new Error("Template reference is required.");
  }

  const byId = templates.find((template) => template.id === normalized);
  if (byId) return byId;

  const byArchetype = templates.find((template) => template.archetypeKey === normalized);
  if (byArchetype) return byArchetype;

  const byName = templates.filter((template) => template.name === normalized);
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) {
    throw new Error(
      `Template name '${normalized}' is ambiguous. Matching template ids: ${byName.map((template) => template.id).join(", ")}`,
    );
  }

  throw new Error(
    `Agent template '${normalized}' not found. Resolve by template id, exact archetypeKey, or exact name.`,
  );
}

export async function listCompanyAgentTemplates(
  ctx: ResolvedClientContext,
  companyId: string,
): Promise<AgentTemplate[]> {
  return (await ctx.api.get<AgentTemplate[]>(`/api/companies/${companyId}/agent-templates`)) ?? [];
}

export async function resolveAgentTemplateRef(
  ctx: ResolvedClientContext,
  companyId: string,
  templateRef: string,
): Promise<AgentTemplate> {
  const templates = await listCompanyAgentTemplates(ctx, companyId);
  return matchAgentTemplateRef(templates, templateRef);
}

export async function resolveAgentTemplateImportPackFromPath(
  inputPath: string,
): Promise<AgentTemplateImportPackPayload> {
  const resolved = await resolveInlineSourceFromPath(inputPath);
  const files: Record<string, string> = {};

  for (const [relativePath, content] of Object.entries(resolved.files)) {
    if (typeof content !== "string") continue;
    files[relativePath] = content;
  }

  if (Object.keys(files).length === 0) {
    throw new Error("No markdown template files found in the supplied pack.");
  }

  return {
    rootPath: resolved.rootPath ?? null,
    files,
  };
}

export function registerAgentTemplateCommands(program: Command): void {
  const agentTemplate = program.command("agent-template").description("Agent template operations");

  addCommonClientOptions(
    agentTemplate
      .command("list")
      .description("List reusable agent templates for a company")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .action(async (opts: AgentTemplateCommandOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = await listCompanyAgentTemplates(ctx, ctx.companyId!);

          if (ctx.json) {
            printOutput(rows, { json: true });
            return;
          }

          if (rows.length === 0) {
            printOutput([], { json: false });
            return;
          }

          for (const row of rows) {
            console.log(
              formatInlineRecord({
                id: row.id,
                name: row.name,
                role: row.role,
                archetypeKey: row.archetypeKey,
                operatingClass: row.operatingClass,
                capabilityProfileKey: row.capabilityProfileKey,
                updatedAt: row.updatedAt,
              }),
            );
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    agentTemplate
      .command("import-pack")
      .description("Import an agent template pack from a directory or zip archive")
      .argument("<path>", "Local directory or zip archive")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .action(async (inputPath: string, opts: AgentTemplateImportPackOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const payload = await resolveAgentTemplateImportPackFromPath(inputPath);
          const result = await ctx.api.post<AgentTemplateImportPackResult>(
            `/api/companies/${ctx.companyId}/agent-templates/import-pack`,
            payload,
          );

          if (!result) {
            throw new Error("Template import returned no result.");
          }

          if (ctx.json) {
            printOutput(result, { json: true });
            return;
          }

          console.log(
            `Imported ${result.items.length} template file(s) from ${payload.rootPath ?? inputPath}. warnings=${result.warnings.length}`,
          );
          for (const item of result.items) {
            console.log(
              formatInlineRecord({
                path: item.path,
                id: item.template.id,
                name: item.template.name,
                archetypeKey: item.template.archetypeKey,
                revision: item.revision.revisionNumber,
                created: item.created,
                revisionCreated: item.revisionCreated,
              }),
            );
          }
          for (const warning of result.warnings) {
            console.log(`warning=${warning}`);
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}
