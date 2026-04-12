import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gt, gte, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  agentProjectScopes,
  agentSecondaryRelationships,
  agentTemplateRevisions,
  agentTemplates,
  agentConfigRevisions,
  agentApiKeys,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  activityLog,
  costEvents,
  heartbeatRunEvents,
  heartbeatRuns,
  issueExecutionDecisions,
  issues,
  issueComments,
  portfolioClusters,
  projects,
} from "@paperclipai/db";
import {
  AGENT_ROLES,
  AGENT_DEPARTMENT_LABELS,
  type AgentDepartmentKey,
  type AgentNavigationLayout,
  type AgentOperatingClass,
  type AgentOrgLevel,
  type AgentProjectRole,
  type AgentRole,
  isUuidLike,
  normalizeAgentUrlKey,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import {
  agentHasCreatePermission,
  defaultCapabilityProfileKeyForAgent,
  defaultOperatingClassForLegacyAgent,
  normalizeAgentPermissions,
} from "./agent-permissions.js";
import { readAgentTemplateMode, withAgentTemplateMode } from "./agent-template-metadata.js";
import { REDACTED_EVENT_VALUE, sanitizeRecord } from "../redaction.js";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function createToken() {
  return `pcp_${randomBytes(24).toString("hex")}`;
}

const CONFIG_REVISION_FIELDS = [
  "templateId",
  "templateRevisionId",
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
  "requestedByPrincipalType",
  "requestedByPrincipalId",
  "requestedForProjectId",
  "requestedReason",
  "metadata",
] as const;

type ConfigRevisionField = (typeof CONFIG_REVISION_FIELDS)[number];
type AgentConfigSnapshot = Pick<typeof agents.$inferSelect, ConfigRevisionField>;
type DbExecutor = Pick<Db, "select" | "insert" | "update">;

interface RevisionMetadata {
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
  source?: string;
  rolledBackFromRevisionId?: string | null;
}

interface UpdateAgentOptions {
  recordRevision?: RevisionMetadata;
}

interface BatchAdapterConfigChange {
  id: string;
  adapterConfig: Record<string, unknown>;
}

interface BatchUpdateAdapterConfigsOptions {
  recordRevision?: RevisionMetadata;
}

interface AgentShortnameRow {
  id: string;
  name: string;
  status: string;
}

interface AgentShortnameCollisionOptions {
  excludeAgentId?: string | null;
}

const EXECUTIVE_ROLES = new Set(["ceo", "cto", "cfo", "cmo", "coo"]);
const EXECUTIVE_SORT_ORDER = ["ceo", "cto", "cfo", "coo", "cmo"] as const;
const DEPARTMENT_SORT_ORDER: AgentDepartmentKey[] = [
  "engineering",
  "product",
  "design",
  "marketing",
  "finance",
  "operations",
  "research",
  "general",
  "custom",
];

const ROLE_DEPARTMENT_DEFAULTS: Record<string, AgentDepartmentKey> = {
  ceo: "executive",
  cto: "engineering",
  cfo: "finance",
  cmo: "marketing",
  coo: "operations",
  engineer: "engineering",
  qa: "engineering",
  devops: "engineering",
  pm: "product",
  designer: "design",
  researcher: "research",
  general: "general",
};

interface AgentHierarchyState {
  role: string;
  reportsTo: string | null;
  orgLevel: AgentOrgLevel;
  operatingClass: AgentOperatingClass;
  capabilityProfileKey: string;
  archetypeKey: string;
  departmentKey: AgentDepartmentKey;
  departmentName: string | null;
}

export interface NormalizedAgentRow
  extends Omit<
    typeof agents.$inferSelect,
    "role" | "orgLevel" | "operatingClass" | "capabilityProfileKey" | "departmentKey" | "departmentName" | "permissions"
  > {
  role: AgentRole;
  urlKey: string;
  orgLevel: AgentOrgLevel;
  operatingClass: AgentOperatingClass;
  capabilityProfileKey: string;
  archetypeKey: string;
  departmentKey: AgentDepartmentKey;
  departmentName: string | null;
  permissions: ReturnType<typeof normalizeAgentPermissions>;
}

interface HierarchyDepartmentGroup {
  key: AgentDepartmentKey;
  name: string;
  ownerExecutiveId: string | null;
  ownerExecutiveName: string | null;
  directors: NormalizedAgentRow[];
  staff: NormalizedAgentRow[];
}

interface HierarchyExecutiveGroup {
  executive: NormalizedAgentRow;
  departments: Map<string, HierarchyDepartmentGroup>;
}

interface ActiveScopeRow {
  scope: typeof agentProjectScopes.$inferSelect;
  projectId: string;
  portfolioClusterId: string | null;
  projectName: string;
  projectColor: string | null;
}

interface ProjectPodGroup {
  projectId: string;
  projectName: string;
  color: string | null;
  leadership: NormalizedAgentRow[];
  workers: NormalizedAgentRow[];
  consultants: NormalizedAgentRow[];
}

interface NavigationTeamGroup {
  key: string;
  label: string;
  leaders: NormalizedAgentRow[];
  workers: NormalizedAgentRow[];
}

interface NavigationProjectGroup {
  projectId: string;
  projectName: string;
  color: string | null;
  leaders: NormalizedAgentRow[];
  teams: Map<string, NavigationTeamGroup>;
  workers: NormalizedAgentRow[];
}

interface NavigationClusterGroup {
  clusterId: string;
  name: string;
  slug: string;
  summary: string | null;
  executiveSponsor: NormalizedAgentRow | null;
  portfolioDirector: NormalizedAgentRow | null;
  projects: Map<string, NavigationProjectGroup>;
}

interface NavigationDepartmentGroup {
  key: AgentDepartmentKey | "shared_service";
  name: string;
  leaders: NormalizedAgentRow[];
  clusters: Map<string, NavigationClusterGroup>;
  projects: Map<string, NavigationProjectGroup>;
}

interface OperatingClusterGroup {
  clusterId: string;
  name: string;
  slug: string;
  summary: string | null;
  executiveSponsor: NormalizedAgentRow | null;
  portfolioDirector: NormalizedAgentRow | null;
  projects: Map<string, ProjectPodGroup>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function buildConfigSnapshot(
  row: Pick<typeof agents.$inferSelect, ConfigRevisionField>,
): AgentConfigSnapshot {
  const adapterConfig =
    typeof row.adapterConfig === "object" && row.adapterConfig !== null && !Array.isArray(row.adapterConfig)
      ? sanitizeRecord(row.adapterConfig as Record<string, unknown>)
      : {};
  const runtimeConfig =
    typeof row.runtimeConfig === "object" && row.runtimeConfig !== null && !Array.isArray(row.runtimeConfig)
      ? sanitizeRecord(row.runtimeConfig as Record<string, unknown>)
      : {};
  const metadata =
    typeof row.metadata === "object" && row.metadata !== null && !Array.isArray(row.metadata)
      ? sanitizeRecord(row.metadata as Record<string, unknown>)
      : row.metadata ?? null;
  return {
    templateId: row.templateId,
    templateRevisionId: row.templateRevisionId,
    name: row.name,
    role: row.role,
    title: row.title,
    icon: row.icon,
    reportsTo: row.reportsTo,
    orgLevel: row.orgLevel,
    operatingClass: row.operatingClass,
    capabilityProfileKey: row.capabilityProfileKey,
    archetypeKey: row.archetypeKey,
    departmentKey: row.departmentKey,
    departmentName: row.departmentName,
    capabilities: row.capabilities,
    adapterType: row.adapterType,
    adapterConfig,
    runtimeConfig,
    budgetMonthlyCents: row.budgetMonthlyCents,
    requestedByPrincipalType: row.requestedByPrincipalType,
    requestedByPrincipalId: row.requestedByPrincipalId,
    requestedForProjectId: row.requestedForProjectId,
    requestedReason: row.requestedReason,
    metadata,
  };
}

async function getTemplateMode(
  executor: DbExecutor,
  templateId: string,
): Promise<"agent_snapshot" | "reusable"> {
  const template = await executor
    .select({ metadata: agentTemplates.metadata })
    .from(agentTemplates)
    .where(eq(agentTemplates.id, templateId))
    .then((rows) => rows[0] ?? null);
  return readAgentTemplateMode(template?.metadata ?? null);
}

function containsRedactedMarker(value: unknown): boolean {
  if (value === REDACTED_EVENT_VALUE) return true;
  if (Array.isArray(value)) return value.some((item) => containsRedactedMarker(item));
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value as Record<string, unknown>).some((entry) => containsRedactedMarker(entry));
}

function hasConfigPatchFields(data: Partial<typeof agents.$inferInsert>) {
  return CONFIG_REVISION_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(data, field));
}

