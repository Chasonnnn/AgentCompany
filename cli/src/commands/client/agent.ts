import { Command } from "commander";
import type { Agent, AgentProjectPlacementInput, Project } from "@paperclipai/shared";
import {
  removeMaintainerOnlySkillSymlinks,
  resolvePaperclipSkillsDir,
} from "@paperclipai/adapter-utils/server-utils";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  addCommonClientOptions,
  formatInlineRecord,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";
import { resolveAgentTemplateRef } from "./agent-template.js";

interface AgentListOptions extends BaseClientOptions {
  companyId?: string;
}

interface AgentLocalCliOptions extends BaseClientOptions {
  companyId?: string;
  keyName?: string;
  installSkills?: boolean;
}

interface AgentHireOptions extends BaseClientOptions {
  companyId?: string;
  template?: string;
  templateRevisionId?: string;
  name?: string;
  role?: string;
  title?: string;
  adapterType?: string;
  budgetMonthlyCents?: number;
  reportsTo?: string;
  adapterConfig?: string;
  runtimeConfig?: string;
  project?: string;
  projectRole?: string;
  scopeMode?: string;
  teamFunctionKey?: string;
  teamFunctionLabel?: string;
  workstreamKey?: string;
  workstreamLabel?: string;
  placementReason?: string;
}

interface AgentPlaceOptions extends BaseClientOptions {
  companyId?: string;
  project?: string;
  projectRole?: string;
  scopeMode?: string;
  teamFunctionKey?: string;
  teamFunctionLabel?: string;
  workstreamKey?: string;
  workstreamLabel?: string;
  placementReason?: string;
}

interface AgentRepairDefaultsOptions extends BaseClientOptions {
  companyId?: string;
}

interface CreatedAgentKey {
  id: string;
  name: string;
  token: string;
  createdAt: string;
}

interface SkillsInstallSummary {
  tool: "codex" | "claude";
  target: string;
  linked: string[];
  removed: string[];
  skipped: string[];
  failed: Array<{ name: string; error: string }>;
}

interface AgentApprovalRecord {
  id: string;
  type: string;
  status: string;
}

interface AgentHireResult {
  agent: Agent;
  approval: AgentApprovalRecord | null;
}

interface RepairedInstructionsBundleResult {
  createdFiles: string[];
  bundle: {
    mode: string;
    rootPath: string | null;
    entryFile: string;
  };
}

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

function codexSkillsHome(): string {
  const fromEnv = process.env.CODEX_HOME?.trim();
  const base = fromEnv && fromEnv.length > 0 ? fromEnv : path.join(os.homedir(), ".codex");
  return path.join(base, "skills");
}

function claudeSkillsHome(): string {
  const fromEnv = process.env.CLAUDE_HOME?.trim();
  const base = fromEnv && fromEnv.length > 0 ? fromEnv : path.join(os.homedir(), ".claude");
  return path.join(base, "skills");
}

