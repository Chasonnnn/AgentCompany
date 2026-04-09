import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gte, inArray, lt, ne, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
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
} from "@paperclipai/db";
import {
  AGENT_ROLES,
  AGENT_DEPARTMENT_LABELS,
  type AgentDepartmentKey,
  type AgentOrgLevel,
  type AgentRole,
  isUuidLike,
  normalizeAgentUrlKey,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { normalizeAgentPermissions } from "./agent-permissions.js";
import { REDACTED_EVENT_VALUE, sanitizeRecord } from "../redaction.js";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function createToken() {
  return `pcp_${randomBytes(24).toString("hex")}`;
}

const CONFIG_REVISION_FIELDS = [
  "name",
  "role",
  "title",
  "reportsTo",
  "orgLevel",
  "departmentKey",
  "departmentName",
  "capabilities",
  "adapterType",
  "adapterConfig",
  "runtimeConfig",
  "budgetMonthlyCents",
  "metadata",
] as const;

type ConfigRevisionField = (typeof CONFIG_REVISION_FIELDS)[number];
type AgentConfigSnapshot = Pick<typeof agents.$inferSelect, ConfigRevisionField>;

interface RevisionMetadata {
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
  source?: string;
  rolledBackFromRevisionId?: string | null;
}

interface UpdateAgentOptions {
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
  departmentKey: AgentDepartmentKey;
  departmentName: string | null;
}

interface NormalizedAgentRow
  extends Omit<typeof agents.$inferSelect, "role" | "orgLevel" | "departmentKey" | "departmentName" | "permissions"> {
  role: AgentRole;
  urlKey: string;
  orgLevel: AgentOrgLevel;
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
    name: row.name,
    role: row.role,
    title: row.title,
    reportsTo: row.reportsTo,
    orgLevel: row.orgLevel,
    departmentKey: row.departmentKey,
    departmentName: row.departmentName,
    capabilities: row.capabilities,
    adapterType: row.adapterType,
    adapterConfig,
    runtimeConfig,
    budgetMonthlyCents: row.budgetMonthlyCents,
    metadata,
  };
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
  if (typeof snapshot.adapterType !== "string" || snapshot.adapterType.length === 0) {
    throw unprocessable("Invalid revision snapshot: adapterType");
  }
  if (typeof snapshot.budgetMonthlyCents !== "number" || !Number.isFinite(snapshot.budgetMonthlyCents)) {
    throw unprocessable("Invalid revision snapshot: budgetMonthlyCents");
  }

  return {
    name: snapshot.name,
    role: normalizeAgentRole(snapshot.role),
    title: typeof snapshot.title === "string" || snapshot.title === null ? snapshot.title : null,
    reportsTo:
      typeof snapshot.reportsTo === "string" || snapshot.reportsTo === null ? snapshot.reportsTo : null,
    orgLevel:
      snapshot.orgLevel === "executive" || snapshot.orgLevel === "director" || snapshot.orgLevel === "staff"
        ? snapshot.orgLevel
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
    adapterType: snapshot.adapterType,
    adapterConfig: isPlainRecord(snapshot.adapterConfig) ? snapshot.adapterConfig : {},
    runtimeConfig: isPlainRecord(snapshot.runtimeConfig) ? snapshot.runtimeConfig : {},
    budgetMonthlyCents: Math.max(0, Math.floor(snapshot.budgetMonthlyCents)),
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
    const departmentKey = row.departmentKey ?? defaultDepartmentKeyForRole(row.role);
    return withUrlKey({
      ...row,
      role: normalizeAgentRole(row.role),
      orgLevel,
      departmentKey,
      departmentName: normalizeDepartmentName(departmentKey, row.departmentName),
      permissions: normalizeAgentPermissions(row.permissions, row.role),
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
      if (manager.orgLevel !== "executive") {
        throw unprocessable("Directors must report to an executive");
      }
      return;
    }

    if (state.orgLevel === "staff" && manager.orgLevel !== "executive" && manager.orgLevel !== "director") {
      throw unprocessable("Staff must report to a director or executive");
    }

    if (manager.orgLevel !== "executive" && state.departmentKey !== manager.departmentKey) {
      throw unprocessable("Agents must share the same department as their manager unless the manager is an executive");
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
      departmentKey: hierarchyState.departmentKey,
      departmentName: hierarchyState.departmentName,
    } as Partial<typeof agents.$inferInsert>;
    if (data.permissions !== undefined) {
      const role = (data.role ?? existing.role) as string;
      normalizedPatch.permissions = normalizeAgentPermissions(data.permissions, role);
    }

    const shouldRecordRevision = Boolean(options?.recordRevision) && hasConfigPatchFields(normalizedPatch);
    const beforeConfig = shouldRecordRevision ? buildConfigSnapshot(existing) : null;

    const updated = await db
      .update(agents)
      .set({ ...normalizedPatch, updatedAt: new Date() })
      .where(eq(agents.id, id))
      .returning()
      .then((rows) => rows[0] ?? null);
    const normalizedUpdated = updated ? normalizeAgentRow(updated) : null;

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
      const normalizedPermissions = normalizeAgentPermissions(data.permissions, role);
      const created = await db
        .insert(agents)
        .values({
          ...data,
          name: uniqueName,
          companyId,
          role,
          permissions: normalizedPermissions,
          orgLevel: hierarchyState.orgLevel,
          departmentKey: hierarchyState.departmentKey,
          departmentName: hierarchyState.departmentName,
        })
        .returning()
        .then((rows) => rows[0]);

      return normalizeAgentRow(created);
    },

    update: updateAgent,

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
          permissions: normalizeAgentPermissions(permissions, existing.role),
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
