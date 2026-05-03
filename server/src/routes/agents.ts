import { Router, type Request } from "express";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import { agents as agentsTable, companies, heartbeatRuns, issues as issuesTable } from "@paperclipai/db";
import { and, desc, eq, inArray, not, sql } from "drizzle-orm";
import {
  AGENT_DEFAULT_MAX_CONCURRENT_RUNS,
  AGENT_NAVIGATION_LAYOUTS,
  agentProjectPlacementInputSchema,
  agentTemplateSnapshotSchema,
  agentSkillSyncSchema,
  companyOfficeOperatorAdoptionSchema,
  agentMineInboxQuerySchema,
  orgSimplificationArchiveRequestSchema,
  orgSimplificationConvertSharedServiceRequestSchema,
  orgSimplificationReparentReportsRequestSchema,
  createAgentKeySchema,
  createAgentHireSchema,
  createAgentSchema,
  deriveAgentUrlKey,
  getDefaultDesiredSkillSlugsForAgent,
  groupOperatorState,
  isUuidLike,
  resetAgentSessionSchema,
  testAdapterEnvironmentSchema,
  type AgentRole,
  type ComputedAgentWaitingOn,
  type InstanceSchedulerHeartbeatAgent,
  upsertAgentInstructionsFileSchema,
  upsertMemoryFileSchema,
  updateAgentInstructionsBundleSchema,
  updateAgentPermissionsSchema,
  updateAgentInstructionsPathSchema,
  wakeAgentSchema,
  updateAgentSchema,
  supportedEnvironmentDriversForAdapter,
} from "@paperclipai/shared";
import { trackAgentCreated } from "@paperclipai/shared/telemetry";
import { validate } from "../middleware/validate.js";
import { logger } from "../middleware/logger.js";
import { buildIssueContinuitySummary } from "../services/issue-continuity-summary.js";
import { buildIssueOperatorState } from "../services/issue-operator-state.js";
import {
  agentService,
  agentSkillService,
  agentProjectPlacementService,
  agentTemplateService,
  agentInstructionsService,
  accessService,
  approvalService,
  budgetService,
  environmentService,
  heartbeatService,
  issueApprovalService,
  issueService,
  logActivity as baseLogActivity,
  secretService,
  syncInstructionsBundleConfigFromFilePath,
  workspaceOperationService,
} from "../services/index.js";
import { memoryService } from "../services/memory.js";
import { productivityService } from "../services/productivity.js";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { assertBoard, assertCompanyAccess, assertInstanceAdmin, getActorInfo } from "./authz.js";
import {
  detectAdapterModel,
  findActiveServerAdapter,
  findServerAdapter,
  listAdapterModels,
  listAdapterModelProfiles,
  refreshAdapterModels,
  requireServerAdapter,
} from "../adapters/index.js";
import type { AdapterEnvironmentCheck } from "@paperclipai/adapter-utils";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { redactEventPayload } from "../redaction.js";
import { redactCurrentUserValue } from "../log-redaction.js";
import { renderOrgChartSvg, renderOrgChartPng, type OrgNode, type OrgChartStyle, ORG_CHART_STYLES } from "./org-chart-svg.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { loadConfig } from "../config.js";
import { resolveHomeAwarePath } from "../home-paths.js";
import { runClaudeLogin } from "@paperclipai/adapter-claude-local/server";
import {
  defaultCodexLocalFastModeForModel,
  DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX,
  DEFAULT_CODEX_LOCAL_MODEL,
} from "@paperclipai/adapter-codex-local";
import { DEFAULT_CURSOR_LOCAL_MODEL } from "@paperclipai/adapter-cursor-local";
import { DEFAULT_GEMINI_LOCAL_MODEL } from "@paperclipai/adapter-gemini-local";
import { ensureOpenCodeModelConfiguredAndAvailable } from "@paperclipai/adapter-opencode-local/server";
import {
  withCanonicalAgentMemoryContract,
  loadDefaultAgentInstructionsBundle,
  resolveDefaultAgentInstructionsBundleRole,
} from "../services/default-agent-instructions.js";
import { getTelemetryClient } from "../telemetry.js";
import { agentHasCreatePermission } from "../services/agent-permissions.js";
import { ISSUE_LIST_DEFAULT_LIMIT } from "../services/issues.js";
import {
  assertNoAgentHostWorkspaceCommandMutation,
  collectAgentAdapterWorkspaceCommandPaths,
} from "./workspace-command-authz.js";
import { assertEnvironmentSelectionForCompany } from "./environment-selection.js";
import { resolveEnvironmentExecutionTarget } from "../services/environment-execution-target.js";

type AgentRouteDeps = {
  agentService: ReturnType<typeof agentService>;
  accessService: ReturnType<typeof accessService>;
  agentProjectPlacementService: ReturnType<typeof agentProjectPlacementService>;
  agentTemplateService: ReturnType<typeof agentTemplateService>;
  approvalService: ReturnType<typeof approvalService>;
  agentSkillService: ReturnType<typeof agentSkillService>;
  budgetService: ReturnType<typeof budgetService>;
  environmentService: ReturnType<typeof environmentService>;
  heartbeatService: ReturnType<typeof heartbeatService>;
  issueApprovalService: ReturnType<typeof issueApprovalService>;
  issueService: ReturnType<typeof issueService>;
  logActivity: typeof baseLogActivity;
  secretService: ReturnType<typeof secretService>;
  agentInstructionsService: ReturnType<typeof agentInstructionsService>;
  memoryService: ReturnType<typeof memoryService>;
  productivityService: ReturnType<typeof productivityService>;
  workspaceOperationService: ReturnType<typeof workspaceOperationService>;
  instanceSettingsService: ReturnType<typeof instanceSettingsService>;
};

const RUN_LOG_DEFAULT_LIMIT_BYTES = 256_000;
const RUN_LOG_MAX_LIMIT_BYTES = 1024 * 1024;

function readRunLogLimitBytes(value: unknown) {
  const parsed = Number(value ?? RUN_LOG_DEFAULT_LIMIT_BYTES);
  if (!Number.isFinite(parsed)) return RUN_LOG_DEFAULT_LIMIT_BYTES;
  return Math.max(1, Math.min(RUN_LOG_MAX_LIMIT_BYTES, Math.trunc(parsed)));
}

function readLiveRunsQueryInt(value: unknown, max: number, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed <= 0) return fallback;
  return Math.min(max, Math.trunc(parsed));
}