async function installSkillsForTarget(
  sourceSkillsDir: string,
  targetSkillsDir: string,
  tool: "codex" | "claude",
): Promise<SkillsInstallSummary> {
  const summary: SkillsInstallSummary = {
    tool,
    target: targetSkillsDir,
    linked: [],
    removed: [],
    skipped: [],
    failed: [],
  };

  await fs.mkdir(targetSkillsDir, { recursive: true });
  const entries = await fs.readdir(sourceSkillsDir, { withFileTypes: true });
  summary.removed = await removeMaintainerOnlySkillSymlinks(
    targetSkillsDir,
    entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
  );
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const source = path.join(sourceSkillsDir, entry.name);
    const target = path.join(targetSkillsDir, entry.name);
    const existing = await fs.lstat(target).catch(() => null);
    if (existing) {
      if (existing.isSymbolicLink()) {
        let linkedPath: string | null = null;
        try {
          linkedPath = await fs.readlink(target);
        } catch (err) {
          await fs.unlink(target);
          try {
            await fs.symlink(source, target);
            summary.linked.push(entry.name);
            continue;
          } catch (linkErr) {
            summary.failed.push({
              name: entry.name,
              error:
                err instanceof Error && linkErr instanceof Error
                  ? `${err.message}; then ${linkErr.message}`
                  : err instanceof Error
                    ? err.message
                    : `Failed to recover broken symlink: ${String(err)}`,
            });
            continue;
          }
        }

        const resolvedLinkedPath = path.isAbsolute(linkedPath)
          ? linkedPath
          : path.resolve(path.dirname(target), linkedPath);
        const linkedTargetExists = await fs
          .stat(resolvedLinkedPath)
          .then(() => true)
          .catch(() => false);

        if (!linkedTargetExists) {
          await fs.unlink(target);
        } else {
          summary.skipped.push(entry.name);
          continue;
        }
      } else {
        summary.skipped.push(entry.name);
        continue;
      }
    }

    try {
      await fs.symlink(source, target);
      summary.linked.push(entry.name);
    } catch (err) {
      summary.failed.push({
        name: entry.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return summary;
}

function buildAgentEnvExports(input: {
  apiBase: string;
  companyId: string;
  agentId: string;
  apiKey: string;
}): string {
  const escaped = (value: string) => value.replace(/'/g, "'\"'\"'");
  return [
    `export PAPERCLIP_API_URL='${escaped(input.apiBase)}'`,
    `export PAPERCLIP_COMPANY_ID='${escaped(input.companyId)}'`,
    `export PAPERCLIP_AGENT_ID='${escaped(input.agentId)}'`,
    `export PAPERCLIP_API_KEY='${escaped(input.apiKey)}'`,
  ].join("\n");
}

function parseOptionalObjectJson(
  label: string,
  value: string | undefined,
): Record<string, unknown> | undefined {
  if (!value || !value.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(
      `${label} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} must decode to a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

async function resolveAgentByRef(
  ctx: ReturnType<typeof resolveCommandContext>,
  companyId: string,
  agentRef: string,
): Promise<Agent> {
  const query = new URLSearchParams({ companyId });
  const agentRow = await ctx.api.get<Agent>(
    `/api/agents/${encodeURIComponent(agentRef)}?${query.toString()}`,
  );
  if (!agentRow) {
    throw new Error(`Agent not found: ${agentRef}`);
  }
  return agentRow;
}

async function resolveProjectByRef(
  ctx: ReturnType<typeof resolveCommandContext>,
  companyId: string,
  projectRef: string,
): Promise<Project> {
  const query = new URLSearchParams({ companyId });
  const projectRow = await ctx.api.get<Project>(
    `/api/projects/${encodeURIComponent(projectRef)}?${query.toString()}`,
  );
  if (!projectRow) {
    throw new Error(`Project not found: ${projectRef}`);
  }
  return projectRow;
}

function normalizeOptionalFlag(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function buildProjectPlacementPayload(
  projectId: string,
  options: {
    projectRole?: string;
    scopeMode?: string;
    teamFunctionKey?: string;
    teamFunctionLabel?: string;
    workstreamKey?: string;
    workstreamLabel?: string;
    placementReason?: string;
  },
): AgentProjectPlacementInput {
  const payload: AgentProjectPlacementInput = { projectId };
  const projectRole = normalizeOptionalFlag(options.projectRole);
  const scopeMode = normalizeOptionalFlag(options.scopeMode);
  const teamFunctionKey = normalizeOptionalFlag(options.teamFunctionKey);
  const teamFunctionLabel = normalizeOptionalFlag(options.teamFunctionLabel);
  const workstreamKey = normalizeOptionalFlag(options.workstreamKey);
  const workstreamLabel = normalizeOptionalFlag(options.workstreamLabel);
  const requestedReason = normalizeOptionalFlag(options.placementReason);

  if (projectRole) payload.projectRole = projectRole as AgentProjectPlacementInput["projectRole"];
  if (scopeMode) payload.scopeMode = scopeMode as AgentProjectPlacementInput["scopeMode"];
  if (teamFunctionKey) payload.teamFunctionKey = teamFunctionKey;
  if (teamFunctionLabel) payload.teamFunctionLabel = teamFunctionLabel;
  if (workstreamKey) payload.workstreamKey = workstreamKey;
  if (workstreamLabel) payload.workstreamLabel = workstreamLabel;
  if (requestedReason) payload.requestedReason = requestedReason;
  return payload;
}

async function resolveProjectPlacementPayload(
  ctx: ReturnType<typeof resolveCommandContext>,
  companyId: string,
  options: {
    project?: string;
    projectRole?: string;
    scopeMode?: string;
    teamFunctionKey?: string;
    teamFunctionLabel?: string;
    workstreamKey?: string;
    workstreamLabel?: string;
    placementReason?: string;
  },
): Promise<AgentProjectPlacementInput | undefined> {
  const projectRef = normalizeOptionalFlag(options.project);
  if (!projectRef) return undefined;
  const project = await resolveProjectByRef(ctx, companyId, projectRef);
  return buildProjectPlacementPayload(project.id, options);
}

export function registerAgentCommands(program: Command): void {
  const agent = program.command("agent").description("Agent operations");

  addCommonClientOptions(
    agent
      .command("list")
      .description("List agents for a company")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .action(async (opts: AgentListOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = (await ctx.api.get<Agent[]>(`/api/companies/${ctx.companyId}/agents`)) ?? [];

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
                status: row.status,
                reportsTo: row.reportsTo,
                budgetMonthlyCents: row.budgetMonthlyCents,
                spentMonthlyCents: row.spentMonthlyCents,
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
    agent
      .command("get")
      .description("Get one agent")
      .argument("<agentId>", "Agent ID")
      .action(async (agentId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<Agent>(`/api/agents/${agentId}`);
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("hire")
      .description("Create a new agent hire, optionally from a reusable template")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .requiredOption("--template <templateRef>", "Template id, exact archetypeKey, or exact template name")
      .option("--template-revision-id <id>", "Pin a specific template revision")
      .option("--name <name>", "Override the hired agent name")
      .option("--role <role>", "Override the hired agent role")
      .option("--title <title>", "Override the hired agent title")
      .option("--adapter-type <adapterType>", "Override the adapter type")
      .option("--budget-monthly-cents <cents>", "Override budget in cents", (value) => Number(value))
      .option("--reports-to <agentRef>", "Manager agent id or ref to resolve into reportsTo")
      .option("--adapter-config <json>", "Adapter config override as a JSON object")
      .option("--runtime-config <json>", "Runtime config override as a JSON object")
      .option("--project <projectRef>", "Primary project id, shortname, or exact project name")
      .option("--project-role <role>", "Explicit project role override")
      .option("--scope-mode <mode>", "Explicit scope mode override")
      .option("--team-function-key <key>", "Team/function grouping key for the primary scope")
      .option("--team-function-label <label>", "Team/function grouping label for the primary scope")
      .option("--workstream-key <key>", "Optional workstream grouping key")
      .option("--workstream-label <label>", "Optional workstream grouping label")
      .option("--placement-reason <text>", "Why this agent is being placed on the project")
      .action(async (opts: AgentHireOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const template = await resolveAgentTemplateRef(ctx, ctx.companyId!, opts.template!);
          const reportsToAgent = opts.reportsTo
            ? await resolveAgentByRef(ctx, ctx.companyId!, opts.reportsTo)
            : null;
          const payload: Record<string, unknown> = {
            templateId: template.id,
          };
          if (opts.templateRevisionId?.trim()) payload.templateRevisionId = opts.templateRevisionId.trim();
          if (opts.name?.trim()) payload.name = opts.name.trim();
          if (opts.role?.trim()) payload.role = opts.role.trim();
          if (opts.title?.trim()) payload.title = opts.title.trim();
          if (opts.adapterType?.trim()) payload.adapterType = opts.adapterType.trim();
          if (typeof opts.budgetMonthlyCents === "number" && Number.isFinite(opts.budgetMonthlyCents)) {
            payload.budgetMonthlyCents = Math.trunc(opts.budgetMonthlyCents);
          }
          if (reportsToAgent) payload.reportsTo = reportsToAgent.id;
          const adapterConfig = parseOptionalObjectJson("--adapter-config", opts.adapterConfig);
          if (adapterConfig) payload.adapterConfig = adapterConfig;
          const runtimeConfig = parseOptionalObjectJson("--runtime-config", opts.runtimeConfig);
          if (runtimeConfig) payload.runtimeConfig = runtimeConfig;
          const projectPlacement = await resolveProjectPlacementPayload(ctx, ctx.companyId!, opts);
          if (projectPlacement) payload.projectPlacement = projectPlacement;

          const result = await ctx.api.post<AgentHireResult>(
            `/api/companies/${ctx.companyId}/agent-hires`,
            payload,
          );
          if (!result) {
            throw new Error("Agent hire returned no result.");
          }

          if (ctx.json) {
            printOutput(result, { json: true });
            return;
          }

          console.log(
            formatInlineRecord({
              id: result.agent.id,
              name: result.agent.name,
              role: result.agent.role,
              status: result.agent.status,
              templateId: template.id,
              approvalId: result.approval?.id ?? null,
              approvalStatus: result.approval?.status ?? null,
              projectId: projectPlacement?.projectId ?? null,
            }),
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    agent
      .command("place")
      .description("Apply or replace an agent's primary project placement")
      .argument("<agentRef>", "Agent ID or shortname/url-key")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .requiredOption("--project <projectRef>", "Primary project id, shortname, or exact project name")
      .option("--project-role <role>", "Explicit project role override")
      .option("--scope-mode <mode>", "Explicit scope mode override")
      .option("--team-function-key <key>", "Team/function grouping key for the primary scope")
      .option("--team-function-label <label>", "Team/function grouping label for the primary scope")
      .option("--workstream-key <key>", "Optional workstream grouping key")
      .option("--workstream-label <label>", "Optional workstream grouping label")
      .option("--placement-reason <text>", "Why this agent is being placed on the project")
      .action(async (agentRef: string, opts: AgentPlaceOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const agentRow = await resolveAgentByRef(ctx, ctx.companyId!, agentRef);
          const projectPlacement = await resolveProjectPlacementPayload(ctx, ctx.companyId!, opts);
          if (!projectPlacement) {
            throw new Error("Project placement requires --project");
          }

          const result = await ctx.api.post<{
            agent: Agent | null;
            scope: Record<string, unknown>;
          }>(`/api/agents/${agentRow.id}/project-placement`, projectPlacement);
          if (!result) {
            throw new Error("Agent placement returned no result.");
          }

          if (ctx.json) {
            printOutput(result, { json: true });
            return;
          }

          console.log(
            formatInlineRecord({
              id: agentRow.id,
              name: result.agent?.name ?? agentRow.name,
              projectId: projectPlacement.projectId,
              projectRole: (result.scope.projectRole as string | undefined) ?? projectPlacement.projectRole ?? null,
              scopeMode: (result.scope.scopeMode as string | undefined) ?? projectPlacement.scopeMode ?? null,
            }),
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    agent
      .command("local-cli")
      .description(
        "Create an agent API key, install local Paperclip skills for Codex/Claude, and print shell exports",
      )
      .argument("<agentRef>", "Agent ID or shortname/url-key")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .option("--key-name <name>", "API key label", "local-cli")
      .option(
        "--no-install-skills",
        "Skip installing Paperclip skills into ~/.codex/skills and ~/.claude/skills",
      )
      .action(async (agentRef: string, opts: AgentLocalCliOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const query = new URLSearchParams({ companyId: ctx.companyId ?? "" });
          const agentRow = await ctx.api.get<Agent>(
            `/api/agents/${encodeURIComponent(agentRef)}?${query.toString()}`,
          );
          if (!agentRow) {
            throw new Error(`Agent not found: ${agentRef}`);
          }

          const now = new Date().toISOString().replaceAll(":", "-");
          const keyName = opts.keyName?.trim() ? opts.keyName.trim() : `local-cli-${now}`;
          const key = await ctx.api.post<CreatedAgentKey>(`/api/agents/${agentRow.id}/keys`, { name: keyName });
          if (!key) {
            throw new Error("Failed to create API key");
          }

          const installSummaries: SkillsInstallSummary[] = [];
          if (opts.installSkills !== false) {
            const skillsDir = await resolvePaperclipSkillsDir(__moduleDir, [path.resolve(process.cwd(), "skills")]);
            if (!skillsDir) {
              throw new Error(
                "Could not locate local Paperclip skills directory. Expected ./skills in the repo checkout.",
              );
            }

            installSummaries.push(
              await installSkillsForTarget(skillsDir, codexSkillsHome(), "codex"),
              await installSkillsForTarget(skillsDir, claudeSkillsHome(), "claude"),
            );
          }

          const exportsText = buildAgentEnvExports({
            apiBase: ctx.api.apiBase,
            companyId: agentRow.companyId,
            agentId: agentRow.id,
            apiKey: key.token,
          });

          if (ctx.json) {
            printOutput(
              {
                agent: {
                  id: agentRow.id,
                  name: agentRow.name,
                  urlKey: agentRow.urlKey,
                  companyId: agentRow.companyId,
                },
                key: {
                  id: key.id,
                  name: key.name,
                  createdAt: key.createdAt,
                  token: key.token,
                },
                skills: installSummaries,
                exports: exportsText,
              },
              { json: true },
            );
            return;
          }

          console.log(`Agent: ${agentRow.name} (${agentRow.id})`);
          console.log(`API key created: ${key.name} (${key.id})`);
          if (installSummaries.length > 0) {
            for (const summary of installSummaries) {
              console.log(
                `${summary.tool}: linked=${summary.linked.length} removed=${summary.removed.length} skipped=${summary.skipped.length} failed=${summary.failed.length} target=${summary.target}`,
              );
              for (const failed of summary.failed) {
                console.log(`  failed ${failed.name}: ${failed.error}`);
              }
            }
          }
          console.log("");
          console.log("# Run this in your shell before launching codex/claude:");
          console.log(exportsText);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    agent
      .command("repair-default-files")
      .description("Create missing default AGENTS.md and MEMORY.md files for one managed agent bundle")
      .argument("<agentRef>", "Agent ID or shortname/url-key")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .action(async (agentRef: string, opts: AgentRepairDefaultsOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const agentRow = await resolveAgentByRef(ctx, ctx.companyId!, agentRef);
          const result = await ctx.api.post<RepairedInstructionsBundleResult>(
            `/api/agents/${agentRow.id}/instructions-bundle/repair-defaults`,
          );
          if (!result) {
            throw new Error("Repair returned no result.");
          }

          if (ctx.json) {
            printOutput(
              {
                agent: {
                  id: agentRow.id,
                  name: agentRow.name,
                  companyId: agentRow.companyId,
                },
                ...result,
              },
              { json: true },
            );
            return;
          }

          console.log(
            formatInlineRecord({
              id: agentRow.id,
              name: agentRow.name,
              createdFiles: result.createdFiles.join(",") || "none",
              bundleMode: result.bundle.mode,
              entryFile: result.bundle.entryFile,
            }),
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}