function diffConfigSnapshot(
  before: AgentConfigSnapshot,
  after: AgentConfigSnapshot,
): string[] {
  return CONFIG_REVISION_FIELDS.filter((field) => !jsonEqual(before[field], after[field]));
}

function configPatchFromSnapshot(snapshot: unknown): Partial<typeof agents.$inferInsert> {
  if (!isPlainRecord(snapshot)) throw unprocessable("Invalid revision snapshot");

  if (typeof snapshot.name !== "string" || snapshot.name.length === 0) {
    throw unprocessable("Invalid revision snapshot: name");
  }
  if (typeof snapshot.role !== "string" || snapshot.role.length === 0) {
    throw unprocessable("Invalid revision snapshot: role");
  }
  if (snapshot.adapterType !== null && (typeof snapshot.adapterType !== "string" || snapshot.adapterType.length === 0)) {
    throw unprocessable("Invalid revision snapshot: adapterType");
  }
  if (typeof snapshot.budgetMonthlyCents !== "number" || !Number.isFinite(snapshot.budgetMonthlyCents)) {
    throw unprocessable("Invalid revision snapshot: budgetMonthlyCents");
  }

  return {
    templateId: typeof snapshot.templateId === "string" || snapshot.templateId === null ? snapshot.templateId : null,
    templateRevisionId:
      typeof snapshot.templateRevisionId === "string" || snapshot.templateRevisionId === null
        ? snapshot.templateRevisionId
        : null,
    name: snapshot.name,
    role: normalizeAgentRole(snapshot.role),
    title: typeof snapshot.title === "string" || snapshot.title === null ? snapshot.title : null,
    icon: typeof snapshot.icon === "string" || snapshot.icon === null ? snapshot.icon : null,
    reportsTo:
      typeof snapshot.reportsTo === "string" || snapshot.reportsTo === null ? snapshot.reportsTo : null,
    orgLevel:
      snapshot.orgLevel === "executive" || snapshot.orgLevel === "director" || snapshot.orgLevel === "staff"
        ? snapshot.orgLevel
        : undefined,
    operatingClass:
      snapshot.operatingClass === "executive" ||
      snapshot.operatingClass === "project_leadership" ||
      snapshot.operatingClass === "worker" ||
      snapshot.operatingClass === "shared_service_lead" ||
      snapshot.operatingClass === "consultant"
        ? snapshot.operatingClass
        : undefined,
    capabilityProfileKey:
      typeof snapshot.capabilityProfileKey === "string" && snapshot.capabilityProfileKey.trim().length > 0
        ? snapshot.capabilityProfileKey
        : undefined,
    archetypeKey:
      typeof snapshot.archetypeKey === "string" && snapshot.archetypeKey.trim().length > 0
        ? snapshot.archetypeKey.trim()
        : undefined,
    departmentKey:
      snapshot.departmentKey === "executive" ||
      snapshot.departmentKey === "engineering" ||
      snapshot.departmentKey === "product" ||
      snapshot.departmentKey === "design" ||
      snapshot.departmentKey === "marketing" ||
      snapshot.departmentKey === "finance" ||
      snapshot.departmentKey === "operations" ||
      snapshot.departmentKey === "research" ||
      snapshot.departmentKey === "general" ||
      snapshot.departmentKey === "custom"
        ? snapshot.departmentKey
        : undefined,
    departmentName:
      typeof snapshot.departmentName === "string" || snapshot.departmentName === null
        ? snapshot.departmentName
        : null,
    capabilities:
      typeof snapshot.capabilities === "string" || snapshot.capabilities === null
        ? snapshot.capabilities
        : null,
    adapterType: typeof snapshot.adapterType === "string" ? snapshot.adapterType : undefined,
    adapterConfig: isPlainRecord(snapshot.adapterConfig) ? snapshot.adapterConfig : {},
    runtimeConfig: isPlainRecord(snapshot.runtimeConfig) ? snapshot.runtimeConfig : {},
    budgetMonthlyCents: Math.max(0, Math.floor(snapshot.budgetMonthlyCents)),
    requestedByPrincipalType:
      snapshot.requestedByPrincipalType === "human_operator" ||
      snapshot.requestedByPrincipalType === "agent_instance" ||
      snapshot.requestedByPrincipalType === "system_process"
        ? snapshot.requestedByPrincipalType
        : undefined,
    requestedByPrincipalId:
      typeof snapshot.requestedByPrincipalId === "string" || snapshot.requestedByPrincipalId === null
        ? snapshot.requestedByPrincipalId
        : null,
    requestedForProjectId:
      typeof snapshot.requestedForProjectId === "string" || snapshot.requestedForProjectId === null
        ? snapshot.requestedForProjectId
        : null,
    requestedReason:
      typeof snapshot.requestedReason === "string" || snapshot.requestedReason === null
        ? snapshot.requestedReason
        : null,
    metadata: isPlainRecord(snapshot.metadata) || snapshot.metadata === null ? snapshot.metadata : null,
  };
}

export function hasAgentShortnameCollision(
  candidateName: string,
  existingAgents: AgentShortnameRow[],
  options?: AgentShortnameCollisionOptions,
): boolean {
  const candidateShortname = normalizeAgentUrlKey(candidateName);
  if (!candidateShortname) return false;

  return existingAgents.some((agent) => {
    if (agent.status === "terminated") return false;
    if (options?.excludeAgentId && agent.id === options.excludeAgentId) return false;
    return normalizeAgentUrlKey(agent.name) === candidateShortname;
  });
}

export function deduplicateAgentName(
  candidateName: string,
  existingAgents: AgentShortnameRow[],
): string {
  if (!hasAgentShortnameCollision(candidateName, existingAgents)) {
    return candidateName;
  }
  for (let i = 2; i <= 100; i++) {
    const suffixed = `${candidateName} ${i}`;
    if (!hasAgentShortnameCollision(suffixed, existingAgents)) {
      return suffixed;
    }
  }
  return `${candidateName} ${Date.now()}`;
}

function defaultOrgLevelForRole(role: string): AgentOrgLevel {
  return EXECUTIVE_ROLES.has(role) ? "executive" : "staff";
}

function defaultArchetypeKeyForRole(role: string): string {
  switch (role) {
    case "ceo":
      return "chief_executive";
    case "cto":
      return "chief_technology_officer";
    case "cfo":
      return "chief_finance_officer";
    case "cmo":
      return "chief_marketing_officer";
    case "coo":
      return "chief_of_staff";
    case "pm":
      return "product_manager";
    case "qa":
      return "qa_engineer";
    case "devops":
      return "devops_engineer";
    case "designer":
      return "designer";
    case "researcher":
      return "researcher";
    case "engineer":
      return "engineer";
    default:
      return "general";
  }
}

function normalizeAgentRole(role: unknown): AgentRole {
  return AGENT_ROLES.includes(role as AgentRole) ? (role as AgentRole) : "general";
}

function defaultDepartmentKeyForRole(role: string): AgentDepartmentKey {
  return ROLE_DEPARTMENT_DEFAULTS[role] ?? "general";
}

function normalizeDepartmentName(
  departmentKey: AgentDepartmentKey,
  departmentName: string | null | undefined,
) {
  if (departmentKey !== "custom") return null;
  if (typeof departmentName !== "string") return null;
  const trimmed = departmentName.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function departmentDisplayName(departmentKey: AgentDepartmentKey, departmentName: string | null) {
  if (departmentKey === "custom") return departmentName ?? AGENT_DEPARTMENT_LABELS.custom;
  return AGENT_DEPARTMENT_LABELS[departmentKey];
}

function executiveSortKey(role: string, name: string) {
  const roleIndex = EXECUTIVE_SORT_ORDER.indexOf(role as (typeof EXECUTIVE_SORT_ORDER)[number]);
  return `${roleIndex === -1 ? 99 : roleIndex}:${name.toLowerCase()}`;
}

function departmentSortKey(key: AgentDepartmentKey, name: string) {
  const index = DEPARTMENT_SORT_ORDER.indexOf(key);
  return `${index === -1 ? 99 : index}:${name.toLowerCase()}`;
}

function sortAgentsByName<T extends { name: string }>(items: T[]) {
  return [...items].sort((left, right) => left.name.localeCompare(right.name));
}

function sortOperatingAgents<T extends { name: string; role: string; operatingClass: AgentOperatingClass }>(
  items: T[],
) {
  return [...items].sort((left, right) => {
    if (left.operatingClass === "executive" && right.operatingClass === "executive") {
      return executiveSortKey(left.role, left.name).localeCompare(executiveSortKey(right.role, right.name));
    }
    return left.name.localeCompare(right.name);
  });
}

function dedupeById<T extends { id: string }>(items: T[]) {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    unique.push(item);
  }
  return unique;
}