export function agentRoutes(
  db: Db,
  opts?: {
    services?: Partial<AgentRouteDeps>;
    telemetry?: {
      getTelemetryClient?: typeof getTelemetryClient;
      trackAgentCreated?: typeof trackAgentCreated;
    };
  },
) {
  // Legacy hardcoded maps — used as fallback when adapter module does not
  // declare capability flags explicitly.
  const DEFAULT_INSTRUCTIONS_PATH_KEYS: Record<string, string> = {
    claude_local: "instructionsFilePath",
    codex_local: "instructionsFilePath",
    droid_local: "instructionsFilePath",
    gemini_local: "instructionsFilePath",
    hermes_local: "instructionsFilePath",
    opencode_local: "instructionsFilePath",
    cursor: "instructionsFilePath",
    pi_local: "instructionsFilePath",
  };
  const DEFAULT_MANAGED_INSTRUCTIONS_ADAPTER_TYPES = new Set(Object.keys(DEFAULT_INSTRUCTIONS_PATH_KEYS));

  /** Check if an adapter supports the managed instructions bundle. */
  function adapterSupportsInstructionsBundle(adapterType: string): boolean {
    const adapter = findActiveServerAdapter(adapterType);
    if (adapter?.supportsInstructionsBundle !== undefined) return adapter.supportsInstructionsBundle;
    return DEFAULT_MANAGED_INSTRUCTIONS_ADAPTER_TYPES.has(adapterType);
  }

  /** Resolve the adapter config key for the instructions file path. */
  function resolveInstructionsPathKey(adapterType: string): string | null {
    const adapter = findActiveServerAdapter(adapterType);
    if (adapter?.instructionsPathKey) return adapter.instructionsPathKey;
    if (adapter?.supportsInstructionsBundle === true) return "instructionsFilePath";
    if (adapter?.supportsInstructionsBundle === false) return null;
    return DEFAULT_INSTRUCTIONS_PATH_KEYS[adapterType] ?? null;
  }
  const KNOWN_INSTRUCTIONS_PATH_KEYS = new Set(["instructionsFilePath", "agentsMdPath"]);
  const KNOWN_INSTRUCTIONS_BUNDLE_KEYS = [
    "instructionsBundleMode",
    "instructionsBundleRole",
    "instructionsRootPolicy",
    "instructionsMemoryOwnership",
    "instructionsRootPath",
    "instructionsEntryFile",
    "instructionsFilePath",
    "agentsMdPath",
  ] as const;

  const router = Router();
  const svc = opts?.services?.agentService ?? agentService(db);
  const access = opts?.services?.accessService ?? accessService(db);
  const placementSvc =
    opts?.services?.agentProjectPlacementService ?? agentProjectPlacementService(db);
  const templateSvc = opts?.services?.agentTemplateService ?? agentTemplateService(db);
  const approvalsSvc = opts?.services?.approvalService ?? approvalService(db);
  const budgets = opts?.services?.budgetService ?? budgetService(db);
  const environmentsSvc = opts?.services?.environmentService ?? environmentService(db);
  const heartbeat = opts?.services?.heartbeatService ?? heartbeatService(db);
  const issueApprovalsSvc =
    opts?.services?.issueApprovalService ?? issueApprovalService(db);
  const issuesSvc = opts?.services?.issueService ?? issueService(db);
  const secretsSvc = opts?.services?.secretService ?? secretService(db);
  const instructions =
    opts?.services?.agentInstructionsService ?? agentInstructionsService();
  const memory = opts?.services?.memoryService ?? memoryService();
  const productivity = opts?.services?.productivityService ?? productivityService(db);
  const skillSync = opts?.services?.agentSkillService ?? agentSkillService(db);
  const workspaceOperations =
    opts?.services?.workspaceOperationService ?? workspaceOperationService(db);
  const instanceSettings =
    opts?.services?.instanceSettingsService ?? instanceSettingsService(db);
  const buildOutputSilence = async (run: any) =>
    typeof heartbeat.buildRunOutputSilence === "function"
      ? heartbeat.buildRunOutputSilence(run)
      : undefined;
  const runtimeConfig = loadConfig();
  const logActivity = opts?.services?.logActivity ?? baseLogActivity;
  const getTelemetryClientFn =
    opts?.telemetry?.getTelemetryClient ?? getTelemetryClient;
  const trackAgentCreatedFn =
    opts?.telemetry?.trackAgentCreated ?? trackAgentCreated;
  const strictSecretsMode = process.env.PAPERCLIP_SECRETS_STRICT_MODE === "true";

  async function assertAgentEnvironmentSelection(
    companyId: string,
    adapterType: string,
    environmentId: string | null | undefined,
  ) {
    if (environmentId === undefined || environmentId === null) return;
    await assertEnvironmentSelectionForCompany(environmentsSvc, companyId, environmentId, {
      allowedDrivers: allowedEnvironmentDriversForAgent(adapterType),
    });
  }

  /**
   * Resolve the execution target the adapter should run its test probes against.
   *
   * - No environmentId / local environment → returns a local target so the
   *   adapter probes the Paperclip host (legacy behavior).
   * - SSH environment → builds an SSH execution target from the environment
   *   config so the adapter probes the remote box. No lease is required:
   *   the SSH spec is fully derived from the saved environment config.
   * - Sandbox / plugin environments → currently fall back to local probing
   *   with a warning check, since lifting a temporary sandbox lease for an
   *   ad-hoc test invocation is out of scope for this iteration.
   */
  async function resolveAdapterTestExecutionContext(input: {
    companyId: string;
    adapterType: string;
    environmentId: string | null;
  }): Promise<{
    executionTarget: AdapterExecutionTarget | null;
    environmentName: string | null;
    fallbackChecks: AdapterEnvironmentCheck[];
  }> {
    if (!input.environmentId) {
      return { executionTarget: null, environmentName: null, fallbackChecks: [] };
    }

    const environment = await environmentsSvc.getById(input.environmentId);
    if (!environment || environment.companyId !== input.companyId) {
      return {
        executionTarget: null,
        environmentName: null,
        fallbackChecks: [
          {
            code: "environment_not_found",
            level: "warn",
            message: "Selected environment was not found. Falling back to a local probe.",
          },
        ],
      };
    }

    if (environment.driver === "local") {
      return { executionTarget: null, environmentName: environment.name, fallbackChecks: [] };
    }

    if (environment.driver === "ssh") {
      try {
        const target = await resolveEnvironmentExecutionTarget({
          db,
          companyId: input.companyId,
          adapterType: input.adapterType,
          environment: {
            id: environment.id,
            driver: environment.driver,
            config: environment.config ?? null,
          },
          leaseMetadata: null,
        });
        if (target) {
          return { executionTarget: target, environmentName: environment.name, fallbackChecks: [] };
        }
        return {
          executionTarget: null,
          environmentName: environment.name,
          fallbackChecks: [
            {
              code: "environment_target_unavailable",
              level: "warn",
              message:
                `Could not resolve an execution target for environment "${environment.name}". Falling back to a local probe.`,
            },
          ],
        };
      } catch (err) {
        return {
          executionTarget: null,
          environmentName: environment.name,
          fallbackChecks: [
            {
              code: "environment_target_failed",
              level: "warn",
              message:
                `Could not connect to environment "${environment.name}" to run the test. Falling back to a local probe.`,
              detail: err instanceof Error ? err.message : String(err),
            },
          ],
        };
      }
    }

    // sandbox / plugin / other drivers: not yet supported for ad-hoc adapter tests.
    return {
      executionTarget: null,
      environmentName: environment.name,
      fallbackChecks: [
        {
          code: "environment_driver_not_supported_for_test",
          level: "warn",
          message:
            `Adapter testing inside ${environment.driver} environments is not yet supported. Falling back to a local probe; results may not reflect runs in "${environment.name}".`,
          hint: "Run a real heartbeat in the environment to verify end-to-end behavior.",
        },
      ],
    };
  }

  async function getCurrentUserRedactionOptions() {
    return {
      enabled: (await instanceSettings.getGeneral()).censorUsernameInLogs,
    };
  }

  async function buildAgentAccessState(agent: NonNullable<Awaited<ReturnType<typeof svc.getById>>>) {
    const membership = await access.getMembership(agent.companyId, "agent", agent.id);
    const grants = membership
      ? await access.listPrincipalGrants(agent.companyId, "agent", agent.id)
      : [];
    const hasExplicitTaskAssignGrant = grants.some((grant) => grant.permissionKey === "tasks:assign");

    if (agentHasCreatePermission(agent)) {
      return {
        canAssignTasks: true,
        taskAssignSource: "capability_profile" as const,
        membership,
        grants,
      };
    }

    if (hasExplicitTaskAssignGrant) {
      return {
        canAssignTasks: true,
        taskAssignSource: "explicit_grant" as const,
        membership,
        grants,
      };
    }

    return {
      canAssignTasks: false,
      taskAssignSource: "none" as const,
      membership,
      grants,
    };
  }

  async function buildAgentDetail(
    agent: NonNullable<Awaited<ReturnType<typeof svc.getById>>>,
    options?: { restricted?: boolean },
  ) {
    const [chainOfCommand, accessState] = await Promise.all([
      svc.getChainOfCommand(agent.id),
      buildAgentAccessState(agent),
    ]);

    return {
      ...(options?.restricted ? redactForRestrictedAgentView(agent) : agent),
      chainOfCommand,
      access: accessState,
    };
  }

  async function applyDefaultAgentTaskAssignGrant(
    companyId: string,
    agentId: string,
    grantedByUserId: string | null,
  ) {
    await access.ensureMembership(companyId, "agent", agentId, "member", "active");
    await access.setPrincipalPermission(
      companyId,
      "agent",
      agentId,
      "tasks:assign",
      true,
      grantedByUserId,
    );
  }

  async function assertCanCreateAgentsForCompany(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "board") {
      if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return null;
      const allowed = await access.canUser(companyId, req.actor.userId, "agents:create");
      if (!allowed) {
        throw forbidden("Missing permission: agents:create");
      }
      return null;
    }
    if (!req.actor.agentId) throw forbidden("Agent authentication required");
    const actorAgent = await svc.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== companyId) {
      throw forbidden("Agent key cannot access another company");
    }
    const allowedByGrant = await access.hasPermission(companyId, "agent", actorAgent.id, "agents:create");
    if (!allowedByGrant && !agentHasCreatePermission(actorAgent)) {
      throw forbidden("Missing permission: can create agents");
    }
    return actorAgent;
  }

  async function assertCanReadConfigurations(req: Request, companyId: string) {
    return assertCanCreateAgentsForCompany(req, companyId);
  }

  async function actorCanReadConfigurationsForCompany(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "board") {
      if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return true;
      return access.canUser(companyId, req.actor.userId, "agents:create");
    }
    if (!req.actor.agentId) return false;
    const actorAgent = await svc.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== companyId) return false;
    const allowedByGrant = await access.hasPermission(companyId, "agent", actorAgent.id, "agents:create");
    return allowedByGrant || agentHasCreatePermission(actorAgent);
  }

  async function buildSkippedWakeupResponse(
    agent: NonNullable<Awaited<ReturnType<typeof svc.getById>>>,
    payload: Record<string, unknown> | null | undefined,
  ) {
    const issueId = typeof payload?.issueId === "string" && payload.issueId.trim() ? payload.issueId : null;
    if (!issueId) {
      return {
        status: "skipped" as const,
        reason: "wakeup_skipped",
        message: "Wakeup was skipped.",
        issueId: null,
        executionRunId: null,
        executionAgentId: null,
        executionAgentName: null,
      };
    }

    const issue = await db
      .select({
        id: issuesTable.id,
        executionRunId: issuesTable.executionRunId,
      })
      .from(issuesTable)
      .where(and(eq(issuesTable.id, issueId), eq(issuesTable.companyId, agent.companyId)))
      .then((rows) => rows[0] ?? null);

    if (!issue?.executionRunId) {
      return {
        status: "skipped" as const,
        reason: "wakeup_skipped",
        message: "Wakeup was skipped.",
        issueId,
        executionRunId: null,
        executionAgentId: null,
        executionAgentName: null,
      };
    }

    const executionRun = await heartbeat.getRun(issue.executionRunId);
    if (!executionRun || (executionRun.status !== "queued" && executionRun.status !== "running")) {
      return {
        status: "skipped" as const,
        reason: "wakeup_skipped",
        message: "Wakeup was skipped.",
        issueId,
        executionRunId: issue.executionRunId,
        executionAgentId: null,
        executionAgentName: null,
      };
    }

    const executionAgent = await svc.getById(executionRun.agentId);
    const executionAgentName = executionAgent?.name ?? null;

    return {
      status: "skipped" as const,
      reason: "issue_execution_deferred",
      message: executionAgentName
        ? `Wakeup was deferred because this issue is already being executed by ${executionAgentName}.`
        : "Wakeup was deferred because this issue already has an active execution run.",
      issueId,
      executionRunId: executionRun.id,
      executionAgentId: executionRun.agentId,
      executionAgentName,
    };
  }

  async function assertCanUpdateAgent(req: Request, targetAgent: { id: string; companyId: string }) {
    assertCompanyAccess(req, targetAgent.companyId);
    if (req.actor.type === "board") return;
    if (!req.actor.agentId) throw forbidden("Agent authentication required");

    const actorAgent = await svc.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== targetAgent.companyId) {
      throw forbidden("Agent key cannot access another company");
    }

    if (actorAgent.id === targetAgent.id) return;
    const allowedByGrant = await access.hasPermission(
      targetAgent.companyId,
      "agent",
      actorAgent.id,
      "agents:create",
    );
    if (allowedByGrant || agentHasCreatePermission(actorAgent)) return;
    throw forbidden("Only agents with create authority can modify other agents");
  }

  async function assertCanReadAgent(req: Request, targetAgent: { companyId: string }) {
    assertCompanyAccess(req, targetAgent.companyId);
    if (req.actor.type === "board") return;
    if (!req.actor.agentId) throw forbidden("Agent authentication required");

    const actorAgent = await svc.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== targetAgent.companyId) {
      throw forbidden("Agent key cannot access another company");
    }
  }

  async function assertCanWriteAgentMemory(req: Request, targetAgent: { id: string; companyId: string }) {
    assertCompanyAccess(req, targetAgent.companyId);
    if (req.actor.type === "board") return;
    if (!req.actor.agentId) throw forbidden("Agent authentication required");

    const actorAgent = await svc.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== targetAgent.companyId) {
      throw forbidden("Agent key cannot access another company");
    }
    if (actorAgent.id !== targetAgent.id) {
      throw forbidden("Agents may only write their own memory");
    }
  }

  function assertKnownAdapterType(type: string | null | undefined): string {
    const adapterType = typeof type === "string" ? type.trim() : "";
    if (!adapterType) {
      throw unprocessable("Adapter type is required");
    }
    if (!findServerAdapter(adapterType)) {
      throw unprocessable(`Unknown adapter type: ${adapterType}`);
    }
    return adapterType;
  }

  function hasOwn(value: object, key: string): boolean {
    return Object.hasOwn(value, key);
  }

  function allowedEnvironmentDriversForAgent(adapterType: string): string[] {
    return supportedEnvironmentDriversForAdapter(adapterType);
  }

  async function resolveCompanyIdForAgentReference(req: Request): Promise<string | null> {
    const companyIdQuery = req.query.companyId;
    const requestedCompanyId =
      typeof companyIdQuery === "string" && companyIdQuery.trim().length > 0
        ? companyIdQuery.trim()
        : null;
    if (requestedCompanyId) {
      assertCompanyAccess(req, requestedCompanyId);
      return requestedCompanyId;
    }
    if (req.actor.type === "agent" && req.actor.companyId) {
      return req.actor.companyId;
    }
    return null;
  }

  async function normalizeAgentReference(req: Request, rawId: string): Promise<string> {
    const raw = rawId.trim();
    if (isUuidLike(raw)) return raw;

    const companyId = await resolveCompanyIdForAgentReference(req);
    if (!companyId) {
      throw unprocessable("Agent shortname lookup requires companyId query parameter");
    }

    const resolved = await svc.resolveByReference(companyId, raw);
    if (resolved.ambiguous) {
      throw conflict("Agent shortname is ambiguous in this company. Use the agent ID.");
    }
    if (!resolved.agent) {
      throw notFound("Agent not found");
    }
    return resolved.agent.id;
  }

  function parseSourceIssueIds(input: {
    sourceIssueId?: string | null;
    sourceIssueIds?: string[];
  }): string[] {
    const values: string[] = [];
    if (Array.isArray(input.sourceIssueIds)) values.push(...input.sourceIssueIds);
    if (typeof input.sourceIssueId === "string" && input.sourceIssueId.length > 0) {
      values.push(input.sourceIssueId);
    }
    return Array.from(new Set(values));
  }

  function asRecord(value: unknown): Record<string, unknown> | null {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  }

  function asNonEmptyString(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  function readProjectPlacement(value: unknown) {
    const parsed = agentProjectPlacementInputSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  }

  function parseProductivityWindow(value: unknown) {
    return value === "30d" || value === "all" ? value : "7d";
  }

  function placementActorFromRequest(req: Request) {
    const actor = getActorInfo(req);
    return {
      principalType: actor.actorType === "user" ? "human_operator" : "agent_instance",
      principalId: actor.actorId,
    } as const;
  }

  function preserveInstructionsBundleConfig(
    existingAdapterConfig: Record<string, unknown>,
    nextAdapterConfig: Record<string, unknown>,
  ) {
    const nextKeys = new Set(Object.keys(nextAdapterConfig));
    if (KNOWN_INSTRUCTIONS_BUNDLE_KEYS.some((key) => nextKeys.has(key))) {
      return nextAdapterConfig;
    }

    const merged = { ...nextAdapterConfig };
    for (const key of KNOWN_INSTRUCTIONS_BUNDLE_KEYS) {
      if (merged[key] === undefined && existingAdapterConfig[key] !== undefined) {
        merged[key] = existingAdapterConfig[key];
      }
    }
    return merged;
  }

  function parseBooleanLike(value: unknown): boolean | null {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (value === 1) return true;
      if (value === 0) return false;
      return null;
    }
    if (typeof value !== "string") return null;
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") {
      return true;
    }
    if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") {
      return false;
    }
    return null;
  }

  function parseNumberLike(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "string") return null;
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }

  function parseSchedulerHeartbeatPolicy(runtimeConfig: unknown) {
    const heartbeat = asRecord(asRecord(runtimeConfig)?.heartbeat) ?? {};
    return {
      enabled: parseBooleanLike(heartbeat.enabled) ?? false,
      intervalSec: Math.max(0, parseNumberLike(heartbeat.intervalSec) ?? 0),
    };
  }

  function isProjectLeadAgent(agent: {
    role?: string | null;
    archetypeKey?: string | null;
    operatingClass?: string | null;
    status?: string | null;
  }) {
    if (agent.status === "terminated") return false;
    return agent.archetypeKey === "project_lead" || agent.operatingClass === "project_leadership";
  }

  function isOfficeOperatorAgent(agent: {
    role?: string | null;
    archetypeKey?: string | null;
    status?: string | null;
  }) {
    if (agent.status === "terminated") return false;
    return agent.role === "coo" || agent.archetypeKey === "chief_of_staff";
  }

  function normalizeNewAgentRuntimeConfig(runtimeConfig: unknown): Record<string, unknown> {
    const parsedRuntimeConfig = asRecord(runtimeConfig);
    const normalizedRuntimeConfig = parsedRuntimeConfig ? { ...parsedRuntimeConfig } : {};
    const parsedHeartbeat = asRecord(normalizedRuntimeConfig.heartbeat);
    const heartbeat = parsedHeartbeat ? { ...parsedHeartbeat } : {};

    if (parseBooleanLike(heartbeat.enabled) == null) {
      heartbeat.enabled = false;
    }
    if (parseNumberLike(heartbeat.maxConcurrentRuns) == null) {
      heartbeat.maxConcurrentRuns = AGENT_DEFAULT_MAX_CONCURRENT_RUNS;
    }

    normalizedRuntimeConfig.heartbeat = heartbeat;
    return normalizedRuntimeConfig;
  }

  function listRuntimeModelProfileAdapterConfigs(runtimeConfig: unknown): Array<{
    profileKey: string;
    profile: Record<string, unknown>;
    adapterConfig: Record<string, unknown>;
    path: string;
  }> {
    const runtimeRecord = asRecord(runtimeConfig);
    const modelProfiles = asRecord(runtimeRecord?.modelProfiles);
    if (!modelProfiles) return [];

    const entries: Array<{
      profileKey: string;
      profile: Record<string, unknown>;
      adapterConfig: Record<string, unknown>;
      path: string;
    }> = [];
    for (const [profileKey, rawProfile] of Object.entries(modelProfiles)) {
      const profile = asRecord(rawProfile);
      const adapterConfig = asRecord(profile?.adapterConfig);
      if (!profile || !adapterConfig) continue;
      entries.push({
        profileKey,
        profile,
        adapterConfig,
        path: `runtimeConfig.modelProfiles.${profileKey}.adapterConfig`,
      });
    }
    return entries;
  }

  function assertNoAgentRuntimeConfigAdapterConfigMutation(req: Request, runtimeConfig: unknown) {
    for (const entry of listRuntimeModelProfileAdapterConfigs(runtimeConfig)) {
      assertNoAgentAdapterConfigMutation(req, entry.adapterConfig, entry.path);
    }
  }

  async function normalizeMediatedAdapterConfigForPersistence(input: {
    companyId: string;
    adapterType: string | null | undefined;
    adapterConfig: Record<string, unknown>;
    constraintAdapterConfig?: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    const normalizedAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
      input.companyId,
      input.adapterConfig,
      { strictMode: strictSecretsMode },
    );
    await assertAdapterConfigConstraints(
      input.companyId,
      input.adapterType,
      input.constraintAdapterConfig
        ? { ...input.constraintAdapterConfig, ...normalizedAdapterConfig }
        : normalizedAdapterConfig,
    );
    return normalizedAdapterConfig;
  }

  async function normalizeRuntimeConfigAdapterConfigsForPersistence(
    companyId: string,
    adapterType: string,
    runtimeConfig: Record<string, unknown>,
    baseAdapterConfig: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const entries = listRuntimeModelProfileAdapterConfigs(runtimeConfig);
    if (entries.length === 0) return runtimeConfig;
    const adapterModelProfiles = await listAdapterModelProfiles(adapterType);

    const normalizedRuntimeConfig = { ...runtimeConfig };
    const modelProfiles = asRecord(runtimeConfig.modelProfiles) ?? {};
    const normalizedModelProfiles = { ...modelProfiles };
    normalizedRuntimeConfig.modelProfiles = normalizedModelProfiles;

    for (const entry of entries) {
      const adapterProfile = adapterModelProfiles.find((profile) => profile.key === entry.profileKey);
      const adapterDefaultConfig = asRecord(adapterProfile?.adapterConfig) ?? {};
      const normalizedAdapterConfig = await normalizeMediatedAdapterConfigForPersistence({
        companyId,
        adapterType,
        adapterConfig: entry.adapterConfig,
        constraintAdapterConfig: {
          ...baseAdapterConfig,
          ...adapterDefaultConfig,
        },
      });
      normalizedModelProfiles[entry.profileKey] = {
        ...entry.profile,
        adapterConfig: normalizedAdapterConfig,
      };
    }

    return normalizedRuntimeConfig;
  }

  function generateEd25519PrivateKeyPem(): string {
    const { privateKey } = generateKeyPairSync("ed25519");
    return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  }

  function ensureGatewayDeviceKey(
    adapterType: string | null | undefined,
    adapterConfig: Record<string, unknown>,
  ): Record<string, unknown> {
    if (adapterType !== "openclaw_gateway") return adapterConfig;
    const disableDeviceAuth = parseBooleanLike(adapterConfig.disableDeviceAuth) === true;
    if (disableDeviceAuth) return adapterConfig;
    if (asNonEmptyString(adapterConfig.devicePrivateKeyPem)) return adapterConfig;
    return { ...adapterConfig, devicePrivateKeyPem: generateEd25519PrivateKeyPem() };
  }

  function applyCreateDefaultsByAdapterType(
    adapterType: string | null | undefined,
    adapterConfig: Record<string, unknown>,
  ): Record<string, unknown> {
    const next = { ...adapterConfig };
    if (adapterType === "codex_local") {
      if (!asNonEmptyString(next.model)) {
        next.model = DEFAULT_CODEX_LOCAL_MODEL;
      }
      if (typeof next.fastMode !== "boolean") {
        next.fastMode = defaultCodexLocalFastModeForModel(
          asNonEmptyString(next.model) ? String(next.model) : DEFAULT_CODEX_LOCAL_MODEL,
        );
      }
      const hasBypassFlag =
        typeof next.dangerouslyBypassApprovalsAndSandbox === "boolean" ||
        typeof next.dangerouslyBypassSandbox === "boolean";
      if (!hasBypassFlag) {
        next.dangerouslyBypassApprovalsAndSandbox = DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX;
      }
      return ensureGatewayDeviceKey(adapterType, next);
    }
    if (adapterType === "gemini_local" && !asNonEmptyString(next.model)) {
      next.model = DEFAULT_GEMINI_LOCAL_MODEL;
      return ensureGatewayDeviceKey(adapterType, next);
    }
    // OpenCode requires explicit model selection — no default
    if (adapterType === "cursor" && !asNonEmptyString(next.model)) {
      next.model = DEFAULT_CURSOR_LOCAL_MODEL;
    }
    return ensureGatewayDeviceKey(adapterType, next);
  }

  async function assertAdapterConfigConstraints(
    companyId: string,
    adapterType: string | null | undefined,
    adapterConfig: Record<string, unknown>,
  ) {
    if (adapterType !== "opencode_local") return;
    const { config: runtimeConfig } = await secretsSvc.resolveAdapterConfigForRuntime(companyId, adapterConfig);
    const runtimeEnv = asRecord(runtimeConfig.env) ?? {};
    try {
      await ensureOpenCodeModelConfiguredAndAvailable({
        model: runtimeConfig.model,
        command: runtimeConfig.command,
        cwd: runtimeConfig.cwd,
        env: runtimeEnv,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw unprocessable(`Invalid opencode_local adapterConfig: ${reason}`);
    }
  }

  function resolveInstructionsFilePath(candidatePath: string, adapterConfig: Record<string, unknown>) {
    const trimmed = candidatePath.trim();
    if (path.isAbsolute(trimmed)) return trimmed;

    const cwd = asNonEmptyString(adapterConfig.cwd);
    if (!cwd) {
      throw unprocessable(
        "Relative instructions path requires adapterConfig.cwd to be set to an absolute path",
      );
    }
    if (!path.isAbsolute(cwd)) {
      throw unprocessable("adapterConfig.cwd must be an absolute path to resolve relative instructions path");
    }
    return path.resolve(cwd, trimmed);
  }

  async function assertAllowedExternalInstructionsRoot(rootPath: string) {
    const absoluteRoot = path.resolve(resolveHomeAwarePath(rootPath));
    if (!path.isAbsolute(absoluteRoot)) {
      throw unprocessable("External instructions bundles require an absolute rootPath");
    }

    const settings = await instanceSettings.getGeneral();
    const policy = settings.enterprisePolicy;
    if (
      runtimeConfig.deploymentMode === "local_trusted"
      && policy.unsafeHostBehavior === "allow_local_trusted"
    ) {
      return absoluteRoot;
    }

    const allowedRoots = policy.allowedExternalInstructionRoots
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => path.resolve(resolveHomeAwarePath(value)));
    if (allowedRoots.length === 0) {
      throw unprocessable("External instructions bundles are disabled by instance policy");
    }

    const realRoot = await fs.realpath(absoluteRoot).catch(() => null);
    if (!realRoot) {
      throw unprocessable("External instructions bundle roots must already exist");
    }

    for (const allowedRoot of allowedRoots) {
      const realAllowedRoot = await fs.realpath(allowedRoot).catch(() => null);
      if (!realAllowedRoot) continue;
      const relative = path.relative(realAllowedRoot, realRoot);
      if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..")) {
        return realRoot;
      }
    }

    throw unprocessable("External instructions bundle root is not within an allowlisted root");
  }

  async function materializeDefaultInstructionsBundleForNewAgent<T extends {
    id: string;
    companyId: string;
    name: string;
    role: string;
    adapterType: string;
    adapterConfig: unknown;
  }>(
    agent: T,
    options?: { instructionsBody?: string | null },
  ): Promise<T> {
    if (!adapterSupportsInstructionsBundle(agent.adapterType)) {
      return agent;
    }

    const adapterConfig = asRecord(agent.adapterConfig) ?? {};
    const hasExplicitInstructionsBundle =
      Boolean(asNonEmptyString(adapterConfig.instructionsBundleMode))
      || Boolean(asNonEmptyString(adapterConfig.instructionsRootPath))
      || Boolean(asNonEmptyString(adapterConfig.instructionsEntryFile))
      || Boolean(asNonEmptyString(adapterConfig.instructionsFilePath))
      || Boolean(asNonEmptyString(adapterConfig.agentsMdPath));
    if (hasExplicitInstructionsBundle) {
      return agent;
    }

    const promptTemplate = typeof adapterConfig.promptTemplate === "string"
      ? adapterConfig.promptTemplate
      : "";
    const templateInstructionsBody = typeof options?.instructionsBody === "string"
      ? options.instructionsBody.trim()
      : "";
    const defaultBundle = await loadDefaultAgentInstructionsBundle(
      resolveDefaultAgentInstructionsBundleRole(agent.role),
    );
    const files = templateInstructionsBody.length > 0
      ? {
          ...defaultBundle,
          "AGENTS.md": withCanonicalAgentMemoryContract(options!.instructionsBody!),
        }
      : promptTemplate.trim().length === 0
      ? defaultBundle
      : {
          ...defaultBundle,
          "AGENTS.md": withCanonicalAgentMemoryContract(promptTemplate),
        };
    const materialized = await instructions.materializeManagedBundle(
      agent,
      files,
      {
        entryFile: "AGENTS.md",
        replaceExisting: false,
        bundleRole: resolveDefaultAgentInstructionsBundleRole(agent.role),
        rootPolicy: "managed_only",
        memoryOwnership: "agent_authored",
      },
    );
    const nextAdapterConfig = { ...materialized.adapterConfig };
    delete nextAdapterConfig.promptTemplate;

    const updated = await svc.update(agent.id, { adapterConfig: nextAdapterConfig });
    return (updated as T | null) ?? { ...agent, adapterConfig: nextAdapterConfig };
  }

  async function resolveTemplateBackedAgentInput(
    companyId: string,
    input: Record<string, unknown>,
  ): Promise<{
    mergedInput: Record<string, unknown>;
    instructionsBody: string | null;
    resolvedFromTemplate: boolean;
  }> {
    const resolved = await templateSvc.resolveRevisionForInstantiation(companyId, {
      templateId: typeof input.templateId === "string" ? input.templateId : null,
      templateRevisionId: typeof input.templateRevisionId === "string" ? input.templateRevisionId : null,
    });
    if (!resolved) {
      return { mergedInput: input, instructionsBody: null, resolvedFromTemplate: false };
    }

    const snapshot = agentTemplateSnapshotSchema.parse(resolved.revision.snapshot);
    const mergedInput: Record<string, unknown> = { ...input };
    const fields: Array<keyof typeof snapshot> = [
      "name",
      "role",
      "title",
      "icon",
      "reportsTo",
      "orgLevel",
      "operatingClass",
      "capabilityProfileKey",
      "archetypeKey",
      "departmentKey",
      "departmentName",
      "capabilities",
      "adapterType",
      "adapterConfig",
      "runtimeConfig",
      "budgetMonthlyCents",
      "metadata",
    ];

    for (const field of fields) {
      if (!hasOwn(input, field)) {
        mergedInput[field] = snapshot[field];
      }
    }

    mergedInput.templateId = resolved.template.id;
    mergedInput.templateRevisionId = resolved.revision.id;
    return {
      mergedInput,
      instructionsBody: snapshot.instructionsBody ?? null,
      resolvedFromTemplate: true,
    };
  }

  function mergeDefaultDesiredSkills(
    requestedDesiredSkills: string[] | undefined,
    input: {
      role?: string | null;
      operatingClass?: string | null;
      archetypeKey?: string | null;
    },
    options?: { resolvedFromTemplate?: boolean },
  ) {
    const requested = Array.isArray(requestedDesiredSkills)
      ? requestedDesiredSkills.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [];
    const templateDefaults = options?.resolvedFromTemplate
      ? getDefaultDesiredSkillSlugsForAgent(input)
      : [];
    const merged = Array.from(new Set([...templateDefaults, ...requested]));
    return merged.length > 0 ? merged : undefined;
  }

  function buildAgentCreatePayload(
    input: Record<string, unknown>,
    extras: {
      status: "idle" | "pending_approval";
      spentMonthlyCents: number;
      lastHeartbeatAt: Date | null;
    },
  ): Omit<typeof agentsTable.$inferInsert, "companyId"> {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    const adapterType = typeof input.adapterType === "string" ? input.adapterType : "";
    const projectPlacement = readProjectPlacement(input.projectPlacement);
    if (!name) throw unprocessable("Agent name is required");
    if (!adapterType) throw unprocessable("Adapter type is required");

    return {
      name,
      role: (typeof input.role === "string" ? input.role : "general") as AgentRole,
      title: typeof input.title === "string" ? input.title : null,
      icon: typeof input.icon === "string" ? input.icon : null,
      reportsTo: typeof input.reportsTo === "string" ? input.reportsTo : null,
      orgLevel:
        input.orgLevel === "executive" || input.orgLevel === "director" || input.orgLevel === "staff"
          ? input.orgLevel
          : undefined,
      operatingClass:
        input.operatingClass === "executive" ||
        input.operatingClass === "project_leadership" ||
        input.operatingClass === "worker" ||
        input.operatingClass === "shared_service_lead" ||
        input.operatingClass === "consultant"
          ? input.operatingClass
          : undefined,
      capabilityProfileKey:
        typeof input.capabilityProfileKey === "string" ? input.capabilityProfileKey : undefined,
      archetypeKey: typeof input.archetypeKey === "string" ? input.archetypeKey : undefined,
      departmentKey:
        input.departmentKey === "custom" ||
        input.departmentKey === "general" ||
        input.departmentKey === "executive" ||
        input.departmentKey === "engineering" ||
        input.departmentKey === "product" ||
        input.departmentKey === "design" ||
        input.departmentKey === "marketing" ||
        input.departmentKey === "finance" ||
        input.departmentKey === "operations" ||
        input.departmentKey === "research"
          ? input.departmentKey
          : undefined,
      departmentName: typeof input.departmentName === "string" ? input.departmentName : null,
      capabilities: typeof input.capabilities === "string" ? input.capabilities : null,
      adapterType,
      adapterConfig:
        typeof input.adapterConfig === "object" && input.adapterConfig !== null && !Array.isArray(input.adapterConfig)
          ? (input.adapterConfig as Record<string, unknown>)
          : {},
      runtimeConfig:
        typeof input.runtimeConfig === "object" && input.runtimeConfig !== null && !Array.isArray(input.runtimeConfig)
          ? (input.runtimeConfig as Record<string, unknown>)
          : {},
      budgetMonthlyCents:
        typeof input.budgetMonthlyCents === "number" ? input.budgetMonthlyCents : 0,
      permissions:
        typeof input.permissions === "object" && input.permissions !== null && !Array.isArray(input.permissions)
          ? (input.permissions as Record<string, unknown>)
          : undefined,
      metadata:
        typeof input.metadata === "object" && input.metadata !== null && !Array.isArray(input.metadata)
          ? (input.metadata as Record<string, unknown>)
          : null,
      templateId: typeof input.templateId === "string" ? input.templateId : null,
      templateRevisionId: typeof input.templateRevisionId === "string" ? input.templateRevisionId : null,
      requestedForProjectId: projectPlacement?.projectId ?? null,
      requestedReason: projectPlacement?.requestedReason ?? null,
      status: extras.status,
      spentMonthlyCents: extras.spentMonthlyCents,
      lastHeartbeatAt: extras.lastHeartbeatAt,
    };
  }

  async function assertCanManageInstructionsPath(req: Request, targetAgent: { id: string; companyId: string }) {
    assertCompanyAccess(req, targetAgent.companyId);
    if (req.actor.type === "board") return;
    if (!req.actor.agentId) throw forbidden("Agent authentication required");

    const actorAgent = await svc.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== targetAgent.companyId) {
      throw forbidden("Agent key cannot access another company");
    }
    if (actorAgent.id === targetAgent.id) return;

    const chainOfCommand = await svc.getChainOfCommand(targetAgent.id);
    if (chainOfCommand.some((manager) => manager.id === actorAgent.id)) return;

    throw forbidden("Only the target agent or an ancestor manager can update instructions path");
  }

  function assertNoAgentInstructionsConfigMutation(
    req: Request,
    adapterConfig: Record<string, unknown> | null | undefined,
    path = "adapterConfig",
  ) {
    if (req.actor.type !== "agent" || !adapterConfig) return;
    const changedSensitiveKeys = KNOWN_INSTRUCTIONS_BUNDLE_KEYS
      .filter((key) => adapterConfig[key] !== undefined)
      .map((key) => `${path}.${key}`);
    if (changedSensitiveKeys.length === 0) return;
    throw forbidden(
      `Agent-authenticated callers cannot modify instructions path or bundle configuration (${changedSensitiveKeys.join(", ")})`,
    );
  }

  function adapterConfigTouchesInstructionsConfig(adapterConfig: Record<string, unknown>) {
    return KNOWN_INSTRUCTIONS_BUNDLE_KEYS.some((key) => adapterConfig[key] !== undefined);
  }

  function assertNoAgentAdapterConfigMutation(
    req: Request,
    adapterConfig: Record<string, unknown>,
    path = "adapterConfig",
  ) {
    assertNoAgentInstructionsConfigMutation(req, adapterConfig, path);
    assertNoAgentHostWorkspaceCommandMutation(
      req,
      collectAgentAdapterWorkspaceCommandPaths(adapterConfig, path),
    );
  }

  function summarizeAgentUpdateDetails(patch: Record<string, unknown>) {
    const changedTopLevelKeys = Object.keys(patch).sort();
    const details: Record<string, unknown> = { changedTopLevelKeys };

    const adapterConfigPatch = asRecord(patch.adapterConfig);
    if (adapterConfigPatch) {
      details.changedAdapterConfigKeys = Object.keys(adapterConfigPatch).sort();
    }

    const runtimeConfigPatch = asRecord(patch.runtimeConfig);
    if (runtimeConfigPatch) {
      details.changedRuntimeConfigKeys = Object.keys(runtimeConfigPatch).sort();
    }

    return details;
  }
  function redactForRestrictedAgentView(agent: Awaited<ReturnType<typeof svc.getById>>) {
    if (!agent) return null;
    return {
      ...agent,
      adapterConfig: {},
      runtimeConfig: {},
    };
  }

  function redactAgentConfiguration(agent: Awaited<ReturnType<typeof svc.getById>>) {
    if (!agent) return null;
    return {
      id: agent.id,
      companyId: agent.companyId,
      name: agent.name,
      role: agent.role,
      title: agent.title,
      status: agent.status,
      reportsTo: agent.reportsTo,
      adapterType: agent.adapterType,
      adapterConfig: redactEventPayload(agent.adapterConfig),
      runtimeConfig: redactEventPayload(agent.runtimeConfig),
      permissions: agent.permissions,
      updatedAt: agent.updatedAt,
    };
  }

  function redactRevisionSnapshot(snapshot: unknown): Record<string, unknown> {
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return {};
    const record = snapshot as Record<string, unknown>;
    return {
      ...record,
      adapterConfig: redactEventPayload(
        typeof record.adapterConfig === "object" && record.adapterConfig !== null
          ? (record.adapterConfig as Record<string, unknown>)
          : {},
      ),
      runtimeConfig: redactEventPayload(
        typeof record.runtimeConfig === "object" && record.runtimeConfig !== null
          ? (record.runtimeConfig as Record<string, unknown>)
          : {},
      ),
      metadata:
        typeof record.metadata === "object" && record.metadata !== null
          ? redactEventPayload(record.metadata as Record<string, unknown>)
          : record.metadata ?? null,
    };
  }

  function redactConfigRevision(
    revision: Record<string, unknown> & { beforeConfig: unknown; afterConfig: unknown },
  ) {
    return {
      ...revision,
      beforeConfig: redactRevisionSnapshot(revision.beforeConfig),
      afterConfig: redactRevisionSnapshot(revision.afterConfig),
    };
  }

  function toLeanOrgNode(node: Record<string, unknown>): Record<string, unknown> {
    const reports = Array.isArray(node.reports)
      ? (node.reports as Array<Record<string, unknown>>).map((report) => toLeanOrgNode(report))
      : [];
    return {
      id: String(node.id),
      name: String(node.name),
      role: String(node.role),
      status: String(node.status),
      orgLevel: typeof node.orgLevel === "string" ? node.orgLevel : undefined,
      departmentKey: typeof node.departmentKey === "string" ? node.departmentKey : undefined,
      departmentName: typeof node.departmentName === "string" ? node.departmentName : null,
      title: typeof node.title === "string" ? node.title : null,
      reports,
    };
  }

  router.param("id", async (req, _res, next, rawId) => {
    try {
      req.params.id = await normalizeAgentReference(req, String(rawId));
      next();
    } catch (err) {
      next(err);
    }
  });

  router.get("/companies/:companyId/adapters/:type/models", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const type = assertKnownAdapterType(req.params.type as string);
    const refresh = typeof req.query.refresh === "string"
      ? ["1", "true", "yes"].includes(req.query.refresh.toLowerCase())
      : false;
    const models = refresh
      ? await refreshAdapterModels(type)
      : await listAdapterModels(type);
    res.json(models);
  });

  router.get("/companies/:companyId/adapters/:type/model-profiles", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const type = assertKnownAdapterType(req.params.type as string);
    const profiles = await listAdapterModelProfiles(type);
    res.json(profiles);
  });

  router.get("/companies/:companyId/adapters/:type/detect-model", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const type = assertKnownAdapterType(req.params.type as string);

    const detected = await detectAdapterModel(type);
    res.json(detected);
  });

  router.post(
    "/companies/:companyId/adapters/:type/test-environment",
    validate(testAdapterEnvironmentSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const type = assertKnownAdapterType(req.params.type as string);
      await assertCanReadConfigurations(req, companyId);

      const adapter = requireServerAdapter(type);

      const inputAdapterConfig =
        (req.body?.adapterConfig ?? {}) as Record<string, unknown>;
      const requestedEnvironmentId =
        typeof req.body?.environmentId === "string" && req.body.environmentId.trim().length > 0
          ? (req.body.environmentId as string)
          : null;
      const normalizedAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
        companyId,
        inputAdapterConfig,
        { strictMode: strictSecretsMode },
      );
      const { config: runtimeAdapterConfig } = await secretsSvc.resolveAdapterConfigForRuntime(
        companyId,
        normalizedAdapterConfig,
      );

      const { executionTarget, environmentName, fallbackChecks } =
        await resolveAdapterTestExecutionContext({
          companyId,
          adapterType: type,
          environmentId: requestedEnvironmentId,
        });

      const result = await adapter.testEnvironment({
        companyId,
        adapterType: type,
        config: runtimeAdapterConfig,
        executionTarget,
        environmentName,
      });

      if (fallbackChecks.length > 0) {
        const checks = [...fallbackChecks, ...result.checks];
        const status: typeof result.status = checks.some((c) => c.level === "error")
          ? "fail"
          : checks.some((c) => c.level === "warn")
            ? "warn"
            : result.status;
        res.json({ ...result, checks, status });
        return;
      }

      res.json(result);
    },
  );

  router.get("/agents/:id/skills", async (req, res) => {
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanReadAgent(req, agent);

    const canManageSkills = req.actor.type === "board";
    const snapshot = await skillSync.listSkills(agent, { canManage: canManageSkills });
    res.json(snapshot);
  });

  router.post(
    "/agents/:id/skills/sync",
    validate(agentSkillSyncSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const agent = await svc.getById(id);
      if (!agent) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }
      assertBoard(req);
      assertCompanyAccess(req, agent.companyId);

      const actor = getActorInfo(req);
      const snapshot = await skillSync.syncAgentSkills(
        agent,
        (req.body.desiredSkills as string[] | undefined) ?? [],
        actor,
        { desiredSkillIds: (req.body.desiredSkillIds as string[] | undefined) ?? [] },
      );
      res.json(snapshot);
    },
  );

  router.get("/companies/:companyId/agents", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.list(companyId);
    const canReadConfigs = await actorCanReadConfigurationsForCompany(req, companyId);
    if (canReadConfigs || req.actor.type === "board") {
      res.json(result);
      return;
    }
    res.json(result.map((agent) => redactForRestrictedAgentView(agent)));
  });

  router.get("/instance/scheduler-heartbeats", async (req, res) => {
    assertInstanceAdmin(req);

    const rows = await db
      .select({
        id: agentsTable.id,
        companyId: agentsTable.companyId,
        agentName: agentsTable.name,
        role: agentsTable.role,
        title: agentsTable.title,
        status: agentsTable.status,
        adapterType: agentsTable.adapterType,
        runtimeConfig: agentsTable.runtimeConfig,
        lastHeartbeatAt: agentsTable.lastHeartbeatAt,
        companyName: companies.name,
        companyIssuePrefix: companies.issuePrefix,
      })
      .from(agentsTable)
      .innerJoin(companies, eq(agentsTable.companyId, companies.id))
      .orderBy(companies.name, agentsTable.name);

    const items: InstanceSchedulerHeartbeatAgent[] = rows
      .map((row) => {
        const policy = parseSchedulerHeartbeatPolicy(row.runtimeConfig);
        const statusEligible =
          row.status !== "paused" &&
          row.status !== "terminated" &&
          row.status !== "pending_approval";

        return {
          id: row.id,
          companyId: row.companyId,
          companyName: row.companyName,
          companyIssuePrefix: row.companyIssuePrefix,
          agentName: row.agentName,
          agentUrlKey: deriveAgentUrlKey(row.agentName, row.id),
          role: row.role as InstanceSchedulerHeartbeatAgent["role"],
          title: row.title,
          status: row.status as InstanceSchedulerHeartbeatAgent["status"],
          adapterType: row.adapterType,
          intervalSec: policy.intervalSec,
          heartbeatEnabled: policy.enabled,
          schedulerActive: statusEligible && policy.enabled && policy.intervalSec > 0,
          lastHeartbeatAt: row.lastHeartbeatAt,
        };
      })
      .filter((item) =>
        item.status !== "paused" &&
        item.status !== "terminated" &&
        item.status !== "pending_approval",
      )
      .sort((left, right) => {
        if (left.schedulerActive !== right.schedulerActive) {
          return left.schedulerActive ? -1 : 1;
        }
        const companyOrder = left.companyName.localeCompare(right.companyName);
        if (companyOrder !== 0) return companyOrder;
        return left.agentName.localeCompare(right.agentName);
      });

    res.json(items);
  });

  router.get("/companies/:companyId/org", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const tree = await svc.orgForCompany(companyId);
    const leanTree = tree.map((node) => toLeanOrgNode(node as Record<string, unknown>));
    res.json(leanTree);
  });

  router.get("/companies/:companyId/agent-hierarchy", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const hierarchy = await svc.hierarchyForCompany(companyId);
    res.json(hierarchy);
  });

  router.get("/companies/:companyId/operating-hierarchy", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const hierarchy = await svc.operatingHierarchyForCompany(companyId);
    res.json(hierarchy);
  });

  router.get("/companies/:companyId/agent-accountability", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const accountability = await svc.accountabilityForCompany(companyId);
    res.json(accountability);
  });

  router.get("/companies/:companyId/org-simplification", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const report = await svc.orgSimplificationForCompany(companyId);
    res.json(report);
  });

  router.post(
    "/companies/:companyId/org-simplification/archive",
    validate(orgSimplificationArchiveRequestSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertBoard(req);
      assertCompanyAccess(req, companyId);
      const body = req.body;
      const archivedIds = await svc.archiveForSimplification(companyId, body.agentIds);
      await Promise.all(archivedIds.map((agentId) => heartbeat.cancelActiveForAgent(agentId)));
      for (const agentId of archivedIds) {
        await logActivity(db, {
          companyId,
          actorType: "user",
          actorId: req.actor.userId ?? "board",
          action: "agent.terminated",
          entityType: "agent",
          entityId: agentId,
          details: { source: "org_simplification_archive", reason: body.reason ?? null },
        });
      }
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "company.org_simplification_archive",
        entityType: "company",
        entityId: companyId,
        details: { agentIds: archivedIds, reason: body.reason ?? null },
      });
      const report = await svc.orgSimplificationForCompany(companyId);
      res.json({
        companyId,
        action: "archive",
        affectedAgentIds: archivedIds,
        report,
      });
    },
  );

  router.post(
    "/companies/:companyId/org-simplification/reparent-reports",
    validate(orgSimplificationReparentReportsRequestSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertBoard(req);
      assertCompanyAccess(req, companyId);
      const body = req.body;
      const updatedIds = await svc.reparentReportsForSimplification(
        companyId,
        body.fromAgentIds,
        body.targetAgentId,
      );
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "company.org_simplification_reparent_reports",
        entityType: "company",
        entityId: companyId,
        details: {
          fromAgentIds: body.fromAgentIds,
          targetAgentId: body.targetAgentId,
          updatedAgentIds: updatedIds,
          reason: body.reason ?? null,
        },
      });
      const report = await svc.orgSimplificationForCompany(companyId);
      res.json({
        companyId,
        action: "reparent_reports",
        affectedAgentIds: updatedIds,
        report,
      });
    },
  );

  router.post(
    "/companies/:companyId/org-simplification/convert-shared-service",
    validate(orgSimplificationConvertSharedServiceRequestSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertBoard(req);
      assertCompanyAccess(req, companyId);
      const body = req.body;
      const updatedIds = await svc.convertAgentsToSharedService(companyId, body.agentIds);
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "company.org_simplification_convert_shared_service",
        entityType: "company",
        entityId: companyId,
        details: { agentIds: updatedIds, reason: body.reason ?? null },
      });
      const report = await svc.orgSimplificationForCompany(companyId);
      res.json({
        companyId,
        action: "convert_shared_service",
        affectedAgentIds: updatedIds,
        report,
      });
    },
  );

  router.get("/companies/:companyId/agent-navigation", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const requestedLayout = typeof req.query.layout === "string" ? req.query.layout : "department";
    const layout = AGENT_NAVIGATION_LAYOUTS.includes(requestedLayout as (typeof AGENT_NAVIGATION_LAYOUTS)[number])
      ? (requestedLayout as "department" | "project")
      : "department";
    const navigation = await svc.navigationForCompany(companyId, layout);
    res.json(navigation);
  });

  router.get("/companies/:companyId/org.svg", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const style = (ORG_CHART_STYLES.includes(req.query.style as OrgChartStyle) ? req.query.style : "warmth") as OrgChartStyle;
    const tree = await svc.orgForCompany(companyId);
    const leanTree = tree.map((node) => toLeanOrgNode(node as Record<string, unknown>));
    const svg = renderOrgChartSvg(leanTree as unknown as OrgNode[], style);
    res.setHeader("Content-Type", "image/svg+xml");
    res.setHeader("Cache-Control", "no-cache");
    res.send(svg);
  });

  router.get("/companies/:companyId/org.png", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const style = (ORG_CHART_STYLES.includes(req.query.style as OrgChartStyle) ? req.query.style : "warmth") as OrgChartStyle;
    const tree = await svc.orgForCompany(companyId);
    const leanTree = tree.map((node) => toLeanOrgNode(node as Record<string, unknown>));
    const png = await renderOrgChartPng(leanTree as unknown as OrgNode[], style);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-cache");
    res.send(png);
  });

  router.get("/companies/:companyId/agent-configurations", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanReadConfigurations(req, companyId);
    const rows = await svc.list(companyId);
    res.json(rows.map((row) => redactAgentConfiguration(row)));
  });

  router.get("/agents/me", async (req, res) => {
    if (req.actor.type !== "agent" || !req.actor.agentId) {
      res.status(401).json({ error: "Agent authentication required" });
      return;
    }
    const agent = await svc.getById(req.actor.agentId);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    res.json(await buildAgentDetail(agent));
  });

  router.get("/agents/me/inbox-lite", async (req, res) => {
    if (req.actor.type !== "agent" || !req.actor.agentId || !req.actor.companyId) {
      res.status(401).json({ error: "Agent authentication required" });
      return;
    }

    const rows = await issuesSvc.list(req.actor.companyId, {
      assigneeAgentId: req.actor.agentId,
      includeRoutineExecutions: true,
      status: "todo,in_progress,blocked",
    });
    const dependencyReadiness = await issuesSvc.listDependencyReadiness(
      req.actor.companyId,
      rows.map((issue) => issue.id),
    );

    const primaryBlockerIds = new Set<string>();
    for (const issue of rows) {
      const blockers = dependencyReadiness.get(issue.id)?.unresolvedBlockerIssueIds ?? [];
      if (blockers.length > 0) primaryBlockerIds.add(blockers[0]);
    }
    const blockerInfo = primaryBlockerIds.size > 0
      ? await issuesSvc.listBlockerWaitingOnInfo(req.actor.companyId, [...primaryBlockerIds])
      : new Map<string, { identifier: string | null; openChildCount: number }>();

    const loggedMisses = new Set<string>();
    res.json(
      rows.map((issue) => {
        const continuitySummary = buildIssueContinuitySummary(issue);
        const operator = buildIssueOperatorState({
          issueId: issue.id,
          status: issue.status as any,
          hiddenAt: issue.hiddenAt ?? null,
          assigneeAgentId: issue.assigneeAgentId ?? req.actor.agentId,
          assigneeUserId: issue.assigneeUserId ?? null,
          continuitySummary,
          activeRun: issue.activeRun ?? null,
        });
        const computedAgentState = groupOperatorState(operator.operatorState, {
          onCoverageMiss: (miss) => {
            if (loggedMisses.has(miss.detailed)) return;
            loggedMisses.add(miss.detailed);
            logger.warn(
              {
                companyId: req.actor.companyId,
                detailedOperatorState: miss.detailed,
                fallbackComputedAgentState: miss.fallback,
                event: "computed_agent_state.coverage_miss",
                route: "/agents/me/inbox-lite",
              },
              "Unmapped detailed operator state fell back to idle; update groupOperatorState mapping.",
            );
          },
        });
        const readiness = dependencyReadiness.get(issue.id);
        const unresolvedBlockerIssueIds = readiness?.unresolvedBlockerIssueIds ?? [];
        let waitingOn: ComputedAgentWaitingOn | null = null;
        if (computedAgentState === "dependency_blocked" && unresolvedBlockerIssueIds.length > 0) {
          const primaryBlockerId = unresolvedBlockerIssueIds[0];
          const info = blockerInfo.get(primaryBlockerId);
          waitingOn = {
            issueId: primaryBlockerId,
            identifier: info?.identifier ?? null,
            openChildCount: info?.openChildCount ?? 0,
            nextWakeReason: "issue_blockers_resolved",
          };
        }
        return {
          id: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          status: issue.status,
          priority: issue.priority,
          projectId: issue.projectId,
          goalId: issue.goalId,
          parentId: issue.parentId,
          updatedAt: issue.updatedAt,
          activeRun: issue.activeRun,
          dependencyReady: readiness?.isDependencyReady ?? true,
          unresolvedBlockerCount: readiness?.unresolvedBlockerCount ?? 0,
          unresolvedBlockerIssueIds,
          operatorState: operator.operatorState,
          operatorReason: operator.operatorReason,
          computedAgentState,
          waitingOn,
        };
      }),
    );
  });

  router.get("/agents/me/inbox/mine", async (req, res) => {
    if (req.actor.type !== "agent" || !req.actor.agentId || !req.actor.companyId) {
      res.status(401).json({ error: "Agent authentication required" });
      return;
    }

    const query = agentMineInboxQuerySchema.parse(req.query);
    const rows = await issuesSvc.list(req.actor.companyId, {
      touchedByUserId: query.userId,
      inboxArchivedByUserId: query.userId,
      status: query.status,
    });

    res.json(rows);
  });

  router.get("/agents/:id", async (req, res) => {
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    assertCompanyAccess(req, agent.companyId);
    if (req.actor.type === "agent" && req.actor.agentId !== id) {
      const canRead = await actorCanReadConfigurationsForCompany(req, agent.companyId);
      if (!canRead) {
        res.json(await buildAgentDetail(agent, { restricted: true }));
        return;
      }
    }
    res.json(await buildAgentDetail(agent));
  });

  router.get("/agents/:id/configuration", async (req, res) => {
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanReadConfigurations(req, agent.companyId);
    res.json(redactAgentConfiguration(agent));
  });

  router.get("/agents/:id/config-revisions", async (req, res) => {
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanReadConfigurations(req, agent.companyId);
    const revisions = await svc.listConfigRevisions(id);
    res.json(revisions.map((revision) => redactConfigRevision(revision)));
  });

  router.get("/agents/:id/config-revisions/:revisionId", async (req, res) => {
    const id = req.params.id as string;
    const revisionId = req.params.revisionId as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanReadConfigurations(req, agent.companyId);
    const revision = await svc.getConfigRevision(id, revisionId);
    if (!revision) {
      res.status(404).json({ error: "Revision not found" });
      return;
    }
    res.json(redactConfigRevision(revision));
  });

  router.post("/agents/:id/config-revisions/:revisionId/rollback", async (req, res) => {
    const id = req.params.id as string;
    const revisionId = req.params.revisionId as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanUpdateAgent(req, existing);

    const actor = getActorInfo(req);
    const updated = await svc.rollbackConfigRevision(id, revisionId, {
      agentId: actor.agentId,
      userId: actor.actorType === "user" ? actor.actorId : null,
    });
    if (!updated) {
      res.status(404).json({ error: "Revision not found" });
      return;
    }

    await logActivity(db, {
      companyId: updated.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.config_rolled_back",
      entityType: "agent",
      entityId: updated.id,
      details: { revisionId },
    });

    res.json(updated);
  });

  router.get("/agents/:id/runtime-state", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    assertCompanyAccess(req, agent.companyId);

    const state = await heartbeat.getRuntimeState(id);
    res.json(state);
  });

  router.get("/agents/:id/task-sessions", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    assertCompanyAccess(req, agent.companyId);

    const sessions = await heartbeat.listTaskSessions(id);
    res.json(
      sessions.map((session) => ({
        ...session,
        sessionParamsJson: redactEventPayload(session.sessionParamsJson ?? null),
      })),
    );
  });

  router.post("/agents/:id/runtime-state/reset-session", validate(resetAgentSessionSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    assertCompanyAccess(req, agent.companyId);

    const taskKey =
      typeof req.body.taskKey === "string" && req.body.taskKey.trim().length > 0
        ? req.body.taskKey.trim()
        : null;
    const state = await heartbeat.resetRuntimeSession(id, { taskKey });

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "agent.runtime_session_reset",
      entityType: "agent",
      entityId: id,
      details: { taskKey: taskKey ?? null },
    });

    res.json(state);
  });

  router.post("/companies/:companyId/agent-hires", validate(createAgentHireSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanCreateAgentsForCompany(req, companyId);
    const sourceIssueIds = parseSourceIssueIds(req.body);
    const {
      desiredSkills: requestedDesiredSkills,
      sourceIssueId: _sourceIssueId,
      sourceIssueIds: _sourceIssueIds,
      ...requestedHireInput
    } = req.body;
    const templateResolved = await resolveTemplateBackedAgentInput(companyId, requestedHireInput);
    const hireInput = { ...templateResolved.mergedInput };
    if (typeof hireInput.name !== "string" || hireInput.name.trim().length === 0) {
      throw unprocessable("Agent name is required");
    }
    hireInput.role = typeof hireInput.role === "string" ? hireInput.role : "general";
    hireInput.adapterType = assertKnownAdapterType(
      typeof hireInput.adapterType === "string" ? hireInput.adapterType : null,
    );
    const rawHireAdapterConfig = ((hireInput.adapterConfig ?? {}) as Record<string, unknown>);
    assertNoNewAgentLegacyPromptTemplate(
      hireInput.adapterType,
      rawHireAdapterConfig,
    );
    assertNoAgentAdapterConfigMutation(req, rawHireAdapterConfig);
    assertNoAgentRuntimeConfigAdapterConfigMutation(req, hireInput.runtimeConfig);
    const requestedAdapterConfig = applyCreateDefaultsByAdapterType(
      hireInput.adapterType as string,
      rawHireAdapterConfig,
    );
    const mergedDesiredSkillRefs = mergeDefaultDesiredSkills(
      Array.isArray(requestedDesiredSkills) ? requestedDesiredSkills : undefined,
      {
        role: typeof hireInput.role === "string" ? hireInput.role : null,
        operatingClass: typeof hireInput.operatingClass === "string" ? hireInput.operatingClass : null,
        archetypeKey: typeof hireInput.archetypeKey === "string" ? hireInput.archetypeKey : null,
      },
      { resolvedFromTemplate: templateResolved.resolvedFromTemplate },
    );
    const desiredSkillAssignment = await skillSync.resolveDesiredSkillAssignment(
      companyId,
      hireInput.adapterType as string,
      requestedAdapterConfig,
      mergedDesiredSkillRefs,
    );
    const normalizedAdapterConfig = await normalizeMediatedAdapterConfigForPersistence({
      companyId,
      adapterType: hireInput.adapterType,
      adapterConfig: desiredSkillAssignment.adapterConfig,
    });
    const normalizedRuntimeConfig = await normalizeRuntimeConfigAdapterConfigsForPersistence(
      companyId,
      hireInput.adapterType as string,
      normalizeNewAgentRuntimeConfig(hireInput.runtimeConfig),
      normalizedAdapterConfig,
    );
    const normalizedHireInput = {
      ...hireInput,
      adapterConfig: normalizedAdapterConfig,
      runtimeConfig: normalizedRuntimeConfig,
      budgetMonthlyCents:
        typeof hireInput.budgetMonthlyCents === "number"
          ? hireInput.budgetMonthlyCents
          : 0,
    } as Record<string, unknown> & {
      name: string;
      role: string;
      title?: string | null;
      icon?: string | null;
      reportsTo?: string | null;
      capabilities?: string | null;
      metadata?: Record<string, unknown> | null;
      adapterType: string;
      adapterConfig: Record<string, unknown>;
      runtimeConfig: Record<string, unknown>;
      budgetMonthlyCents: number;
    };
    const requestedProjectPlacement = readProjectPlacement(normalizedHireInput.projectPlacement);

    const company = await db
      .select()
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }

    if (requestedProjectPlacement) {
      await placementSvc.previewForInput(
        companyId,
        {
          companyId,
          operatingClass:
            typeof normalizedHireInput.operatingClass === "string" ? normalizedHireInput.operatingClass : null,
          archetypeKey:
            typeof normalizedHireInput.archetypeKey === "string" ? normalizedHireInput.archetypeKey : null,
        },
        requestedProjectPlacement,
      );
    }

    const requiresApproval = company.requireBoardApprovalForNewAgents;
    const status = requiresApproval ? "pending_approval" : "idle";
    const createdAgent = await svc.create(companyId, buildAgentCreatePayload(normalizedHireInput, {
      status,
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    }));
    const agent = await materializeDefaultInstructionsBundleForNewAgent(createdAgent, {
      instructionsBody: templateResolved.instructionsBody,
    });

    let approval: Awaited<ReturnType<typeof approvalsSvc.getById>> | null = null;
    const actor = getActorInfo(req);

    if (requiresApproval) {
      const requestedAdapterType = normalizedHireInput.adapterType ?? agent.adapterType;
      const requestedAdapterConfig =
        redactEventPayload(
          (agent.adapterConfig ?? normalizedHireInput.adapterConfig) as Record<string, unknown>,
        ) ?? {};
      const requestedRuntimeConfig =
        redactEventPayload(
          (normalizedHireInput.runtimeConfig ?? agent.runtimeConfig) as Record<string, unknown>,
        ) ?? {};
      const requestedMetadata =
        redactEventPayload(
          ((normalizedHireInput.metadata ?? agent.metadata ?? {}) as Record<string, unknown>),
        ) ?? {};
      approval = await approvalsSvc.create(companyId, {
        type: "hire_agent",
        requestedByAgentId: actor.actorType === "agent" ? actor.actorId : null,
        requestedByUserId: actor.actorType === "user" ? actor.actorId : null,
        status: "pending",
        payload: {
          name: normalizedHireInput.name,
          role: normalizedHireInput.role,
          title: normalizedHireInput.title ?? null,
          icon: normalizedHireInput.icon ?? null,
          reportsTo: normalizedHireInput.reportsTo ?? null,
          capabilities: normalizedHireInput.capabilities ?? null,
          adapterType: requestedAdapterType,
          adapterConfig: requestedAdapterConfig,
          runtimeConfig: requestedRuntimeConfig,
          budgetMonthlyCents:
            typeof normalizedHireInput.budgetMonthlyCents === "number"
              ? normalizedHireInput.budgetMonthlyCents
              : agent.budgetMonthlyCents,
          desiredSkills: desiredSkillAssignment.desiredSkills,
          metadata: requestedMetadata,
          projectPlacement: requestedProjectPlacement,
          agentId: agent.id,
          requestedByAgentId: actor.actorType === "agent" ? actor.actorId : null,
          requestedConfigurationSnapshot: {
            adapterType: requestedAdapterType,
            adapterConfig: requestedAdapterConfig,
            runtimeConfig: requestedRuntimeConfig,
            desiredSkills: desiredSkillAssignment.desiredSkills,
          },
        },
        decisionNote: null,
        decidedByUserId: null,
        decidedAt: null,
        updatedAt: new Date(),
      });

      if (sourceIssueIds.length > 0) {
        await issueApprovalsSvc.linkManyForApproval(approval.id, sourceIssueIds, {
          agentId: actor.actorType === "agent" ? actor.actorId : null,
          userId: actor.actorType === "user" ? actor.actorId : null,
        });
      }
    }
    if (!requiresApproval && requestedProjectPlacement) {
      await placementSvc.applyPrimaryPlacement({
        companyId,
        agentId: agent.id,
        placement: requestedProjectPlacement,
        actor: placementActorFromRequest(req),
      });
    }

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.hire_created",
      entityType: "agent",
      entityId: agent.id,
      details: {
        name: agent.name,
        role: agent.role,
        requiresApproval,
        approvalId: approval?.id ?? null,
        issueIds: sourceIssueIds,
        desiredSkills: desiredSkillAssignment.desiredSkills,
        projectPlacement: requestedProjectPlacement,
      },
    });
    const telemetryClient = getTelemetryClientFn();
    if (telemetryClient) {
      trackAgentCreatedFn(telemetryClient, { agentRole: agent.role });
    }

    await applyDefaultAgentTaskAssignGrant(
      companyId,
      agent.id,
      actor.actorType === "user" ? actor.actorId : null,
    );

    if (approval) {
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "approval.created",
        entityType: "approval",
        entityId: approval.id,
        details: { type: approval.type, linkedAgentId: agent.id },
      });
    }

    res.status(201).json({ agent, approval });
  });

  router.post(
    "/companies/:companyId/office-operator-adoption",
    validate(companyOfficeOperatorAdoptionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCanCreateAgentsForCompany(req, companyId);

      const actor = getActorInfo(req);
      const agents = await svc.list(companyId);
      const existingOfficeOperator = agents.find((agent) => isOfficeOperatorAgent(agent)) ?? null;
      const ceo = agents.find((agent) => agent.role === "ceo" && agent.status !== "terminated") ?? null;
      const seedFromAgentId =
        typeof req.body.seedFromAgentId === "string" && req.body.seedFromAgentId.trim().length > 0
          ? req.body.seedFromAgentId.trim()
          : null;
      const seedAgent =
        (seedFromAgentId ? agents.find((agent) => agent.id === seedFromAgentId) ?? null : null)
        ?? ceo
        ?? agents.find((agent) => agent.status !== "terminated") ?? null;

      if (seedFromAgentId && (!seedAgent || seedAgent.id !== seedFromAgentId)) {
        throw notFound("Seed agent not found");
      }

      let officeOperator = existingOfficeOperator;
      let created = false;

      if (!officeOperator) {
        if (!seedAgent) {
          throw unprocessable("Office-operator adoption requires a seed agent or an existing active agent.");
        }

        const chiefOfStaffTemplate = (await templateSvc.list(companyId)).find(
          (template) => template.archetypeKey === "chief_of_staff",
        );
        if (!chiefOfStaffTemplate) {
          throw notFound("Chief of Staff template not found");
        }

        const templateResolved = await resolveTemplateBackedAgentInput(companyId, {
          templateId: chiefOfStaffTemplate.id,
          reportsTo: ceo?.id ?? null,
        });
        const createInput = { ...templateResolved.mergedInput };
        const requestedAdapterConfig = applyCreateDefaultsByAdapterType(
          seedAgent.adapterType,
          ((seedAgent.adapterConfig ?? {}) as Record<string, unknown>),
        );
        const mergedDesiredSkillRefs = mergeDefaultDesiredSkills(
          undefined,
          {
            role: typeof createInput.role === "string" ? createInput.role : "coo",
            operatingClass:
              typeof createInput.operatingClass === "string" ? createInput.operatingClass : "executive",
            archetypeKey:
              typeof createInput.archetypeKey === "string" ? createInput.archetypeKey : "chief_of_staff",
          },
          { resolvedFromTemplate: true },
        );
        const desiredSkillAssignment = await skillSync.resolveDesiredSkillAssignment(
          companyId,
          seedAgent.adapterType,
          requestedAdapterConfig,
          mergedDesiredSkillRefs,
        );
        const normalizedAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
          companyId,
          desiredSkillAssignment.adapterConfig,
          { strictMode: strictSecretsMode },
        );
        await assertAdapterConfigConstraints(companyId, seedAgent.adapterType, normalizedAdapterConfig);

        const seedHeartbeat = asRecord(seedAgent.runtimeConfig)?.heartbeat;
        const templateHeartbeat = asRecord(createInput.runtimeConfig)?.heartbeat;
        const runtimeConfig = normalizeNewAgentRuntimeConfig({
          ...((seedAgent.runtimeConfig ?? {}) as Record<string, unknown>),
          ...((createInput.runtimeConfig ?? {}) as Record<string, unknown>),
          heartbeat: {
            ...(asRecord(seedHeartbeat) ?? {}),
            ...(asRecord(templateHeartbeat) ?? {}),
            enabled: true,
            intervalSec:
              parseNumberLike(asRecord(templateHeartbeat)?.intervalSec)
              ?? parseNumberLike(asRecord(seedHeartbeat)?.intervalSec)
              ?? 300,
          },
        });

        const createdAgent = await svc.create(companyId, buildAgentCreatePayload({
          ...createInput,
          reportsTo: ceo?.id ?? null,
          adapterType: seedAgent.adapterType,
          adapterConfig: normalizedAdapterConfig,
          runtimeConfig,
          budgetMonthlyCents:
            typeof createInput.budgetMonthlyCents === "number" ? createInput.budgetMonthlyCents : 0,
        }, {
          status: "idle",
          spentMonthlyCents: 0,
          lastHeartbeatAt: null,
        }));
        officeOperator = await materializeDefaultInstructionsBundleForNewAgent(createdAgent, {
          instructionsBody: templateResolved.instructionsBody,
        });
        await applyDefaultAgentTaskAssignGrant(
          companyId,
          officeOperator.id,
          actor.actorType === "user" ? actor.actorId : null,
        );
        created = true;
      }

      const shouldReparent = req.body.reparentProjectLeads !== false;
      const projectLeads = agents.filter((agent) => isProjectLeadAgent(agent) && agent.id !== officeOperator.id);
      const reparentedProjectLeadIds: string[] = [];
      if (shouldReparent) {
        for (const projectLead of projectLeads) {
          if (projectLead.reportsTo === officeOperator.id) continue;
          const updated = await svc.update(projectLead.id, { reportsTo: officeOperator.id });
          if (updated) {
            reparentedProjectLeadIds.push(projectLead.id);
          }
        }
      }

      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "agent.office_operator_adopted",
        entityType: "agent",
        entityId: officeOperator.id,
        details: {
          created,
          reparentedProjectLeadIds,
          seedFromAgentId: seedAgent?.id ?? null,
        },
      });

      res.status(created ? 201 : 200).json({
        officeOperator,
        created,
        reparentedProjectLeadIds,
        managerId: officeOperator.reportsTo ?? null,
        seedFromAgentId: seedAgent?.id ?? null,
      });
    },
  );

  router.post("/companies/:companyId/agents", validate(createAgentSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanCreateAgentsForCompany(req, companyId);

    const company = await db
      .select()
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    if (company.requireBoardApprovalForNewAgents) {
      throw conflict(
        "Direct agent creation requires board approval. Use POST /api/companies/:companyId/agent-hires to create a pending hire approval.",
      );
    }

    const {
      desiredSkills: requestedDesiredSkills,
      ...requestedCreateInput
    } = req.body;
    const templateResolved = await resolveTemplateBackedAgentInput(companyId, requestedCreateInput);
    const createInput = { ...templateResolved.mergedInput };
    if (typeof createInput.name !== "string" || createInput.name.trim().length === 0) {
      throw unprocessable("Agent name is required");
    }
    createInput.role = typeof createInput.role === "string" ? createInput.role : "general";
    createInput.adapterType = assertKnownAdapterType(
      typeof createInput.adapterType === "string" ? createInput.adapterType : null,
    );
    const rawCreateAdapterConfig = ((createInput.adapterConfig ?? {}) as Record<string, unknown>);
    assertNoNewAgentLegacyPromptTemplate(
      createInput.adapterType,
      rawCreateAdapterConfig,
    );
    assertNoAgentAdapterConfigMutation(req, rawCreateAdapterConfig);
    assertNoAgentRuntimeConfigAdapterConfigMutation(req, createInput.runtimeConfig);
    const requestedAdapterConfig = applyCreateDefaultsByAdapterType(
      createInput.adapterType as string,
      rawCreateAdapterConfig,
    );
    const mergedDesiredSkillRefs = mergeDefaultDesiredSkills(
      Array.isArray(requestedDesiredSkills) ? requestedDesiredSkills : undefined,
      {
        role: typeof createInput.role === "string" ? createInput.role : null,
        operatingClass: typeof createInput.operatingClass === "string" ? createInput.operatingClass : null,
        archetypeKey: typeof createInput.archetypeKey === "string" ? createInput.archetypeKey : null,
      },
      { resolvedFromTemplate: templateResolved.resolvedFromTemplate },
    );
    const desiredSkillAssignment = await skillSync.resolveDesiredSkillAssignment(
      companyId,
      createInput.adapterType as string,
      requestedAdapterConfig,
      mergedDesiredSkillRefs,
    );
    const normalizedAdapterConfig = await normalizeMediatedAdapterConfigForPersistence({
      companyId,
      adapterType: createInput.adapterType,
      adapterConfig: desiredSkillAssignment.adapterConfig,
    });
    const normalizedRuntimeConfig = await normalizeRuntimeConfigAdapterConfigsForPersistence(
      companyId,
      createInput.adapterType as string,
      normalizeNewAgentRuntimeConfig(createInput.runtimeConfig),
      normalizedAdapterConfig,
    );
    const requestedProjectPlacement = readProjectPlacement(createInput.projectPlacement);
    if (requestedProjectPlacement) {
      await placementSvc.previewForInput(
        companyId,
        {
          companyId,
          operatingClass:
            typeof createInput.operatingClass === "string" ? createInput.operatingClass : null,
          archetypeKey:
            typeof createInput.archetypeKey === "string" ? createInput.archetypeKey : null,
        },
        requestedProjectPlacement,
      );
    }
    await assertAgentEnvironmentSelection(
      companyId,
      createInput.adapterType as string,
      createInput.defaultEnvironmentId as string | null | undefined,
    );

    const createdAgent = await svc.create(companyId, buildAgentCreatePayload({
      ...createInput,
      adapterConfig: normalizedAdapterConfig,
      runtimeConfig: normalizedRuntimeConfig,
      budgetMonthlyCents:
        typeof createInput.budgetMonthlyCents === "number"
          ? createInput.budgetMonthlyCents
          : 0,
    }, {
      status: "idle",
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    }));
    const agent = await materializeDefaultInstructionsBundleForNewAgent(createdAgent, {
      instructionsBody: templateResolved.instructionsBody,
    });
    if (requestedProjectPlacement) {
      await placementSvc.applyPrimaryPlacement({
        companyId,
        agentId: agent.id,
        placement: requestedProjectPlacement,
        actor: placementActorFromRequest(req),
      });
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.created",
      entityType: "agent",
      entityId: agent.id,
      details: {
        name: agent.name,
        role: agent.role,
        desiredSkills: desiredSkillAssignment.desiredSkills,
        projectPlacement: requestedProjectPlacement,
      },
    });
    const telemetryClient = getTelemetryClientFn();
    if (telemetryClient) {
      trackAgentCreatedFn(telemetryClient, { agentRole: agent.role });
    }

    await applyDefaultAgentTaskAssignGrant(
      companyId,
      agent.id,
      req.actor.type === "board" ? (req.actor.userId ?? null) : null,
    );

    if (agent.budgetMonthlyCents > 0) {
      await budgets.upsertPolicy(
        companyId,
        {
          scopeType: "agent",
          scopeId: agent.id,
          amount: agent.budgetMonthlyCents,
          windowKind: "calendar_month_utc",
        },
        actor.actorType === "user" ? actor.actorId : null,
      );
    }

    res.status(201).json(agent);
  });

  router.post("/agents/:id/project-placement", validate(agentProjectPlacementInputSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    assertBoard(req);
    assertCompanyAccess(req, existing.companyId);

    const placement = await placementSvc.applyPrimaryPlacement({
      companyId: existing.companyId,
      agentId: existing.id,
      placement: req.body,
      actor: placementActorFromRequest(req),
    });

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.project_placement_updated",
      entityType: "agent",
      entityId: existing.id,
      details: {
        projectPlacement: placement.resolved,
      },
    });

    const updatedAgent = await svc.getById(existing.id);
    res.status(201).json({
      agent: updatedAgent,
      scope: placement.scope,
    });
  });

  router.patch("/agents/:id/permissions", validate(updateAgentPermissionsSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    if (req.actor.type === "agent") {
      const actorAgent = req.actor.agentId ? await svc.getById(req.actor.agentId) : null;
      if (!actorAgent || actorAgent.companyId !== existing.companyId) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      if (!agentHasCreatePermission(actorAgent)) {
        res.status(403).json({ error: "Only agents with create authority can manage permissions" });
        return;
      }
    }

    const agent = await svc.updatePermissions(id, req.body);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const effectiveCanAssignTasks =
      agentHasCreatePermission(agent) || req.body.canAssignTasks;
    await access.ensureMembership(agent.companyId, "agent", agent.id, "member", "active");
    await access.setPrincipalPermission(
      agent.companyId,
      "agent",
      agent.id,
      "tasks:assign",
      effectiveCanAssignTasks,
      req.actor.type === "board" ? (req.actor.userId ?? null) : null,
    );

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: agent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.permissions_updated",
      entityType: "agent",
      entityId: agent.id,
      details: {
        canCreateAgents: agent.permissions?.canCreateAgents ?? false,
        canAssignTasks: effectiveCanAssignTasks,
      },
    });

    res.json(await buildAgentDetail(agent));
  });

  router.patch("/agents/:id/instructions-path", validate(updateAgentInstructionsPathSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    await assertCanManageInstructionsPath(req, existing);

    const existingAdapterConfig = asRecord(existing.adapterConfig) ?? {};
    const explicitKey = asNonEmptyString(req.body.adapterConfigKey);
    const defaultKey = resolveInstructionsPathKey(existing.adapterType);
    const adapterConfigKey = explicitKey ?? defaultKey;
    if (!adapterConfigKey) {
      res.status(422).json({
        error: `No default instructions path key for adapter type '${existing.adapterType}'. Provide adapterConfigKey.`,
      });
      return;
    }

    const nextAdapterConfig: Record<string, unknown> = { ...existingAdapterConfig };
    if (req.body.path === null) {
      delete nextAdapterConfig[adapterConfigKey];
    } else {
      const resolvedPath = resolveInstructionsFilePath(req.body.path, existingAdapterConfig);
      await assertAllowedExternalInstructionsRoot(path.dirname(resolvedPath));
      nextAdapterConfig[adapterConfigKey] = resolvedPath;
    }

    const syncedAdapterConfig = syncInstructionsBundleConfigFromFilePath(existing, nextAdapterConfig);
    if (req.body.path !== null) {
      syncedAdapterConfig.instructionsBundleRole ??= resolveDefaultAgentInstructionsBundleRole(existing.role);
      syncedAdapterConfig.instructionsRootPolicy = "allowlisted_external";
      syncedAdapterConfig.instructionsMemoryOwnership ??= "agent_authored";
    }
    const normalizedAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
      existing.companyId,
      syncedAdapterConfig,
      { strictMode: strictSecretsMode },
    );
    const actor = getActorInfo(req);
    const agent = await svc.update(
      id,
      { adapterConfig: normalizedAdapterConfig },
      {
        recordRevision: {
          createdByAgentId: actor.agentId,
          createdByUserId: actor.actorType === "user" ? actor.actorId : null,
          source: "instructions_path_patch",
        },
      },
    );
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const updatedAdapterConfig = asRecord(agent.adapterConfig) ?? {};
    const pathValue = asNonEmptyString(updatedAdapterConfig[adapterConfigKey]);

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.instructions_path_updated",
      entityType: "agent",
      entityId: agent.id,
      details: {
        adapterConfigKey,
        path: pathValue,
        cleared: req.body.path === null,
      },
    });

    res.json({
      agentId: agent.id,
      adapterType: agent.adapterType,
      adapterConfigKey,
      path: pathValue,
    });
  });

  router.get("/agents/:id/instructions-bundle", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanReadAgent(req, existing);
    const bundle = await instructions.getBundle(existing);
    if (bundle.mode === "external" && bundle.rootPath) {
      bundle.externalRootAllowed = await assertAllowedExternalInstructionsRoot(bundle.rootPath)
        .then(() => true)
        .catch(() => false);
    } else {
      bundle.externalRootAllowed = true;
    }
    res.json(bundle);
  });

  router.get("/agents/:id/memory", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanReadAgent(req, existing);
    res.json(await memory.getAgentMemory(existing));
  });

  router.get("/agents/:id/productivity", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    assertBoard(req);
    assertCompanyAccess(req, existing.companyId);
    const summary = await productivity.agentSummary(existing.id, { window: parseProductivityWindow(req.query.window) });
    if (!summary) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    res.json(summary);
  });

  router.get("/agents/:id/memory/file", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanReadAgent(req, existing);
    const relativePath = typeof req.query.path === "string" ? req.query.path : "";
    if (!relativePath.trim()) {
      res.status(422).json({ error: "Query parameter 'path' is required" });
      return;
    }
    res.json(await memory.readAgentMemoryFile(existing, relativePath));
  });

  router.put("/agents/:id/memory/file", validate(upsertMemoryFileSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanWriteAgentMemory(req, existing);
    const actor = getActorInfo(req);
    const result = await memory.writeAgentMemoryFile(existing, req.body.path, req.body.content);
    if (result.adapterConfig) {
      const normalizedAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
        existing.companyId,
        result.adapterConfig,
        { strictMode: strictSecretsMode },
      );
      await svc.update(
        id,
        { adapterConfig: normalizedAdapterConfig },
        {
          recordRevision: {
            createdByAgentId: actor.agentId,
            createdByUserId: actor.actorType === "user" ? actor.actorId : null,
            source: "agent_memory_write",
          },
        },
      );
    }
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: result.file.path === "hot/MEMORY.md" ? "agent.memory_hot_updated" : "agent.memory_file_updated",
      entityType: "agent",
      entityId: existing.id,
      details: {
        path: result.file.path,
        size: result.file.size,
        layer: result.file.layer,
      },
    });
    res.json(result.file);
  });

  router.post("/agents/:id/memory/migrate-hot", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanWriteAgentMemory(req, existing);
    const actor = getActorInfo(req);
    const { result, adapterConfig } = await memory.migrateAgentHotMemory(existing);
    if (adapterConfig) {
      const normalizedAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
        existing.companyId,
        adapterConfig,
        { strictMode: strictSecretsMode },
      );
      await svc.update(
        id,
        { adapterConfig: normalizedAdapterConfig },
        {
          recordRevision: {
            createdByAgentId: actor.agentId,
            createdByUserId: actor.actorType === "user" ? actor.actorId : null,
            source: "agent_memory_migrate_hot",
          },
        },
      );
    }
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.memory_hot_migrated",
      entityType: "agent",
      entityId: existing.id,
      details: {
        archivePath: result.archivePath,
        oldBytes: result.oldBytes,
        newHotBytes: result.newHotBytes,
        createdFiles: result.createdFiles,
        updatedFiles: result.updatedFiles,
      },
    });
    res.json(result);
  });

  router.patch("/agents/:id/instructions-bundle", validate(updateAgentInstructionsBundleSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanManageInstructionsPath(req, existing);
    if (req.body.resetMemory === true) {
      assertBoard(req);
      assertCompanyAccess(req, existing.companyId);
    }
    if ((req.body.mode ?? undefined) === "external") {
      const requestedRoot = typeof req.body.rootPath === "string" ? req.body.rootPath : null;
      const currentRoot = asNonEmptyString(asRecord(existing.adapterConfig)?.instructionsRootPath);
      const externalRoot = requestedRoot ?? currentRoot;
      if (!externalRoot) {
        res.status(422).json({ error: "External instructions bundles require an absolute rootPath" });
        return;
      }
      await assertAllowedExternalInstructionsRoot(externalRoot);
    }

    const actor = getActorInfo(req);
    const { bundle, adapterConfig } = await instructions.updateBundle(existing, req.body);
    const normalizedAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
      existing.companyId,
      adapterConfig,
      { strictMode: strictSecretsMode },
    );
    await svc.update(
      id,
      { adapterConfig: normalizedAdapterConfig },
      {
        recordRevision: {
          createdByAgentId: actor.agentId,
          createdByUserId: actor.actorType === "user" ? actor.actorId : null,
          source: "instructions_bundle_patch",
        },
      },
    );

    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.instructions_bundle_updated",
      entityType: "agent",
      entityId: existing.id,
      details: {
        mode: bundle.mode,
        bundleRole: bundle.bundleRole,
        rootPolicy: bundle.rootPolicy,
        memoryOwnership: bundle.memoryOwnership,
        rootPath: bundle.rootPath,
        entryFile: bundle.entryFile,
        clearLegacyPromptTemplate: req.body.clearLegacyPromptTemplate === true,
        resetMemory: req.body.resetMemory === true,
      },
    });

    if (bundle.mode === "external" && bundle.rootPath) {
      bundle.externalRootAllowed = await assertAllowedExternalInstructionsRoot(bundle.rootPath)
        .then(() => true)
        .catch(() => false);
    } else {
      bundle.externalRootAllowed = true;
    }
    res.json(bundle);
  });

  router.post("/agents/:id/instructions-bundle/repair-defaults", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    assertBoard(req);
    assertCompanyAccess(req, existing.companyId);

    const actor = getActorInfo(req);
    const defaults = await loadDefaultAgentInstructionsBundle(
      resolveDefaultAgentInstructionsBundleRole(existing.role),
    );
    const result = await instructions.repairManagedBundleDefaults(existing, defaults, {
      entryFile: "AGENTS.md",
      resetMemory: false,
    });
    const normalizedAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
      existing.companyId,
      result.adapterConfig,
      { strictMode: strictSecretsMode },
    );
    await svc.update(
      id,
      { adapterConfig: normalizedAdapterConfig },
      {
        recordRevision: {
          createdByAgentId: actor.agentId,
          createdByUserId: actor.actorType === "user" ? actor.actorId : null,
          source: "instructions_bundle_repair_defaults",
        },
      },
    );

    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.instructions_bundle_repaired",
      entityType: "agent",
      entityId: existing.id,
      details: {
        createdFiles: result.createdFiles,
      },
    });

    res.json({
      bundle: result.bundle,
      createdFiles: result.createdFiles,
    });
  });

  router.get("/agents/:id/instructions-bundle/file", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanReadAgent(req, existing);

    const relativePath = typeof req.query.path === "string" ? req.query.path : "";
    if (!relativePath.trim()) {
      res.status(422).json({ error: "Query parameter 'path' is required" });
      return;
    }

    res.json(await instructions.readFile(existing, relativePath));
  });

  router.put("/agents/:id/instructions-bundle/file", validate(upsertAgentInstructionsFileSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanManageInstructionsPath(req, existing);
    if (req.body.resetMemory === true) {
      assertBoard(req);
      assertCompanyAccess(req, existing.companyId);
    }

    const actor = getActorInfo(req);
    const result = await instructions.writeFile(existing, req.body.path, req.body.content, {
      clearLegacyPromptTemplate: req.body.clearLegacyPromptTemplate,
      resetMemory: req.body.resetMemory,
    });
    const normalizedAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
      existing.companyId,
      result.adapterConfig,
      { strictMode: strictSecretsMode },
    );
    await svc.update(
      id,
      { adapterConfig: normalizedAdapterConfig },
      {
        recordRevision: {
          createdByAgentId: actor.agentId,
          createdByUserId: actor.actorType === "user" ? actor.actorId : null,
          source: "instructions_bundle_file_put",
        },
      },
    );

    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.instructions_file_updated",
      entityType: "agent",
      entityId: existing.id,
      details: {
        path: result.file.path,
        size: result.file.size,
        clearLegacyPromptTemplate: req.body.clearLegacyPromptTemplate === true,
        resetMemory: req.body.resetMemory === true,
      },
    });

    res.json(result.file);
  });

  router.delete("/agents/:id/instructions-bundle/file", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanManageInstructionsPath(req, existing);

    const relativePath = typeof req.query.path === "string" ? req.query.path : "";
    if (!relativePath.trim()) {
      res.status(422).json({ error: "Query parameter 'path' is required" });
      return;
    }

    const actor = getActorInfo(req);
    const result = await instructions.deleteFile(existing, relativePath);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.instructions_file_deleted",
      entityType: "agent",
      entityId: existing.id,
      details: {
        path: relativePath,
      },
    });

    res.json(result.bundle);
  });

  router.patch("/agents/:id", validate(updateAgentSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanUpdateAgent(req, existing);

    if (hasOwn(req.body as object, "permissions")) {
      res.status(422).json({ error: "Use /api/agents/:id/permissions for permission changes" });
      return;
    }

    const patchData = { ...(req.body as Record<string, unknown>) };
    const replaceAdapterConfig = patchData.replaceAdapterConfig === true;
    delete patchData.replaceAdapterConfig;
    if (hasOwn(patchData, "adapterConfig")) {
      const adapterConfig = asRecord(patchData.adapterConfig);
      if (!adapterConfig) {
        res.status(422).json({ error: "adapterConfig must be an object" });
        return;
      }
      assertNoAgentAdapterConfigMutation(req, adapterConfig);
      const changingInstructionsConfig = adapterConfigTouchesInstructionsConfig(adapterConfig);
      if (changingInstructionsConfig) {
        await assertCanManageInstructionsPath(req, existing);
      }
      patchData.adapterConfig = adapterConfig;
    }

    const requestedAdapterType = hasOwn(patchData, "adapterType")
      ? assertKnownAdapterType(patchData.adapterType as string | null | undefined)
      : existing.adapterType;
    let requestedRuntimeConfig: Record<string, unknown> | null = null;
    if (hasOwn(patchData, "runtimeConfig")) {
      const runtimeConfig = asRecord(patchData.runtimeConfig);
      if (!runtimeConfig) {
        res.status(422).json({ error: "runtimeConfig must be an object" });
        return;
      }
      assertNoAgentRuntimeConfigAdapterConfigMutation(req, runtimeConfig);
      requestedRuntimeConfig = runtimeConfig;
    }
    const touchesAdapterConfiguration =
      hasOwn(patchData, "adapterType") ||
      hasOwn(patchData, "adapterConfig");
    if (touchesAdapterConfiguration) {
      const existingAdapterConfig = asRecord(existing.adapterConfig) ?? {};
      const changingAdapterType =
        typeof patchData.adapterType === "string" && patchData.adapterType !== existing.adapterType;
      const requestedAdapterConfig = hasOwn(patchData, "adapterConfig")
        ? (asRecord(patchData.adapterConfig) ?? {})
        : null;
      if (
        requestedAdapterConfig
        && replaceAdapterConfig
        && KNOWN_INSTRUCTIONS_BUNDLE_KEYS.some((key) =>
          existingAdapterConfig[key] !== undefined && requestedAdapterConfig[key] === undefined,
        )
      ) {
        await assertCanManageInstructionsPath(req, existing);
      }
      let rawEffectiveAdapterConfig = requestedAdapterConfig ?? existingAdapterConfig;
      if (requestedAdapterConfig && !changingAdapterType && !replaceAdapterConfig) {
        rawEffectiveAdapterConfig = { ...existingAdapterConfig, ...requestedAdapterConfig };
      }
      if (changingAdapterType) {
        // Preserve adapter-agnostic keys (env, cwd, etc.) from the existing config
        // when the adapter type changes. Without this, a PATCH that includes
        // adapterConfig but omits these keys would silently drop them.
        const ADAPTER_AGNOSTIC_KEYS = [
          "env", "cwd", "timeoutSec", "graceSec",
          "promptTemplate", "bootstrapPromptTemplate",
        ] as const;
        for (const key of ADAPTER_AGNOSTIC_KEYS) {
          if (rawEffectiveAdapterConfig[key] === undefined && existingAdapterConfig[key] !== undefined) {
            rawEffectiveAdapterConfig = { ...rawEffectiveAdapterConfig, [key]: existingAdapterConfig[key] };
          }
        }
        rawEffectiveAdapterConfig = preserveInstructionsBundleConfig(
          existingAdapterConfig,
          rawEffectiveAdapterConfig,
        );
      }
      const effectiveAdapterConfig = applyCreateDefaultsByAdapterType(
        requestedAdapterType,
        rawEffectiveAdapterConfig,
      );
      const normalizedEffectiveAdapterConfig = await normalizeMediatedAdapterConfigForPersistence({
        companyId: existing.companyId,
        adapterType: requestedAdapterType,
        adapterConfig: effectiveAdapterConfig,
      });
      patchData.adapterConfig = syncInstructionsBundleConfigFromFilePath(existing, normalizedEffectiveAdapterConfig);
    }
    if (requestedRuntimeConfig) {
      const baseAdapterConfig = asRecord(patchData.adapterConfig) ?? asRecord(existing.adapterConfig) ?? {};
      patchData.runtimeConfig = await normalizeRuntimeConfigAdapterConfigsForPersistence(
        existing.companyId,
        requestedAdapterType,
        requestedRuntimeConfig,
        baseAdapterConfig,
      );
    }
    if (touchesAdapterConfiguration || Object.prototype.hasOwnProperty.call(patchData, "defaultEnvironmentId")) {
      await assertAgentEnvironmentSelection(
        existing.companyId,
        requestedAdapterType,
        Object.prototype.hasOwnProperty.call(patchData, "defaultEnvironmentId")
          ? (typeof patchData.defaultEnvironmentId === "string" ? patchData.defaultEnvironmentId : null)
          : existing.defaultEnvironmentId,
      );
    }

    const actor = getActorInfo(req);
    const agent = await svc.update(id, patchData, {
      recordRevision: {
        createdByAgentId: actor.agentId,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
        source: "patch",
      },
    });
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.updated",
      entityType: "agent",
      entityId: agent.id,
      details: summarizeAgentUpdateDetails(patchData),
    });

    res.json(agent);
  });

  router.post("/agents/:id/pause", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const agent = await svc.pause(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    await heartbeat.cancelActiveForAgent(id);

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "agent.paused",
      entityType: "agent",
      entityId: agent.id,
    });

    res.json(agent);
  });

  router.post("/agents/:id/resume", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const agent = await svc.resume(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "agent.resumed",
      entityType: "agent",
      entityId: agent.id,
    });

    res.json(agent);
  });

  router.post("/agents/:id/terminate", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const agent = await svc.terminate(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    await heartbeat.cancelActiveForAgent(id);

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "agent.terminated",
      entityType: "agent",
      entityId: agent.id,
    });

    res.json(agent);
  });

  router.delete("/agents/:id", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    res.status(409).json({
      error: "Hard-deleting agents is disabled to preserve audit history. Use /api/agents/:id/terminate instead.",
    });
  });

  router.get("/agents/:id/keys", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const keys = await svc.listKeys(id);
    res.json(keys);
  });

  router.post("/agents/:id/keys", validate(createAgentKeySchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const key = await svc.createApiKey(id, req.body.name);

    const agent = await svc.getById(id);
    if (agent) {
      await logActivity(db, {
        companyId: agent.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "agent.key_created",
        entityType: "agent",
        entityId: agent.id,
        details: { keyId: key.id, name: key.name },
      });
    }

    res.status(201).json(key);
  });

  router.delete("/agents/:id/keys/:keyId", async (req, res) => {
    assertBoard(req);
    const keyId = req.params.keyId as string;
    const revoked = await svc.revokeKey(keyId);
    if (!revoked) {
      res.status(404).json({ error: "Key not found" });
      return;
    }
    res.json({ ok: true });
  });

  router.post("/agents/:id/wakeup", validate(wakeAgentSchema), async (req, res) => {
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    assertCompanyAccess(req, agent.companyId);

    if (req.actor.type === "agent" && req.actor.agentId !== id) {
      res.status(403).json({ error: "Agent can only invoke itself" });
      return;
    }

    const run = await heartbeat.wakeup(id, {
      source: req.body.source,
      triggerDetail: req.body.triggerDetail ?? "manual",
      reason: req.body.reason ?? null,
      payload: req.body.payload ?? null,
      idempotencyKey: req.body.idempotencyKey ?? null,
      requestedByActorType: req.actor.type === "agent" ? "agent" : "user",
      requestedByActorId: req.actor.type === "agent" ? req.actor.agentId ?? null : req.actor.userId ?? null,
      contextSnapshot: {
        triggeredBy: req.actor.type,
        actorId: req.actor.type === "agent" ? req.actor.agentId : req.actor.userId,
        forceFreshSession: req.body.forceFreshSession === true,
      },
    });

    if (!run) {
      res.status(202).json(await buildSkippedWakeupResponse(agent, req.body.payload ?? null));
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: agent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "heartbeat.invoked",
      entityType: "heartbeat_run",
      entityId: run.id,
      details: { agentId: id },
    });

    res.status(202).json(run);
  });

  router.post("/agents/:id/heartbeat/invoke", async (req, res) => {
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    assertCompanyAccess(req, agent.companyId);

    if (req.actor.type === "agent" && req.actor.agentId !== id) {
      res.status(403).json({ error: "Agent can only invoke itself" });
      return;
    }

    const run = await heartbeat.invoke(
      id,
      "on_demand",
      {
        triggeredBy: req.actor.type,
        actorId: req.actor.type === "agent" ? req.actor.agentId : req.actor.userId,
      },
      "manual",
      {
        actorType: req.actor.type === "agent" ? "agent" : "user",
        actorId: req.actor.type === "agent" ? req.actor.agentId ?? null : req.actor.userId ?? null,
      },
    );

    if (!run) {
      res.status(202).json({ status: "skipped" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: agent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "heartbeat.invoked",
      entityType: "heartbeat_run",
      entityId: run.id,
      details: { agentId: id },
    });

    res.status(202).json(run);
  });

  router.post("/agents/:id/claude-login", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    assertCompanyAccess(req, agent.companyId);
    if (agent.adapterType !== "claude_local") {
      res.status(400).json({ error: "Login is only supported for claude_local agents" });
      return;
    }

    const config = asRecord(agent.adapterConfig) ?? {};
    const { config: runtimeConfig } = await secretsSvc.resolveAdapterConfigForRuntime(agent.companyId, config);
    const result = await runClaudeLogin({
      runId: `claude-login-${randomUUID()}`,
      agent: {
        id: agent.id,
        companyId: agent.companyId,
        name: agent.name,
        adapterType: agent.adapterType,
        adapterConfig: agent.adapterConfig,
      },
      config: runtimeConfig,
    });

    res.json(result);
  });

  router.get("/companies/:companyId/heartbeat-runs", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const agentId = req.query.agentId as string | undefined;
    const limitParam = req.query.limit as string | undefined;
    const limit = limitParam ? Math.max(1, Math.min(1000, parseInt(limitParam, 10) || 200)) : undefined;
    const runs = await heartbeat.list(companyId, agentId, limit);
    res.json(runs);
  });

  router.get("/companies/:companyId/live-runs", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    // `minCount` is a padding floor for callers that want a minimum number of
    // recent runs to render (e.g. dashboard cards). It must default to 0 so
    // callers asking for "live runs" get only actually-live runs — otherwise
    // every caller with no minCount param gets up to 50 historical runs
    // padded in and renders bogus "live" counts.
    const minCount = readLiveRunsQueryInt(req.query.minCount, 50, 0);
    const limit = readLiveRunsQueryInt(req.query.limit, 50, 50);

    const columns = {
      id: heartbeatRuns.id,
      status: heartbeatRuns.status,
      invocationSource: heartbeatRuns.invocationSource,
      triggerDetail: heartbeatRuns.triggerDetail,
      contextCommentId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'commentId'`.as("contextCommentId"),
      contextWakeCommentId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'wakeCommentId'`.as("contextWakeCommentId"),
      startedAt: heartbeatRuns.startedAt,
      finishedAt: heartbeatRuns.finishedAt,
      createdAt: heartbeatRuns.createdAt,
      lastOutputAt: heartbeatRuns.lastOutputAt,
      lastOutputSeq: heartbeatRuns.lastOutputSeq,
      lastOutputStream: heartbeatRuns.lastOutputStream,
      processStartedAt: heartbeatRuns.processStartedAt,
      agentId: heartbeatRuns.agentId,
      agentName: agentsTable.name,
      adapterType: agentsTable.adapterType,
      issueId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`.as("issueId"),
    };

    const liveRuns = await db
      .select(columns)
      .from(heartbeatRuns)
      .innerJoin(agentsTable, eq(heartbeatRuns.agentId, agentsTable.id))
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          inArray(heartbeatRuns.status, ["queued", "running"]),
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt))
      .limit(limit);

    const targetRunCount = Math.min(minCount, limit);
    if (targetRunCount > 0 && liveRuns.length < targetRunCount) {
      const activeIds = liveRuns.map((r) => r.id);
      const recentRuns = await db
        .select(columns)
        .from(heartbeatRuns)
        .innerJoin(agentsTable, eq(heartbeatRuns.agentId, agentsTable.id))
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            not(inArray(heartbeatRuns.status, ["queued", "running"])),
            ...(activeIds.length > 0 ? [not(inArray(heartbeatRuns.id, activeIds))] : []),
          ),
        )
        .orderBy(desc(heartbeatRuns.createdAt))
        .limit(targetRunCount - liveRuns.length);

      res.json(await Promise.all([...liveRuns, ...recentRuns].map(async (run) => ({
        ...run,
        outputSilence: await buildOutputSilence({ ...run, companyId }),
      }))));
      return;
    }

    res.json(await Promise.all(liveRuns.map(async (run) => ({
      ...run,
      outputSilence: await buildOutputSilence({ ...run, companyId }),
    }))));
  });

  router.get("/heartbeat-runs/:runId", async (req, res) => {
    const runId = req.params.runId as string;
    const run = await heartbeat.getRun(runId);
    if (!run) {
      res.status(404).json({ error: "Heartbeat run not found" });
      return;
    }
    assertCompanyAccess(req, run.companyId);
    res.json(redactCurrentUserValue(
      { ...run, outputSilence: await buildOutputSilence(run) },
      await getCurrentUserRedactionOptions(),
    ));
  });

  router.post("/heartbeat-runs/:runId/cancel", async (req, res) => {
    assertBoard(req);
    const runId = req.params.runId as string;
    const existing = await heartbeat.getRun(runId);
    if (existing) {
      assertCompanyAccess(req, existing.companyId);
    }
    const run = await heartbeat.cancelRun(runId);

    if (run) {
      await logActivity(db, {
        companyId: run.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "heartbeat.cancelled",
        entityType: "heartbeat_run",
        entityId: run.id,
        details: { agentId: run.agentId },
      });
    }

    res.json(run);
  });

  router.post("/heartbeat-runs/:runId/watchdog-decisions", async (req, res) => {
    assertBoard(req);
    const runId = req.params.runId as string;
    const existing = await heartbeat.getRun(runId);
    if (!existing) {
      res.status(404).json({ error: "Heartbeat run not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const decision = typeof req.body?.decision === "string" ? req.body.decision : "";
    if (!["snooze", "continue", "dismissed_false_positive"].includes(decision)) {
      res.status(400).json({ error: "Unsupported watchdog decision" });
      return;
    }
    const evaluationIssueId = typeof req.body?.evaluationIssueId === "string" ? req.body.evaluationIssueId : null;
    const reason = typeof req.body?.reason === "string" ? req.body.reason.slice(0, 4000) : null;
    const snoozedUntil = decision === "snooze"
      ? new Date(String(req.body?.snoozedUntil ?? ""))
      : null;
    if (decision === "snooze" && (!snoozedUntil || Number.isNaN(snoozedUntil.getTime()) || snoozedUntil <= new Date())) {
      res.status(400).json({ error: "snoozedUntil must be a future ISO datetime" });
      return;
    }

    const row = await heartbeat.recordWatchdogDecision({
      runId: existing.id,
      actor: { type: "board", userId: req.actor.userId ?? null, runId: req.actor.runId ?? null },
      decision: decision as "snooze" | "continue" | "dismissed_false_positive",
      evaluationIssueId,
      reason,
      snoozedUntil,
      createdByRunId: req.actor.runId ?? null,
    });

    res.json(row);
  });

  router.get("/heartbeat-runs/:runId/events", async (req, res) => {
    const runId = req.params.runId as string;
    const run = await heartbeat.getRun(runId);
    if (!run) {
      res.status(404).json({ error: "Heartbeat run not found" });
      return;
    }
    assertCompanyAccess(req, run.companyId);

    const afterSeq = Number(req.query.afterSeq ?? 0);
    const limit = Number(req.query.limit ?? 200);
    const events = await heartbeat.listEvents(runId, Number.isFinite(afterSeq) ? afterSeq : 0, Number.isFinite(limit) ? limit : 200);
    const currentUserRedactionOptions = await getCurrentUserRedactionOptions();
    const redactedEvents = events.map((event) =>
      redactCurrentUserValue({
        ...event,
        payload: redactEventPayload(event.payload),
      }, currentUserRedactionOptions),
    );
    res.json(redactedEvents);
  });

  router.get("/heartbeat-runs/:runId/log", async (req, res) => {
    const runId = req.params.runId as string;
    const run = await heartbeat.getRunLogAccess(runId);
    if (!run) {
      res.status(404).json({ error: "Heartbeat run not found" });
      return;
    }
    assertCompanyAccess(req, run.companyId);

    const offset = Number(req.query.offset ?? 0);
    const limitBytes = Number(req.query.limitBytes ?? 256000);
    const result = await heartbeat.readLog(run, {
      offset: Number.isFinite(offset) ? offset : 0,
      limitBytes: Number.isFinite(limitBytes) ? limitBytes : 256000,
    });

    res.set("Cache-Control", "no-cache, no-store");
    res.json(result);
  });

  router.get("/heartbeat-runs/:runId/workspace-operations", async (req, res) => {
    const runId = req.params.runId as string;
    const run = await heartbeat.getRun(runId);
    if (!run) {
      res.status(404).json({ error: "Heartbeat run not found" });
      return;
    }
    assertCompanyAccess(req, run.companyId);

    const context = asRecord(run.contextSnapshot);
    const executionWorkspaceId = asNonEmptyString(context?.executionWorkspaceId);
    const operations = await workspaceOperations.listForRun(runId, executionWorkspaceId);
    res.json(redactCurrentUserValue(operations, await getCurrentUserRedactionOptions()));
  });

  router.get("/workspace-operations/:operationId/log", async (req, res) => {
    const operationId = req.params.operationId as string;
    const operation = await workspaceOperations.getById(operationId);
    if (!operation) {
      res.status(404).json({ error: "Workspace operation not found" });
      return;
    }
    assertCompanyAccess(req, operation.companyId);

    const offset = Number(req.query.offset ?? 0);
    const limitBytes = Number(req.query.limitBytes ?? 256000);
    const result = await workspaceOperations.readLog(operationId, {
      offset: Number.isFinite(offset) ? offset : 0,
      limitBytes: Number.isFinite(limitBytes) ? limitBytes : 256000,
    });

    res.set("Cache-Control", "no-cache, no-store");
    res.json(result);
  });

  router.get("/issues/:issueId/live-runs", async (req, res) => {
    const rawId = req.params.issueId as string;
    const isIdentifier = /^[A-Z]+-\d+$/i.test(rawId);
    const issue = isIdentifier ? await issuesSvc.getByIdentifier(rawId) : await issuesSvc.getById(rawId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);

    const liveRuns = await db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        invocationSource: heartbeatRuns.invocationSource,
        triggerDetail: heartbeatRuns.triggerDetail,
        contextCommentId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'commentId'`.as("contextCommentId"),
        contextWakeCommentId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'wakeCommentId'`.as("contextWakeCommentId"),
        startedAt: heartbeatRuns.startedAt,
        finishedAt: heartbeatRuns.finishedAt,
        createdAt: heartbeatRuns.createdAt,
        lastOutputAt: heartbeatRuns.lastOutputAt,
        lastOutputSeq: heartbeatRuns.lastOutputSeq,
        lastOutputStream: heartbeatRuns.lastOutputStream,
        processStartedAt: heartbeatRuns.processStartedAt,
        agentId: heartbeatRuns.agentId,
        agentName: agentsTable.name,
        adapterType: agentsTable.adapterType,
      })
      .from(heartbeatRuns)
      .innerJoin(agentsTable, eq(heartbeatRuns.agentId, agentsTable.id))
      .where(
        and(
          eq(heartbeatRuns.companyId, issue.companyId),
          inArray(heartbeatRuns.status, ["queued", "running"]),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}`,
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt));

    res.json(await Promise.all(liveRuns.map(async (run) => ({
      ...run,
      outputSilence: await buildOutputSilence({ ...run, companyId: issue.companyId }),
    }))));
  });

  router.get("/issues/:issueId/active-run", async (req, res) => {
    const rawId = req.params.issueId as string;
    const isIdentifier = /^[A-Z]+-\d+$/i.test(rawId);
    const issue = isIdentifier ? await issuesSvc.getByIdentifier(rawId) : await issuesSvc.getById(rawId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);

    let run = issue.executionRunId ? await heartbeat.getRunIssueSummary(issue.executionRunId) : null;
    if (run && run.status !== "queued" && run.status !== "running") {
      run = null;
    }

    if (!run && issue.assigneeAgentId && issue.status === "in_progress") {
      const candidateRun = await heartbeat.getActiveRunIssueSummaryForAgent(issue.assigneeAgentId);
      const candidateIssueId = asNonEmptyString(candidateRun?.issueId);
      if (candidateRun && candidateIssueId === issue.id) {
        run = candidateRun;
      }
    }
    if (!run) {
      res.json(null);
      return;
    }

    const agent = await svc.getById(run.agentId);
    if (!agent) {
      res.json(null);
      return;
    }

    res.json({
      ...run,
      agentId: agent.id,
      agentName: agent.name,
      adapterType: agent.adapterType,
      outputSilence: await buildOutputSilence({ ...run, companyId: issue.companyId }),
    });
  });

  return router;
}
