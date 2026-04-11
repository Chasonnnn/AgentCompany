import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  agentProjectScopes,
  projects,
  sharedServiceEngagementAssignments,
  sharedServiceEngagements,
} from "@paperclipai/db";
import type {
  CreateSharedServiceEngagement,
  SharedServiceEngagement,
  SharedServiceEngagementAssignment,
  UpdateSharedServiceEngagement,
} from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";

type ActorInfo = {
  actorType: "user" | "agent";
  actorId: string;
  agentId?: string | null;
};

type DbSelectable = Pick<Db, "select">;
type DbMutationContext = Pick<Db, "select" | "insert" | "update">;

function readTrimmed(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function deriveServiceAreaLabel(key: string, explicit?: string | null) {
  const trimmed = explicit?.trim();
  if (trimmed) return trimmed;
  return key
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function grantId(engagementId: string) {
  return `shared-service-engagement:${engagementId}`;
}

function toAssignment(row: typeof sharedServiceEngagementAssignments.$inferSelect): SharedServiceEngagementAssignment {
  return {
    id: row.id,
    companyId: row.companyId,
    engagementId: row.engagementId,
    agentId: row.agentId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toEngagement(
  row: typeof sharedServiceEngagements.$inferSelect,
  assignments: SharedServiceEngagementAssignment[],
): SharedServiceEngagement {
  return {
    id: row.id,
    companyId: row.companyId,
    targetProjectId: row.targetProjectId,
    serviceAreaKey: row.serviceAreaKey,
    serviceAreaLabel: row.serviceAreaLabel,
    title: row.title,
    summary: row.summary,
    status: row.status,
    requestedByAgentId: row.requestedByAgentId ?? null,
    requestedByUserId: row.requestedByUserId ?? null,
    approvedByAgentId: row.approvedByAgentId ?? null,
    approvedByUserId: row.approvedByUserId ?? null,
    closedByAgentId: row.closedByAgentId ?? null,
    closedByUserId: row.closedByUserId ?? null,
    approvedAt: row.approvedAt ?? null,
    closedAt: row.closedAt ?? null,
    outcomeSummary: row.outcomeSummary ?? null,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    assignments,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function sharedServiceEngagementService(db: Db) {
  async function getRow(id: string, dbOrTx: DbSelectable = db) {
    return dbOrTx
      .select()
      .from(sharedServiceEngagements)
      .where(eq(sharedServiceEngagements.id, id))
      .then((rows) => rows[0] ?? null);
  }

  async function assertTargetProject(companyId: string, projectId: string, dbOrTx: DbSelectable = db) {
    const row = await dbOrTx
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Target project not found");
    if (row.companyId !== companyId) {
      throw unprocessable("Target project must belong to the same company");
    }
    return row;
  }

  async function assertAssignedAgents(companyId: string, agentIds: string[], dbOrTx: DbSelectable = db) {
    const uniqueIds = Array.from(new Set(agentIds));
    if (uniqueIds.length === 0) return [];
    const rows = await dbOrTx
      .select()
      .from(agents)
      .where(inArray(agents.id, uniqueIds));
    if (rows.length !== uniqueIds.length) {
      throw notFound("One or more assigned agents were not found");
    }
    for (const row of rows) {
      if (row.companyId !== companyId) {
        throw unprocessable("Assigned agents must belong to the same company");
      }
      if (row.status === "terminated") {
        throw unprocessable("Terminated agents cannot be assigned to shared-service engagements");
      }
      if (row.operatingClass !== "shared_service_lead" && row.operatingClass !== "consultant") {
        throw unprocessable("Shared-service engagements may only assign shared-service leads or consultants");
      }
    }
    return rows;
  }

  async function hydrate(
    rows: Array<typeof sharedServiceEngagements.$inferSelect>,
    dbOrTx: DbSelectable = db,
  ) {
    if (rows.length === 0) return [];
    const engagementIds = rows.map((row) => row.id);
    const assignmentRows = await dbOrTx
      .select()
      .from(sharedServiceEngagementAssignments)
      .where(inArray(sharedServiceEngagementAssignments.engagementId, engagementIds));
    const assignmentsByEngagement = new Map<string, SharedServiceEngagementAssignment[]>();
    for (const assignment of assignmentRows) {
      const group = assignmentsByEngagement.get(assignment.engagementId) ?? [];
      group.push(toAssignment(assignment));
      assignmentsByEngagement.set(assignment.engagementId, group);
    }
    return rows.map((row) =>
      toEngagement(
        row,
        (assignmentsByEngagement.get(row.id) ?? []).sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime()),
      ),
    );
  }

  async function syncAssignments(tx: any, engagementId: string, companyId: string, assignedAgentIds: string[]) {
    const uniqueIds = Array.from(new Set(assignedAgentIds));
    await assertAssignedAgents(companyId, uniqueIds, tx);

    const existing = await tx
      .select()
      .from(sharedServiceEngagementAssignments)
      .where(eq(sharedServiceEngagementAssignments.engagementId, engagementId));
    const existingIds = new Set(existing.map((row: typeof sharedServiceEngagementAssignments.$inferSelect) => row.agentId));
    const desiredIds = new Set(uniqueIds);
    const staleIds = existing
      .filter((row: typeof sharedServiceEngagementAssignments.$inferSelect) => !desiredIds.has(row.agentId))
      .map((row: typeof sharedServiceEngagementAssignments.$inferSelect) => row.id);

    if (staleIds.length > 0) {
      await tx.delete(sharedServiceEngagementAssignments).where(inArray(sharedServiceEngagementAssignments.id, staleIds));
    }

    const now = new Date();
    const rowsToInsert = uniqueIds
      .filter((agentId) => !existingIds.has(agentId))
      .map((agentId) => ({
        companyId,
        engagementId,
        agentId,
        createdAt: now,
        updatedAt: now,
      }));
    if (rowsToInsert.length > 0) {
      await tx.insert(sharedServiceEngagementAssignments).values(rowsToInsert);
    }
  }

  async function reconcileConsultingScopes(engagementId: string, dbOrTx: DbMutationContext = db) {
    const engagement = await getRow(engagementId, dbOrTx);
    if (!engagement) throw notFound("Shared-service engagement not found");
    const assignments = await dbOrTx
      .select()
      .from(sharedServiceEngagementAssignments)
      .where(eq(sharedServiceEngagementAssignments.engagementId, engagementId));
    const desiredAgentIds = engagement.status === "approved"
      ? new Set(assignments.map((assignment) => assignment.agentId))
      : new Set<string>();
    const now = new Date();
    const existingScopes = await dbOrTx
      .select()
      .from(agentProjectScopes)
      .where(
        and(
          eq(agentProjectScopes.companyId, engagement.companyId),
          eq(agentProjectScopes.projectId, engagement.targetProjectId),
          eq(agentProjectScopes.scopeMode, "consulting"),
          eq(agentProjectScopes.grantedByPrincipalType, "system_process"),
          eq(agentProjectScopes.grantedByPrincipalId, grantId(engagement.id)),
          isNull(agentProjectScopes.activeTo),
        ),
      );
    const staleIds = existingScopes
      .filter((scope) => !desiredAgentIds.has(scope.agentId))
      .map((scope) => scope.id);
    if (staleIds.length > 0) {
      await dbOrTx
        .update(agentProjectScopes)
        .set({ activeTo: now, updatedAt: now })
        .where(inArray(agentProjectScopes.id, staleIds));
    }

    const activeKeys = new Set(
      existingScopes
        .filter((scope) => desiredAgentIds.has(scope.agentId) && !staleIds.includes(scope.id))
        .map((scope) => scope.agentId),
    );
    const rowsToInsert = Array.from(desiredAgentIds)
      .filter((agentId) => !activeKeys.has(agentId))
      .map((agentId) => ({
        companyId: engagement.companyId,
        agentId,
        projectId: engagement.targetProjectId,
        scopeMode: "consulting" as const,
        projectRole: "consultant" as const,
        isPrimary: false,
        teamFunctionKey: null,
        teamFunctionLabel: null,
        workstreamKey: engagement.serviceAreaKey,
        workstreamLabel: engagement.serviceAreaLabel,
        grantedByPrincipalType: "system_process" as const,
        grantedByPrincipalId: grantId(engagement.id),
        activeFrom: now,
        activeTo: null,
        createdAt: now,
        updatedAt: now,
      }));
    if (rowsToInsert.length > 0) {
      await dbOrTx.insert(agentProjectScopes).values(rowsToInsert);
    }
  }

  return {
    getById: async (id: string) => {
      const row = await getRow(id);
      if (!row) return null;
      const [engagement] = await hydrate([row]);
      return engagement ?? null;
    },

    listForCompany: async (companyId: string) => {
      const rows = await db
        .select()
        .from(sharedServiceEngagements)
        .where(eq(sharedServiceEngagements.companyId, companyId))
        .orderBy(desc(sharedServiceEngagements.updatedAt));
      return hydrate(rows);
    },

    create: async (companyId: string, input: CreateSharedServiceEngagement, actor: ActorInfo) => {
      await assertTargetProject(companyId, input.targetProjectId);
      return db.transaction(async (tx) => {
        const row = await tx
          .insert(sharedServiceEngagements)
          .values({
            companyId,
            targetProjectId: input.targetProjectId,
            serviceAreaKey: input.serviceAreaKey.trim(),
            serviceAreaLabel: deriveServiceAreaLabel(input.serviceAreaKey.trim(), input.serviceAreaLabel ?? null),
            title: input.title.trim(),
            summary: input.summary.trim(),
            status: "requested",
            requestedByAgentId: actor.agentId ?? null,
            requestedByUserId: actor.actorType === "user" ? actor.actorId : null,
            metadata: input.metadata ?? null,
          })
          .returning()
          .then((rows) => rows[0]!);
        await syncAssignments(tx, row.id, companyId, input.assignedAgentIds ?? []);
        const [engagement] = await hydrate([row], tx);
        return engagement!;
      });
    },

    update: async (id: string, input: UpdateSharedServiceEngagement) => {
      const existing = await getRow(id);
      if (!existing) return null;
      return db.transaction(async (tx) => {
        const updated = await tx
          .update(sharedServiceEngagements)
          .set({
            serviceAreaKey: input.serviceAreaKey?.trim(),
            serviceAreaLabel: input.serviceAreaKey || input.serviceAreaLabel !== undefined
              ? deriveServiceAreaLabel(input.serviceAreaKey?.trim() ?? existing.serviceAreaKey, input.serviceAreaLabel ?? existing.serviceAreaLabel)
              : undefined,
            title: input.title?.trim(),
            summary: input.summary?.trim(),
            outcomeSummary: input.outcomeSummary !== undefined ? readTrimmed(input.outcomeSummary) : undefined,
            metadata: input.metadata,
            updatedAt: new Date(),
          })
          .where(eq(sharedServiceEngagements.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!updated) return null;
        if (input.assignedAgentIds) {
          await syncAssignments(tx, updated.id, updated.companyId, input.assignedAgentIds);
        }
        await reconcileConsultingScopes(updated.id, tx);
        const [engagement] = await hydrate([updated], tx);
        return engagement ?? null;
      });
    },

    approve: async (id: string, actor: ActorInfo) => {
      const existing = await getRow(id);
      if (!existing) return null;
      if (existing.status === "closed") {
        throw unprocessable("Closed shared-service engagements cannot be approved");
      }
      if (existing.status === "approved") {
        const [engagement] = await hydrate([existing]);
        return engagement ?? null;
      }
      return db.transaction(async (tx) => {
        const updated = await tx
          .update(sharedServiceEngagements)
          .set({
            status: "approved",
            approvedByAgentId: actor.agentId ?? null,
            approvedByUserId: actor.actorType === "user" ? actor.actorId : null,
            approvedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(sharedServiceEngagements.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!updated) return null;
        await reconcileConsultingScopes(updated.id, tx);
        const [engagement] = await hydrate([updated], tx);
        return engagement ?? null;
      });
    },

    close: async (id: string, actor: ActorInfo, outcomeSummary?: string | null) => {
      const existing = await getRow(id);
      if (!existing) return null;
      if (existing.status === "closed") {
        const [engagement] = await hydrate([existing]);
        return engagement ?? null;
      }
      return db.transaction(async (tx) => {
        const updated = await tx
          .update(sharedServiceEngagements)
          .set({
            status: "closed",
            closedByAgentId: actor.agentId ?? null,
            closedByUserId: actor.actorType === "user" ? actor.actorId : null,
            closedAt: new Date(),
            outcomeSummary: readTrimmed(outcomeSummary),
            updatedAt: new Date(),
          })
          .where(eq(sharedServiceEngagements.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!updated) return null;
        await reconcileConsultingScopes(updated.id, tx);
        const [engagement] = await hydrate([updated], tx);
        return engagement ?? null;
      });
    },
  };
}