export function agentService(db: Db) {
  function currentUtcMonthWindow(now = new Date()) {
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth();
    return {
      start: new Date(Date.UTC(year, month, 1, 0, 0, 0, 0)),
      end: new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0)),
    };
  }

  function withUrlKey<T extends { id: string; name: string }>(row: T) {
    return {
      ...row,
      urlKey: normalizeAgentUrlKey(row.name) ?? row.id,
    };
  }

  function normalizeAgentRow(row: typeof agents.$inferSelect): NormalizedAgentRow {
    const orgLevel = row.orgLevel ?? defaultOrgLevelForRole(row.role);
    const operatingClass = row.operatingClass ?? defaultOperatingClassForLegacyAgent(row.role, orgLevel);
    const capabilityProfileKey =
      row.capabilityProfileKey ?? defaultCapabilityProfileKeyForAgent({ role: row.role, operatingClass, orgLevel });
    const departmentKey = row.departmentKey ?? defaultDepartmentKeyForRole(row.role);
    return withUrlKey({
      ...row,
      role: normalizeAgentRole(row.role),
      orgLevel,
      operatingClass,
      capabilityProfileKey,
      archetypeKey: row.archetypeKey?.trim() || defaultArchetypeKeyForRole(row.role),
      departmentKey,
      departmentName: normalizeDepartmentName(departmentKey, row.departmentName),
      permissions: normalizeAgentPermissions(row.permissions, row.role, {
        capabilityProfileKey,
        operatingClass,
        orgLevel,
      }),
    });
  }

  function resolveHierarchyState(
    data: Partial<typeof agents.$inferInsert>,
    existing?: Partial<typeof agents.$inferSelect> | null,
  ): AgentHierarchyState {
    const role = (data.role ?? existing?.role ?? "general") as string;
    const reportsTo =
      data.reportsTo !== undefined
        ? data.reportsTo ?? null
        : existing?.reportsTo ?? null;
    const orgLevel = (data.orgLevel ?? existing?.orgLevel ?? defaultOrgLevelForRole(role)) as AgentOrgLevel;
    const operatingClass = (
      data.operatingClass
      ?? existing?.operatingClass
      ?? defaultOperatingClassForLegacyAgent(role, orgLevel)
    ) as AgentOperatingClass;
    const capabilityProfileKey = (
      data.capabilityProfileKey
      ?? existing?.capabilityProfileKey
      ?? defaultCapabilityProfileKeyForAgent({ role, operatingClass, orgLevel })
    ) as string;
    const archetypeKey = (
      typeof data.archetypeKey === "string" && data.archetypeKey.trim()
        ? data.archetypeKey.trim()
        : typeof existing?.archetypeKey === "string" && existing.archetypeKey.trim()
          ? existing.archetypeKey.trim()
          : defaultArchetypeKeyForRole(role)
    );
    const departmentKey = (data.departmentKey ?? existing?.departmentKey ?? defaultDepartmentKeyForRole(role)) as AgentDepartmentKey;
    const departmentName = normalizeDepartmentName(
      departmentKey,
      data.departmentName !== undefined ? data.departmentName : existing?.departmentName ?? null,
    );

    if (departmentKey === "custom" && !departmentName) {
      throw unprocessable("Custom departments require a department name");
    }

    return {
      role,
      reportsTo,
      orgLevel,
      operatingClass,
      capabilityProfileKey,
      archetypeKey,
      departmentKey,
      departmentName,
    };
  }

  async function assertHierarchyRules(
    companyId: string,
    state: AgentHierarchyState,
    selfId?: string,
  ) {
    if (!state.reportsTo) {
      if (state.orgLevel === "director") {
        throw unprocessable("Directors must report to an executive");
      }
      return;
    }

    const manager = await ensureManager(companyId, state.reportsTo);
    if (selfId) {
      await assertNoCycle(selfId, state.reportsTo);
    }

    if (state.orgLevel === "executive") {
      if (manager.orgLevel !== "executive") {
        throw unprocessable("Executives may only report to another executive");
      }
      return;
    }

    if (state.orgLevel === "director") {
      if (manager.orgLevel !== "executive" && manager.orgLevel !== "director") {
        throw unprocessable("Directors must report to an executive or another director");
      }
      return;
    }

    if (state.orgLevel === "staff" && manager.orgLevel !== "executive" && manager.orgLevel !== "director") {
      throw unprocessable("Staff must report to a director or executive");
    }
  }

  async function getMonthlySpendByAgentIds(companyId: string, agentIds: string[]) {
    if (agentIds.length === 0) return new Map<string, number>();
    const { start, end } = currentUtcMonthWindow();
    const rows = await db
      .select({
        agentId: costEvents.agentId,
        spentMonthlyCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
      })
      .from(costEvents)
      .where(
        and(
          eq(costEvents.companyId, companyId),
          inArray(costEvents.agentId, agentIds),
          gte(costEvents.occurredAt, start),
          lt(costEvents.occurredAt, end),
        ),
      )
      .groupBy(costEvents.agentId);
    return new Map(rows.map((row) => [row.agentId, Number(row.spentMonthlyCents ?? 0)]));
  }

  async function hydrateAgentSpend<T extends { id: string; companyId: string; spentMonthlyCents: number }>(rows: T[]) {
    const agentIds = rows.map((row) => row.id);
    const companyId = rows[0]?.companyId;
    if (!companyId || agentIds.length === 0) return rows;
    const spendByAgentId = await getMonthlySpendByAgentIds(companyId, agentIds);
    return rows.map((row) => ({
      ...row,
      spentMonthlyCents: spendByAgentId.get(row.id) ?? 0,
    }));
  }

  async function getById(id: string) {
    const row = await db
      .select()
      .from(agents)
      .where(eq(agents.id, id))
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
    const [hydrated] = await hydrateAgentSpend([row]);
    return normalizeAgentRow(hydrated);
  }

  async function ensureManager(companyId: string, managerId: string) {
    const manager = await getById(managerId);
    if (!manager) throw notFound("Manager not found");
    if (manager.companyId !== companyId) {
      throw unprocessable("Manager must belong to same company");
    }
    return manager;
  }

  function buildTemplateSnapshot(row: Pick<typeof agents.$inferSelect, ConfigRevisionField>) {
    return {
      ...buildConfigSnapshot(row),
      instructionsBody: "",
    } as unknown as Record<string, unknown>;
  }

  async function ensureTemplateRevisionLink(
    executor: DbExecutor,
    agentRow: NormalizedAgentRow,
    options?: RevisionMetadata,
  ) {
    let templateId = agentRow.templateId ?? null;
    let templateMode: "agent_snapshot" | "reusable" = "agent_snapshot";
    if (templateId) {
      templateMode = await getTemplateMode(executor, templateId);
    }

    if (templateId && templateMode === "reusable") {
      let revisionId = agentRow.templateRevisionId ?? null;
      if (!revisionId) {
        const latestRevision = await executor
          .select({ id: agentTemplateRevisions.id })
          .from(agentTemplateRevisions)
          .where(eq(agentTemplateRevisions.templateId, templateId))
          .orderBy(desc(agentTemplateRevisions.revisionNumber))
          .then((rows) => rows[0] ?? null);
        if (!latestRevision) {
          throw unprocessable("Reusable template is missing a revision");
        }
        revisionId = latestRevision.id;
      }

      if (templateId !== agentRow.templateId || revisionId !== agentRow.templateRevisionId) {
        await executor
          .update(agents)
          .set({
            templateId,
            templateRevisionId: revisionId,
            updatedAt: new Date(),
          })
          .where(eq(agents.id, agentRow.id));
      }
      return { templateId, templateRevisionId: revisionId };
    }

    if (!templateId) {
      const createdTemplate = await executor
        .insert(agentTemplates)
        .values({
          companyId: agentRow.companyId,
          name: agentRow.name,
          role: agentRow.role,
          operatingClass: agentRow.operatingClass,
          capabilityProfileKey: agentRow.capabilityProfileKey,
          archetypeKey: agentRow.archetypeKey,
          metadata: withAgentTemplateMode(agentRow.metadata ?? null, "agent_snapshot"),
          updatedAt: new Date(),
        })
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!createdTemplate) {
        throw unprocessable("Unable to create agent template");
      }
      templateId = createdTemplate.id;
    } else {
      await executor
        .update(agentTemplates)
        .set({
          name: agentRow.name,
          role: agentRow.role,
          operatingClass: agentRow.operatingClass,
          capabilityProfileKey: agentRow.capabilityProfileKey,
          archetypeKey: agentRow.archetypeKey,
          metadata: withAgentTemplateMode(agentRow.metadata ?? null, "agent_snapshot"),
          updatedAt: new Date(),
        })
        .where(eq(agentTemplates.id, templateId));
    }

    const snapshot = buildTemplateSnapshot(agentRow);
    const currentRevision = agentRow.templateRevisionId
      ? await executor
          .select()
          .from(agentTemplateRevisions)
          .where(eq(agentTemplateRevisions.id, agentRow.templateRevisionId))
          .then((rows) => rows[0] ?? null)
      : null;

    let revisionId = agentRow.templateRevisionId ?? null;
    if (!currentRevision || !jsonEqual(currentRevision.snapshot, snapshot)) {
      const latestRevision = await executor
        .select({ revisionNumber: agentTemplateRevisions.revisionNumber })
        .from(agentTemplateRevisions)
        .where(eq(agentTemplateRevisions.templateId, templateId))
        .orderBy(desc(agentTemplateRevisions.revisionNumber))
        .then((rows) => rows[0] ?? null);

      const createdRevision = await executor
        .insert(agentTemplateRevisions)
        .values({
          companyId: agentRow.companyId,
          templateId,
          revisionNumber: (latestRevision?.revisionNumber ?? 0) + 1,
          snapshot,
          createdByAgentId: options?.createdByAgentId ?? null,
          createdByUserId: options?.createdByUserId ?? null,
        })
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!createdRevision) {
        throw unprocessable("Unable to create agent template revision");
      }
      revisionId = createdRevision.id;
    }

    if (templateId !== agentRow.templateId || revisionId !== agentRow.templateRevisionId) {
      await executor
        .update(agents)
        .set({
          templateId,
          templateRevisionId: revisionId,
          updatedAt: new Date(),
        })
        .where(eq(agents.id, agentRow.id));
    }

    return { templateId, templateRevisionId: revisionId };
  }

  async function assertNoCycle(agentId: string, reportsTo: string | null | undefined) {
    if (!reportsTo) return;
    if (reportsTo === agentId) throw unprocessable("Agent cannot report to itself");

    let cursor: string | null = reportsTo;
    while (cursor) {
      if (cursor === agentId) throw unprocessable("Reporting relationship would create cycle");
      const next = await getById(cursor);
      cursor = next?.reportsTo ?? null;
    }
  }

  async function assertCompanyShortnameAvailable(
    companyId: string,
    candidateName: string,
    options?: AgentShortnameCollisionOptions,
  ) {
    const candidateShortname = normalizeAgentUrlKey(candidateName);
    if (!candidateShortname) return;

    const existingAgents = await db
      .select({
        id: agents.id,
        name: agents.name,
        status: agents.status,
      })
      .from(agents)
      .where(eq(agents.companyId, companyId));

    const hasCollision = hasAgentShortnameCollision(candidateName, existingAgents, options);
    if (hasCollision) {
      throw conflict(
        `Agent shortname '${candidateShortname}' is already in use in this company`,
      );
    }
  }

  async function listActiveScopesForCompany(companyId: string): Promise<ActiveScopeRow[]> {
    const now = new Date();
    const rows = await db
      .select({
        scope: agentProjectScopes,
        projectId: projects.id,
        portfolioClusterId: projects.portfolioClusterId,
        projectName: projects.name,
        projectColor: projects.color,
      })
      .from(agentProjectScopes)
      .innerJoin(
        projects,
        and(
          eq(agentProjectScopes.projectId, projects.id),
          eq(agentProjectScopes.companyId, projects.companyId),
        ),
      )
      .where(
        and(
          eq(agentProjectScopes.companyId, companyId),
          or(isNull(agentProjectScopes.activeTo), gt(agentProjectScopes.activeTo, now)),
        ),
      );

    return rows.map((row) => ({
      scope: row.scope,
      projectId: row.projectId,
      portfolioClusterId: row.portfolioClusterId ?? null,
      projectName: row.projectName,
      projectColor: row.projectColor,
    }));
  }

  function toOperatingSummary(row: NormalizedAgentRow) {
    return {
      id: row.id,
      name: row.name,
      urlKey: row.urlKey,
      role: row.role,
      title: row.title ?? null,
      icon: row.icon ?? null,
      status: row.status,
      reportsTo: row.reportsTo ?? null,
      orgLevel: row.orgLevel,
      operatingClass: row.operatingClass,
      capabilityProfileKey: row.capabilityProfileKey,
      archetypeKey: row.archetypeKey,
      departmentKey: row.departmentKey,
      departmentName: row.departmentName ?? null,
    };
  }

  function buildProjectPodGroups(
    scopeRows: ActiveScopeRow[],
    agentsById: Map<string, NormalizedAgentRow>,
  ): Map<string, ProjectPodGroup> {
    const groups = new Map<string, ProjectPodGroup>();

    for (const scopeRow of scopeRows) {
      const agent = agentsById.get(scopeRow.scope.agentId);
      if (!agent) continue;

      const group = groups.get(scopeRow.projectId) ?? {
        projectId: scopeRow.projectId,
        projectName: scopeRow.projectName,
        color: scopeRow.projectColor,
        leadership: [],
        workers: [],
        consultants: [],
      };

      if (scopeRow.scope.scopeMode === "execution") {
        group.workers.push(agent);
      } else if (scopeRow.scope.scopeMode === "consulting") {
        group.consultants.push(agent);
      } else {
        group.leadership.push(agent);
      }

      groups.set(scopeRow.projectId, group);
    }

    return groups;
  }

  function serializeNavigationProject(group: NavigationProjectGroup) {
    return {
      projectId: group.projectId,
      projectName: group.projectName,
      color: group.color,
      leaders: sortOperatingAgents(dedupeById(group.leaders)).map(toOperatingSummary),
      teams: Array.from(group.teams.values())
        .sort((left, right) => left.label.localeCompare(right.label))
        .map((team) => ({
          key: team.key,
          label: team.label,
          leaders: sortOperatingAgents(dedupeById(team.leaders)).map(toOperatingSummary),
          workers: sortOperatingAgents(dedupeById(team.workers)).map(toOperatingSummary),
        })),
      workers: sortOperatingAgents(dedupeById(group.workers)).map(toOperatingSummary),
    };
  }

  function serializeProjectPodNavigation(group: ProjectPodGroup) {
    return {
      projectId: group.projectId,
      projectName: group.projectName,
      color: group.color,
      leaders: sortOperatingAgents(dedupeById(group.leadership)).map(toOperatingSummary),
      teams: [],
      workers: sortOperatingAgents(dedupeById([...group.workers, ...group.consultants])).map(toOperatingSummary),
    };
  }

  function serializeNavigationCluster(group: NavigationClusterGroup) {
    return {
      clusterId: group.clusterId,
      name: group.name,
      slug: group.slug,
      summary: group.summary,
      executiveSponsor: group.executiveSponsor ? toOperatingSummary(group.executiveSponsor) : null,
      portfolioDirector: group.portfolioDirector ? toOperatingSummary(group.portfolioDirector) : null,
      projects: Array.from(group.projects.values())
        .sort((left, right) => left.projectName.localeCompare(right.projectName))
        .map(serializeNavigationProject),
    };
  }

  function scopeFunctionMeta(scopeRow: ActiveScopeRow, agent: NormalizedAgentRow) {
    const explicitKey = scopeRow.scope.teamFunctionKey?.trim() || null;
    const explicitLabel = scopeRow.scope.teamFunctionLabel?.trim() || null;
    if (explicitKey || explicitLabel) {
      return {
        key: explicitKey ?? normalizeAgentUrlKey(explicitLabel ?? "function") ?? "function",
        label: explicitLabel ?? explicitKey ?? "Function",
      };
    }

    if (scopeRow.scope.projectRole === "director") return null;

    return {
      key:
        agent.departmentKey === "custom"
          ? normalizeAgentUrlKey(agent.departmentName ?? "custom") ?? "custom"
          : agent.departmentKey,
      label: departmentDisplayName(agent.departmentKey, agent.departmentName),
    };
  }

  function getOrCreateProjectGroup(
    projectMap: Map<string, NavigationProjectGroup>,
    scopeRow: ActiveScopeRow,
  ) {
    const existing = projectMap.get(scopeRow.projectId);
    if (existing) return existing;
    const created: NavigationProjectGroup = {
      projectId: scopeRow.projectId,
      projectName: scopeRow.projectName,
      color: scopeRow.projectColor,
      leaders: [],
      teams: new Map<string, NavigationTeamGroup>(),
      workers: [],
    };
    projectMap.set(scopeRow.projectId, created);
    return created;
  }

  function addScopeToProjectNavigation(
    scopeRow: ActiveScopeRow,
    agent: NormalizedAgentRow,
    projectGroup: NavigationProjectGroup,
  ) {
    const functionMeta = scopeFunctionMeta(scopeRow, agent);

    if (scopeRow.scope.scopeMode === "execution" || scopeRow.scope.scopeMode === "consulting") {
      if (functionMeta) {
        const team = projectGroup.teams.get(functionMeta.key) ?? {
          key: functionMeta.key,
          label: functionMeta.label,
          leaders: [],
          workers: [],
        };
        team.workers.push(agent);
        projectGroup.teams.set(functionMeta.key, team);
      } else {
        projectGroup.workers.push(agent);
      }
      return;
    }

    if (scopeRow.scope.projectRole === "director" || !functionMeta) {
      projectGroup.leaders.push(agent);
      return;
    }

    const team = projectGroup.teams.get(functionMeta.key) ?? {
      key: functionMeta.key,
      label: functionMeta.label,
      leaders: [],
      workers: [],
    };
    team.leaders.push(agent);
    projectGroup.teams.set(functionMeta.key, team);
  }

  function buildOperatingClusterGroups(
    clusterRows: Array<typeof portfolioClusters.$inferSelect>,
    scopeRows: ActiveScopeRow[],
    agentsById: Map<string, NormalizedAgentRow>,
    projectPods: Map<string, ProjectPodGroup>,
  ) {
    const projectClusterIds = new Map<string, string>();
    for (const scopeRow of scopeRows) {
      if (scopeRow.portfolioClusterId) {
        projectClusterIds.set(scopeRow.projectId, scopeRow.portfolioClusterId);
      }
    }

    const clusterGroups = new Map<string, OperatingClusterGroup>();
    for (const clusterRow of clusterRows) {
      clusterGroups.set(clusterRow.id, {
        clusterId: clusterRow.id,
        name: clusterRow.name,
        slug: clusterRow.slug,
        summary: clusterRow.summary ?? null,
        executiveSponsor: clusterRow.executiveSponsorAgentId
          ? (agentsById.get(clusterRow.executiveSponsorAgentId) ?? null)
          : null,
        portfolioDirector: clusterRow.portfolioDirectorAgentId
          ? (agentsById.get(clusterRow.portfolioDirectorAgentId) ?? null)
          : null,
        projects: new Map<string, ProjectPodGroup>(),
      });
    }

    for (const group of projectPods.values()) {
      const clusterId = projectClusterIds.get(group.projectId);
      if (!clusterId) continue;
      const clusterGroup = clusterGroups.get(clusterId);
      if (!clusterGroup) continue;
      clusterGroup.projects.set(group.projectId, group);
    }

    return Array.from(clusterGroups.values())
      .filter((group) => group.projects.size > 0 || group.portfolioDirector || group.executiveSponsor)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  function buildNavigationByDepartment(
    clusterRows: Array<typeof portfolioClusters.$inferSelect>,
    scopeRows: ActiveScopeRow[],
    agentsById: Map<string, NormalizedAgentRow>,
  ) {
    const departments = new Map<string, NavigationDepartmentGroup>();
    const sharedServices = new Map<string, NavigationDepartmentGroup>();
    const clusterById = new Map(clusterRows.map((cluster) => [cluster.id, cluster] as const));

    for (const agent of agentsById.values()) {
      if (agent.operatingClass !== "shared_service_lead") continue;
      const departmentName = departmentDisplayName(agent.departmentKey, agent.departmentName);
      const key = `${agent.departmentKey}:${departmentName.toLowerCase()}`;
      const group = sharedServices.get(key) ?? {
        key: agent.departmentKey,
        name: departmentName,
        leaders: [],
        clusters: new Map<string, NavigationClusterGroup>(),
        projects: new Map<string, NavigationProjectGroup>(),
      };
      group.leaders.push(agent);
      sharedServices.set(key, group);
    }

    for (const scopeRow of scopeRows) {
      const agent = agentsById.get(scopeRow.scope.agentId);
      if (!agent || agent.operatingClass === "executive") continue;

      const departmentName = departmentDisplayName(agent.departmentKey, agent.departmentName);
      const departmentKeyValue = `${agent.departmentKey}:${departmentName.toLowerCase()}`;
      const targetMap = agent.operatingClass === "shared_service_lead" ? sharedServices : departments;
      const group = targetMap.get(departmentKeyValue) ?? {
        key: agent.departmentKey,
        name: departmentName,
        leaders: [],
        clusters: new Map<string, NavigationClusterGroup>(),
        projects: new Map<string, NavigationProjectGroup>(),
      };

      const functionMeta = scopeFunctionMeta(scopeRow, agent);
      if (scopeRow.scope.scopeMode !== "execution" && scopeRow.scope.scopeMode !== "consulting" && functionMeta) {
        group.leaders.push(agent);
      }

      const clusterRow = scopeRow.portfolioClusterId ? clusterById.get(scopeRow.portfolioClusterId) ?? null : null;
      const clusterGroup = clusterRow
        ? group.clusters.get(clusterRow.id) ?? {
          clusterId: clusterRow.id,
          name: clusterRow.name,
          slug: clusterRow.slug,
          summary: clusterRow.summary ?? null,
          executiveSponsor: clusterRow.executiveSponsorAgentId
            ? (agentsById.get(clusterRow.executiveSponsorAgentId) ?? null)
            : null,
          portfolioDirector: clusterRow.portfolioDirectorAgentId
            ? (agentsById.get(clusterRow.portfolioDirectorAgentId) ?? null)
            : null,
          projects: new Map<string, NavigationProjectGroup>(),
        }
        : null;

      const departmentProject = getOrCreateProjectGroup(group.projects, scopeRow);
      addScopeToProjectNavigation(scopeRow, agent, departmentProject);
      if (clusterGroup) {
        const clusterProject = getOrCreateProjectGroup(clusterGroup.projects, scopeRow);
        addScopeToProjectNavigation(scopeRow, agent, clusterProject);
        group.clusters.set(clusterRow!.id, clusterGroup);
      }
      targetMap.set(departmentKeyValue, group);
    }

    return {
      departments: Array.from(departments.values())
        .sort((left, right) => departmentSortKey(left.key === "shared_service" ? "general" : left.key, left.name).localeCompare(
          departmentSortKey(right.key === "shared_service" ? "general" : right.key, right.name),
        ))
        .map((group) => ({
          key: group.key,
          name: group.name,
          leaders: sortOperatingAgents(dedupeById(group.leaders)).map(toOperatingSummary),
          clusters: Array.from(group.clusters.values())
            .sort((left, right) => left.name.localeCompare(right.name))
            .map(serializeNavigationCluster),
          projects: Array.from(group.projects.values())
            .sort((left, right) => left.projectName.localeCompare(right.projectName))
            .map(serializeNavigationProject),
        })),
      sharedServices: Array.from(sharedServices.values())
        .sort((left, right) => departmentSortKey(left.key === "shared_service" ? "general" : left.key, left.name).localeCompare(
          departmentSortKey(right.key === "shared_service" ? "general" : right.key, right.name),
        ))
        .map((group) => ({
          key: group.key,
          name: group.name,
          leaders: sortOperatingAgents(dedupeById(group.leaders)).map(toOperatingSummary),
          clusters: Array.from(group.clusters.values())
            .sort((left, right) => left.name.localeCompare(right.name))
            .map(serializeNavigationCluster),
          projects: Array.from(group.projects.values())
            .sort((left, right) => left.projectName.localeCompare(right.projectName))
            .map(serializeNavigationProject),
        })),
    };
  }

  async function updateAgent(
    id: string,
    data: Partial<typeof agents.$inferInsert>,
    options?: UpdateAgentOptions,
  ) {
    const existing = await getById(id);
    if (!existing) return null;

    if (existing.status === "terminated" && data.status && data.status !== "terminated") {
      throw conflict("Terminated agents cannot be resumed");
    }
    if (
      existing.status === "pending_approval" &&
      data.status &&
      data.status !== "pending_approval" &&
      data.status !== "terminated"
    ) {
      throw conflict("Pending approval agents cannot be activated directly");
    }

    const hierarchyState = resolveHierarchyState(data, existing);
    await assertHierarchyRules(existing.companyId, hierarchyState, id);

    if (data.name !== undefined) {
      const previousShortname = normalizeAgentUrlKey(existing.name);
      const nextShortname = normalizeAgentUrlKey(data.name);
      if (previousShortname !== nextShortname) {
        await assertCompanyShortnameAvailable(existing.companyId, data.name, { excludeAgentId: id });
      }
    }

    const normalizedPatch = {
      ...data,
      orgLevel: hierarchyState.orgLevel,
      operatingClass: hierarchyState.operatingClass,
      capabilityProfileKey: hierarchyState.capabilityProfileKey,
      archetypeKey: hierarchyState.archetypeKey,
      departmentKey: hierarchyState.departmentKey,
      departmentName: hierarchyState.departmentName,
    } as Partial<typeof agents.$inferInsert>;
    if (data.permissions !== undefined) {
      const role = (data.role ?? existing.role) as string;
      normalizedPatch.permissions = normalizeAgentPermissions(data.permissions, role, {
        capabilityProfileKey: hierarchyState.capabilityProfileKey,
        operatingClass: hierarchyState.operatingClass,
        orgLevel: hierarchyState.orgLevel,
      });
    }

    const shouldRecordRevision = Boolean(options?.recordRevision) && hasConfigPatchFields(normalizedPatch);
    const beforeConfig = shouldRecordRevision ? buildConfigSnapshot(existing) : null;

    const normalizedUpdated = await db.transaction(async (tx) => {
      const updated = await tx
        .update(agents)
        .set({ ...normalizedPatch, updatedAt: new Date() })
        .where(eq(agents.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      const normalized = updated ? normalizeAgentRow(updated) : null;
      if (!normalized) return null;

      const templateLinked = await ensureTemplateRevisionLink(tx, normalized, options?.recordRevision);
      return normalizeAgentRow({
        ...updated,
        templateId: templateLinked.templateId,
        templateRevisionId: templateLinked.templateRevisionId,
      });
    });

    if (normalizedUpdated && shouldRecordRevision && beforeConfig) {
      const afterConfig = buildConfigSnapshot(normalizedUpdated);
      const changedKeys = diffConfigSnapshot(beforeConfig, afterConfig);
      if (changedKeys.length > 0) {
        await db.insert(agentConfigRevisions).values({
          companyId: normalizedUpdated.companyId,
          agentId: normalizedUpdated.id,
          createdByAgentId: options?.recordRevision?.createdByAgentId ?? null,
          createdByUserId: options?.recordRevision?.createdByUserId ?? null,
          source: options?.recordRevision?.source ?? "patch",
          rolledBackFromRevisionId: options?.recordRevision?.rolledBackFromRevisionId ?? null,
          changedKeys,
          beforeConfig: beforeConfig as unknown as Record<string, unknown>,
          afterConfig: afterConfig as unknown as Record<string, unknown>,
        });
      }
    }

    return normalizedUpdated;
  }

  async function batchUpdateAdapterConfigs(
    changes: BatchAdapterConfigChange[],
    options?: BatchUpdateAdapterConfigsOptions,
  ) {
    if (changes.length === 0) return [];

    const ids = Array.from(new Set(changes.map((change) => change.id)));
    const rows = await db
      .select()
      .from(agents)
      .where(inArray(agents.id, ids));
    const existingById = new Map(rows.map((row) => {
      const normalized = normalizeAgentRow(row);
      return [normalized.id, normalized] as const;
    }));

    for (const id of ids) {
      if (!existingById.has(id)) {
        throw notFound("Agent not found");
      }
    }

    return db.transaction(async (tx) => {
      const updatedAgents: typeof rows = [];

      for (const change of changes) {
        const existing = existingById.get(change.id);
        if (!existing) {
          throw notFound("Agent not found");
        }

        const beforeConfig = options?.recordRevision ? buildConfigSnapshot(existing) : null;
        const updated = await tx
          .update(agents)
          .set({
            adapterConfig: change.adapterConfig,
            updatedAt: new Date(),
          })
          .where(eq(agents.id, change.id))
          .returning()
          .then((result) => result[0] ?? null);
        if (!updated) {
          throw notFound("Agent not found");
        }

        const normalized = normalizeAgentRow(updated);
        const templateLinked = await ensureTemplateRevisionLink(tx, normalized, options?.recordRevision);
        const finalizedRow = {
          ...updated,
          templateId: templateLinked.templateId,
          templateRevisionId: templateLinked.templateRevisionId,
        };
        updatedAgents.push(finalizedRow);

        if (beforeConfig && options?.recordRevision) {
          const afterConfig = buildConfigSnapshot(normalizeAgentRow(finalizedRow));
          const changedKeys = diffConfigSnapshot(beforeConfig, afterConfig);
          if (changedKeys.length > 0) {
            await tx.insert(agentConfigRevisions).values({
              companyId: existing.companyId,
              agentId: existing.id,
              createdByAgentId: options.recordRevision.createdByAgentId ?? null,
              createdByUserId: options.recordRevision.createdByUserId ?? null,
              source: options.recordRevision.source ?? "patch",
              rolledBackFromRevisionId: options.recordRevision.rolledBackFromRevisionId ?? null,
              changedKeys,
              beforeConfig: beforeConfig as unknown as Record<string, unknown>,
              afterConfig: afterConfig as unknown as Record<string, unknown>,
            });
          }
        }
      }

      const updatedById = new Map(
        updatedAgents.map((row) => {
          const normalized = normalizeAgentRow(row);
          return [normalized.id, normalized] as const;
        }),
      );
      return changes
        .map((change) => updatedById.get(change.id))
        .filter((agent): agent is Exclude<typeof agent, undefined> => Boolean(agent));
    });
  }

  return {
    list: async (companyId: string, options?: { includeTerminated?: boolean }) => {
      const conditions = [eq(agents.companyId, companyId)];
      if (!options?.includeTerminated) {
        conditions.push(ne(agents.status, "terminated"));
      }
      const rows = await db.select().from(agents).where(and(...conditions));
      const hydrated = await hydrateAgentSpend(rows);
      return hydrated.map(normalizeAgentRow);
    },

    getById,

    create: async (companyId: string, data: Omit<typeof agents.$inferInsert, "companyId">) => {
      const hierarchyState = resolveHierarchyState(data);
      await assertHierarchyRules(companyId, hierarchyState);

      const existingAgents = await db
        .select({ id: agents.id, name: agents.name, status: agents.status })
        .from(agents)
        .where(eq(agents.companyId, companyId));
      const uniqueName = deduplicateAgentName(data.name, existingAgents);

      const role = data.role ?? "general";
      const normalizedPermissions = normalizeAgentPermissions(data.permissions, role, {
        capabilityProfileKey: hierarchyState.capabilityProfileKey,
        operatingClass: hierarchyState.operatingClass,
        orgLevel: hierarchyState.orgLevel,
      });
      const created = await db.transaction(async (tx) => {
        const inserted = await tx
          .insert(agents)
          .values({
            ...data,
            name: uniqueName,
            companyId,
            role,
            permissions: normalizedPermissions,
            orgLevel: hierarchyState.orgLevel,
            operatingClass: hierarchyState.operatingClass,
            capabilityProfileKey: hierarchyState.capabilityProfileKey,
            archetypeKey: hierarchyState.archetypeKey,
            departmentKey: hierarchyState.departmentKey,
            departmentName: hierarchyState.departmentName,
          })
          .returning()
          .then((rows) => rows[0]);

        const normalizedInserted = normalizeAgentRow(inserted);
        const templateLinked = await ensureTemplateRevisionLink(tx, normalizedInserted);
        return normalizeAgentRow({
          ...inserted,
          templateId: templateLinked.templateId,
          templateRevisionId: templateLinked.templateRevisionId,
        });
      });

      return created;
    },

    update: updateAgent,
    batchUpdateAdapterConfigs,

    pause: async (id: string, reason: "manual" | "budget" | "system" = "manual") => {
      const existing = await getById(id);
      if (!existing) return null;
      if (existing.status === "terminated") throw conflict("Cannot pause terminated agent");

      const updated = await db
        .update(agents)
        .set({
          status: "paused",
          pauseReason: reason,
          pausedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(agents.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      return updated ? normalizeAgentRow(updated) : null;
    },

    resume: async (id: string) => {
      const existing = await getById(id);
      if (!existing) return null;
      if (existing.status === "terminated") throw conflict("Cannot resume terminated agent");
      if (existing.status === "pending_approval") {
        throw conflict("Pending approval agents cannot be resumed");
      }

      const updated = await db
        .update(agents)
        .set({
          status: "idle",
          pauseReason: null,
          pausedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(agents.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      return updated ? normalizeAgentRow(updated) : null;
    },

    terminate: async (id: string) => {
      const existing = await getById(id);
      if (!existing) return null;

      await db
        .update(agents)
        .set({
          status: "terminated",
          pauseReason: null,
          pausedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(agents.id, id));

      await db
        .update(agentApiKeys)
        .set({ revokedAt: new Date() })
        .where(eq(agentApiKeys.agentId, id));

      return getById(id);
    },

    remove: async (id: string) => {
      const existing = await getById(id);
      if (!existing) return null;

      return db.transaction(async (tx) => {
        await tx.update(agents).set({ reportsTo: null }).where(eq(agents.reportsTo, id));
        await tx
          .update(issues)
          .set({ assigneeAgentId: null, createdByAgentId: null })
          .where(or(eq(issues.assigneeAgentId, id), eq(issues.createdByAgentId, id)));
        await tx.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.agentId, id));
        await tx.delete(agentTaskSessions).where(eq(agentTaskSessions.agentId, id));
        await tx.delete(activityLog).where(
          or(
            eq(activityLog.agentId, id),
            sql`${activityLog.runId} in (select ${heartbeatRuns.id} from ${heartbeatRuns} where ${heartbeatRuns.agentId} = ${id})`,
          ),
        );
        await tx.delete(issueExecutionDecisions).where(eq(issueExecutionDecisions.actorAgentId, id));
        await tx.delete(issueComments).where(eq(issueComments.authorAgentId, id));
        await tx.delete(heartbeatRuns).where(eq(heartbeatRuns.agentId, id));
        await tx.delete(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, id));
        await tx.delete(agentApiKeys).where(eq(agentApiKeys.agentId, id));
        await tx.delete(agentRuntimeState).where(eq(agentRuntimeState.agentId, id));
        const deleted = await tx
          .delete(agents)
          .where(eq(agents.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
        return deleted ? normalizeAgentRow(deleted) : null;
      });
    },

    activatePendingApproval: async (id: string) => {
      const existing = await getById(id);
      if (!existing) return null;
      if (existing.status !== "pending_approval") return existing;

      const updated = await db
        .update(agents)
        .set({ status: "idle", updatedAt: new Date() })
        .where(eq(agents.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);

      return updated ? normalizeAgentRow(updated) : null;
    },

    updatePermissions: async (id: string, permissions: { canCreateAgents: boolean }) => {
      const existing = await getById(id);
      if (!existing) return null;

      const updated = await db
        .update(agents)
        .set({
          permissions: normalizeAgentPermissions(permissions, existing.role, {
            capabilityProfileKey: existing.capabilityProfileKey,
            operatingClass: existing.operatingClass,
            orgLevel: existing.orgLevel,
          }),
          updatedAt: new Date(),
        })
        .where(eq(agents.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);

      return updated ? normalizeAgentRow(updated) : null;
    },

    listConfigRevisions: async (id: string) =>
      db
        .select()
        .from(agentConfigRevisions)
        .where(eq(agentConfigRevisions.agentId, id))
        .orderBy(desc(agentConfigRevisions.createdAt)),

    getConfigRevision: async (id: string, revisionId: string) =>
      db
        .select()
        .from(agentConfigRevisions)
        .where(and(eq(agentConfigRevisions.agentId, id), eq(agentConfigRevisions.id, revisionId)))
        .then((rows) => rows[0] ?? null),

    rollbackConfigRevision: async (
      id: string,
      revisionId: string,
      actor: { agentId?: string | null; userId?: string | null },
    ) => {
      const revision = await db
        .select()
        .from(agentConfigRevisions)
        .where(and(eq(agentConfigRevisions.agentId, id), eq(agentConfigRevisions.id, revisionId)))
        .then((rows) => rows[0] ?? null);
      if (!revision) return null;
      if (containsRedactedMarker(revision.afterConfig)) {
        throw unprocessable("Cannot roll back a revision that contains redacted secret values");
      }

      const patch = configPatchFromSnapshot(revision.afterConfig);
      return updateAgent(id, patch, {
        recordRevision: {
          createdByAgentId: actor.agentId ?? null,
          createdByUserId: actor.userId ?? null,
          source: "rollback",
          rolledBackFromRevisionId: revision.id,
        },
      });
    },

    createApiKey: async (id: string, name: string) => {
      const existing = await getById(id);
      if (!existing) throw notFound("Agent not found");
      if (existing.status === "pending_approval") {
        throw conflict("Cannot create keys for pending approval agents");
      }
      if (existing.status === "terminated") {
        throw conflict("Cannot create keys for terminated agents");
      }

      const token = createToken();
      const keyHash = hashToken(token);
      const created = await db
        .insert(agentApiKeys)
        .values({
          agentId: id,
          companyId: existing.companyId,
          name,
          keyHash,
        })
        .returning()
        .then((rows) => rows[0]);

      return {
        id: created.id,
        name: created.name,
        token,
        createdAt: created.createdAt,
      };
    },

    listKeys: (id: string) =>
      db
        .select({
          id: agentApiKeys.id,
          name: agentApiKeys.name,
          createdAt: agentApiKeys.createdAt,
          revokedAt: agentApiKeys.revokedAt,
        })
        .from(agentApiKeys)
        .where(eq(agentApiKeys.agentId, id)),

    revokeKey: async (keyId: string) => {
      const rows = await db
        .update(agentApiKeys)
        .set({ revokedAt: new Date() })
        .where(eq(agentApiKeys.id, keyId))
        .returning();
      return rows[0] ?? null;
    },

    orgForCompany: async (companyId: string) => {
      const rows = await db
        .select()
        .from(agents)
        .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated")));
      const normalizedRows: NormalizedAgentRow[] = rows.map(normalizeAgentRow);
      const byManager = new Map<string | null, typeof normalizedRows>();
      for (const row of normalizedRows) {
        const key = row.reportsTo ?? null;
        const group = byManager.get(key) ?? [];
        group.push(row);
        byManager.set(key, group);
      }

      const build = (managerId: string | null): Array<Record<string, unknown>> => {
        const members = (byManager.get(managerId) ?? []).sort((left, right) => left.name.localeCompare(right.name));
        return members.map((member) => ({
          ...member,
          reports: build(member.id),
        }));
      };

      return build(null);
    },

    hierarchyForCompany: async (companyId: string) => {
      const rows = await db
        .select()
        .from(agents)
        .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated")));
      const normalizedRows: NormalizedAgentRow[] = rows.map(normalizeAgentRow);
      const byId = new Map(normalizedRows.map((row) => [row.id, row]));

      const groups = new Map<string, HierarchyExecutiveGroup>();

      const unassigned = {
        executives: [] as NormalizedAgentRow[],
        directors: [] as NormalizedAgentRow[],
        staff: [] as NormalizedAgentRow[],
      };

      const resolveOwningExecutive = (agent: NormalizedAgentRow) => {
        const visited = new Set<string>([agent.id]);
        let currentId = agent.reportsTo;
        while (currentId && !visited.has(currentId)) {
          visited.add(currentId);
          const manager = byId.get(currentId);
          if (!manager) return null;
          if (manager.orgLevel === "executive") return manager;
          currentId = manager.reportsTo;
        }
        return null;
      };

      for (const row of normalizedRows) {
        if (row.orgLevel === "executive") {
          groups.set(row.id, {
            executive: row,
            departments: new Map<string, HierarchyDepartmentGroup>(),
          });
        }
      }

      for (const row of normalizedRows) {
        if (row.orgLevel === "executive") continue;

        const executive = resolveOwningExecutive(row);
        if (!executive) {
          if (row.orgLevel === "director") {
            unassigned.directors.push(row);
          } else {
            unassigned.staff.push(row);
          }
          continue;
        }

        const executiveGroup = groups.get(executive.id);
        if (!executiveGroup) {
          if (row.orgLevel === "director") {
            unassigned.directors.push(row);
          } else {
            unassigned.staff.push(row);
          }
          continue;
        }

        const departmentName = departmentDisplayName(row.departmentKey, row.departmentName);
        const departmentKeyValue = `${row.departmentKey}:${departmentName.toLowerCase()}`;
        const department = executiveGroup.departments.get(departmentKeyValue) ?? {
          key: row.departmentKey,
          name: departmentName,
          ownerExecutiveId: executive.id,
          ownerExecutiveName: executive.name,
          directors: [] as NormalizedAgentRow[],
          staff: [] as NormalizedAgentRow[],
        };
        if (row.orgLevel === "director") {
          department.directors.push(row);
        } else {
          department.staff.push(row);
        }
        executiveGroup.departments.set(departmentKeyValue, department);
      }

      return {
        executives: Array.from(groups.values())
          .sort((left, right) => executiveSortKey(left.executive.role, left.executive.name).localeCompare(
            executiveSortKey(right.executive.role, right.executive.name),
          ))
          .map((group) => ({
            executive: group.executive,
            departments: Array.from(group.departments.values())
              .sort((left, right) => departmentSortKey(left.key, left.name).localeCompare(
                departmentSortKey(right.key, right.name),
              ))
              .map((department) => ({
                ...department,
                directors: [...department.directors].sort((left, right) => left.name.localeCompare(right.name)),
                staff: [...department.staff].sort((left, right) => left.name.localeCompare(right.name)),
              })),
          })),
        unassigned: {
          executives: unassigned.executives.sort((left, right) => left.name.localeCompare(right.name)),
          directors: unassigned.directors.sort((left, right) => left.name.localeCompare(right.name)),
          staff: unassigned.staff.sort((left, right) => left.name.localeCompare(right.name)),
        },
      };
    },

    listProjectScopesForCompany: async (companyId: string) => {
      const scopeRows = await listActiveScopesForCompany(companyId);
      return scopeRows.map((row) => row.scope);
    },

    operatingHierarchyForCompany: async (companyId: string) => {
      const [rows, scopeRows, clusterRows] = await Promise.all([
        db
          .select()
          .from(agents)
          .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated"))),
        listActiveScopesForCompany(companyId),
        db
          .select()
          .from(portfolioClusters)
          .where(eq(portfolioClusters.companyId, companyId)),
      ]);

      const normalizedRows: NormalizedAgentRow[] = rows.map(normalizeAgentRow);
      const byId = new Map(normalizedRows.map((row) => [row.id, row]));
      const projectPods = buildProjectPodGroups(scopeRows, byId);
      const portfolioClusterGroups = buildOperatingClusterGroups(clusterRows, scopeRows, byId, projectPods);
      const sharedServicesByDepartment = new Map<string, NavigationDepartmentGroup>();
      const scopedAgentIds = new Set(scopeRows.map((row) => row.scope.agentId));
      const unassigned: NormalizedAgentRow[] = [];

      for (const row of normalizedRows) {
        if (row.operatingClass === "shared_service_lead") {
          const departmentName = departmentDisplayName(row.departmentKey, row.departmentName);
          const key = `${row.departmentKey}:${departmentName.toLowerCase()}`;
          const group = sharedServicesByDepartment.get(key) ?? {
            key: row.departmentKey,
            name: departmentName,
            leaders: [],
            clusters: new Map<string, NavigationClusterGroup>(),
            projects: new Map<string, NavigationProjectGroup>(),
          };
          group.leaders.push(row);
          sharedServicesByDepartment.set(key, group);
          continue;
        }
        if (row.operatingClass === "executive") continue;
        if (!scopedAgentIds.has(row.id)) {
          unassigned.push(row);
        }
      }

      return {
        executiveOffice: sortOperatingAgents(
          normalizedRows.filter((row) => row.operatingClass === "executive"),
        ).map(toOperatingSummary),
        portfolioClusters: portfolioClusterGroups.map((group) => ({
          clusterId: group.clusterId,
          name: group.name,
          slug: group.slug,
          summary: group.summary,
          executiveSponsor: group.executiveSponsor ? toOperatingSummary(group.executiveSponsor) : null,
          portfolioDirector: group.portfolioDirector ? toOperatingSummary(group.portfolioDirector) : null,
          projects: Array.from(group.projects.values())
            .sort((left, right) => left.projectName.localeCompare(right.projectName))
            .map((project) => ({
              projectId: project.projectId,
              projectName: project.projectName,
              color: project.color,
              leadership: sortOperatingAgents(dedupeById(project.leadership)).map(toOperatingSummary),
              workers: sortOperatingAgents(dedupeById(project.workers)).map(toOperatingSummary),
              consultants: sortOperatingAgents(dedupeById(project.consultants)).map(toOperatingSummary),
            })),
        })),
        projectPods: Array.from(projectPods.values())
          .sort((left, right) => left.projectName.localeCompare(right.projectName))
          .map((group) => ({
            projectId: group.projectId,
            projectName: group.projectName,
            color: group.color,
            leadership: sortOperatingAgents(dedupeById(group.leadership)).map(toOperatingSummary),
            workers: sortOperatingAgents(dedupeById(group.workers)).map(toOperatingSummary),
            consultants: sortOperatingAgents(dedupeById(group.consultants)).map(toOperatingSummary),
          })),
        sharedServices: Array.from(sharedServicesByDepartment.values())
          .sort((left, right) => departmentSortKey(left.key === "shared_service" ? "general" : left.key, left.name).localeCompare(
            departmentSortKey(right.key === "shared_service" ? "general" : right.key, right.name),
          ))
          .map((group) => ({
            key: group.key,
            name: group.name,
            leaders: sortOperatingAgents(dedupeById(group.leaders)).map(toOperatingSummary),
            projects: [],
          })),
        unassigned: sortOperatingAgents(dedupeById(unassigned)).map(toOperatingSummary),
      };
    },

    navigationForCompany: async (companyId: string, layout: AgentNavigationLayout = "department") => {
      const [rows, scopeRows, clusterRows] = await Promise.all([
        db
          .select()
          .from(agents)
          .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated"))),
        listActiveScopesForCompany(companyId),
        db
          .select()
          .from(portfolioClusters)
          .where(eq(portfolioClusters.companyId, companyId)),
      ]);
      const normalizedRows: NormalizedAgentRow[] = rows.map(normalizeAgentRow);
      const byId = new Map(normalizedRows.map((row) => [row.id, row]));
      const projectPods = buildProjectPodGroups(scopeRows, byId);
      const departmentNavigation = buildNavigationByDepartment(clusterRows, scopeRows, byId);
      const portfolioClusterGroups = buildOperatingClusterGroups(clusterRows, scopeRows, byId, projectPods);
      const scopedAgentIds = new Set(scopeRows.map((row) => row.scope.agentId));

      return {
        layout,
        executives: sortOperatingAgents(
          normalizedRows.filter((row) => row.operatingClass === "executive"),
        ).map(toOperatingSummary),
        departments: departmentNavigation.departments,
        portfolioClusters: portfolioClusterGroups.map((group) => ({
          clusterId: group.clusterId,
          name: group.name,
          slug: group.slug,
          summary: group.summary,
          executiveSponsor: group.executiveSponsor ? toOperatingSummary(group.executiveSponsor) : null,
          portfolioDirector: group.portfolioDirector ? toOperatingSummary(group.portfolioDirector) : null,
          projects: Array.from(group.projects.values())
            .sort((left, right) => left.projectName.localeCompare(right.projectName))
            .map(serializeProjectPodNavigation),
        })),
        projectPods: Array.from(projectPods.values())
          .sort((left, right) => left.projectName.localeCompare(right.projectName))
          .map(serializeProjectPodNavigation),
        sharedServices: departmentNavigation.sharedServices,
        unassigned: sortOperatingAgents(
          normalizedRows.filter(
            (row) =>
              row.operatingClass !== "executive" &&
              row.operatingClass !== "shared_service_lead" &&
              !scopedAgentIds.has(row.id),
          ),
        ).map(toOperatingSummary),
      };
    },

    getChainOfCommand: async (agentId: string) => {
      const chain: {
        id: string;
        name: string;
        role: string;
        title: string | null;
        orgLevel: AgentOrgLevel;
        departmentKey: AgentDepartmentKey;
        departmentName: string | null;
      }[] = [];
      const visited = new Set<string>([agentId]);
      const start = await getById(agentId);
      let currentId = start?.reportsTo ?? null;
      while (currentId && !visited.has(currentId) && chain.length < 50) {
        visited.add(currentId);
        const mgr = await getById(currentId);
        if (!mgr) break;
        chain.push({
          id: mgr.id,
          name: mgr.name,
          role: mgr.role,
          title: mgr.title ?? null,
          orgLevel: mgr.orgLevel,
          departmentKey: mgr.departmentKey,
          departmentName: mgr.departmentName,
        });
        currentId = mgr.reportsTo ?? null;
      }
      return chain;
    },

    runningForAgent: (agentId: string) =>
      db
        .select()
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.agentId, agentId), inArray(heartbeatRuns.status, ["queued", "running"]))),

    resolveByReference: async (companyId: string, reference: string) => {
      const raw = reference.trim();
      if (raw.length === 0) {
        return { agent: null, ambiguous: false } as const;
      }

      if (isUuidLike(raw)) {
        const byId = await getById(raw);
        if (!byId || byId.companyId !== companyId) {
          return { agent: null, ambiguous: false } as const;
        }
        return { agent: byId, ambiguous: false } as const;
      }

      const urlKey = normalizeAgentUrlKey(raw);
      if (!urlKey) {
        return { agent: null, ambiguous: false } as const;
      }

      const rows = await db.select().from(agents).where(eq(agents.companyId, companyId));
      const matches = rows
        .map(normalizeAgentRow)
        .filter((agent) => agent.urlKey === urlKey && agent.status !== "terminated");
      if (matches.length === 1) {
        return { agent: matches[0] ?? null, ambiguous: false } as const;
      }
      if (matches.length > 1) {
        return { agent: null, ambiguous: true } as const;
      }
      return { agent: null, ambiguous: false } as const;
    },
  };
}
