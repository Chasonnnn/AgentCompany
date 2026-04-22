import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
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

type AdvisorEngagementTemplate = {
  advisorKind: NonNullable<CreateSharedServiceEngagement["advisorKind"]>;
  serviceAreaKey: string;
  serviceAreaLabel: string;
  title: string;
  summary: string;
  disabledByDefault: boolean;
};

type AdvisorySurface = "comment" | "conference_room" | "decision_question" | "approval";

type AdvisorySurfaceRecommendationInput = {
  title?: string | null;
  summary?: string | null;
  advisorKind?: CreateSharedServiceEngagement["advisorKind"];
  requiresGovernance?: boolean;
  requestsBoardAnswer?: boolean;
  blocksExecution?: boolean;
  needsCrossFunctionalCoordination?: boolean;
  participantAgentIds?: string[] | null;
};

type AdvisorySurfaceRecommendation = {
  recommendedSurface: AdvisorySurface;
  reason: string;
  matchedSignals: string[];
};

const BUILTIN_ADVISOR_ENGAGEMENT_TEMPLATES: AdvisorEngagementTemplate[] = [
  {
    advisorKind: "security_audit",
    serviceAreaKey: "security",
    serviceAreaLabel: "Security",
    title: "Security Audit",
    summary: "Run a focused security review on the target project and return findings with concrete follow-ups.",
    disabledByDefault: true,
  },
  {
    advisorKind: "continuity_audit",
    serviceAreaKey: "operations",
    serviceAreaLabel: "Operations",
    title: "Continuity Audit",
    summary: "Audit issue continuity, handoff health, and owner readiness for the target project.",
    disabledByDefault: true,
  },
  {
    advisorKind: "instruction_drift",
    serviceAreaKey: "operations",
    serviceAreaLabel: "Operations",
    title: "Instruction Drift Review",
    summary: "Compare live execution behavior against current operating docs and local instruction bundles.",
    disabledByDefault: true,
  },
  {
    advisorKind: "skill_review",
    serviceAreaKey: "operations",
    serviceAreaLabel: "Operations",
    title: "Skill Review",
    summary: "Review installed skills, gaps, and follow-up opportunities for the current project lane.",
    disabledByDefault: true,
  },
  {
    advisorKind: "skill_janitor",
    serviceAreaKey: "operations",
    serviceAreaLabel: "Operations",
    title: "Skill Janitor Sweep",
    summary: "Clean stale, duplicate, or obsolete skill installs and summarize the safe cleanup plan.",
    disabledByDefault: true,
  },
  {
    advisorKind: "budget_analyst",
    serviceAreaKey: "finance",
    serviceAreaLabel: "Finance",
    title: "Budget Analyst Review",
    summary: "Review spend, flag anomalies, and recommend budget actions before hard-stop incidents appear.",
    disabledByDefault: true,
  },
  {
    advisorKind: "evidence_librarian",
    serviceAreaKey: "research",
    serviceAreaLabel: "Research",
    title: "Evidence Librarian Support",
    summary: "Collect the logs, artifacts, and references needed to back a decision or audit packet.",
    disabledByDefault: true,
  },
  {
    advisorKind: "workspace_janitor",
    serviceAreaKey: "operations",
    serviceAreaLabel: "Operations",
    title: "Workspace Janitor Sweep",
    summary: "Inspect runtime debris, worktrees, and cache leftovers around the target project workspace.",
    disabledByDefault: true,
  },
  {
    advisorKind: "adapter_qa",
    serviceAreaKey: "quality",
    serviceAreaLabel: "Quality",
    title: "Adapter QA",
    summary: "Exercise adapter behavior, capture regressions, and return a readiness summary for the lane.",
    disabledByDefault: true,
  },
  {
    advisorKind: "conversation_qa",
    serviceAreaKey: "quality",
    serviceAreaLabel: "Quality",
    title: "Conversation QA",
    summary: "Review recent transcripts for routing misses, unclear asks, and avoidable board escalations.",
    disabledByDefault: true,
  },
];

const APPROVAL_KEYWORDS = [
  "approve",
  "approval",
  "signoff",
  "authorize",
  "budget",
  "ship",
  "release",
  "policy",
  "exception",
  "staffing",
];
const DECISION_QUESTION_KEYWORDS = [
  "decide",
  "decision",
  "choose",
  "which option",
  "pick one",
  "unblock",
  "blocked",
];
const CONFERENCE_ROOM_KEYWORDS = [
  "kickoff",
  "sync",
  "review",
  "discuss",
  "coordination",
  "align",
  "incident",
  "architecture",
];

type DbSelectable = Pick<Db, "select">;
type DbMutationContext = Pick<Db, "select" | "insert" | "update" | "execute">;

type EngagementAdvisorState = {
  advisorKind: NonNullable<CreateSharedServiceEngagement["advisorKind"]> | null;
  advisorEnabled: boolean;
};

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

function includesKeyword(text: string, keywords: string[]) {
  return keywords.some((keyword) => text.includes(keyword));
}

function cloneEngagementTemplate(template: AdvisorEngagementTemplate): AdvisorEngagementTemplate {
  return { ...template };
}

function isMissingAdvisorColumnError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? (error as { code?: string }).code : undefined;
  const message = "message" in error ? (error as { message?: string }).message : undefined;
  return code === "42703" && typeof message === "string" && /advisor_kind|advisor_enabled/.test(message);
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
    advisorKind: (row.advisorKind as SharedServiceEngagement["advisorKind"]) ?? null,
    advisorEnabled: row.advisorEnabled,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    assignments,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function sharedServiceEngagementService(db: Db) {
  async function listEngagementAdvisorState(
    engagementIds: string[],
    dbOrTx: Pick<Db, "select"> = db,
  ) {
    if (engagementIds.length === 0) return new Map<string, EngagementAdvisorState>();
    try {
      const rows = await dbOrTx
        .select({
          id: sharedServiceEngagements.id,
          advisorKind: sql<NonNullable<CreateSharedServiceEngagement["advisorKind"]> | null>`advisor_kind`.as("advisorKind"),
          advisorEnabled: sql<boolean>`coalesce(advisor_enabled, false)`.as("advisorEnabled"),
        })
        .from(sharedServiceEngagements)
        .where(inArray(sharedServiceEngagements.id, engagementIds));
      return new Map<string, EngagementAdvisorState>(
        rows.map((row) => [
          row.id,
          {
            advisorKind: row.advisorKind ?? null,
            advisorEnabled: row.advisorEnabled ?? false,
          },
        ]),
      );
    } catch (error) {
      if (isMissingAdvisorColumnError(error)) {
        return new Map<string, EngagementAdvisorState>();
      }
      throw error;
    }
  }

  async function getEngagementAdvisorState(
    engagementId: string,
    dbOrTx: Pick<Db, "select"> = db,
  ) {
    return (await listEngagementAdvisorState([engagementId], dbOrTx)).get(engagementId) ?? {
      advisorKind: null,
      advisorEnabled: false,
    };
  }

  async function persistEngagementAdvisorState(
    engagementId: string,
    state: EngagementAdvisorState,
    dbOrTx: Pick<Db, "execute"> = db,
  ) {
    try {
      await dbOrTx.execute(sql`
        update shared_service_engagements
        set advisor_kind = ${state.advisorKind},
            advisor_enabled = ${state.advisorEnabled}
        where id = ${engagementId}
      `);
    } catch (error) {
      if (isMissingAdvisorColumnError(error)) return;
      throw error;
    }
  }

  async function getRow(id: string, dbOrTx: DbSelectable = db) {
    const row = await dbOrTx
      .select()
      .from(sharedServiceEngagements)
      .where(eq(sharedServiceEngagements.id, id))
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
    return { ...row, ...(await getEngagementAdvisorState(id, dbOrTx)) };
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
    const advisorStateByEngagement = await listEngagementAdvisorState(engagementIds, dbOrTx);
    return rows.map((row) =>
      toEngagement(
        {
          ...row,
          ...(advisorStateByEngagement.get(row.id) ?? { advisorKind: null, advisorEnabled: false }),
        },
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
    listAdvisorTemplates: () => BUILTIN_ADVISOR_ENGAGEMENT_TEMPLATES.map(cloneEngagementTemplate),

    recommendSurface: (draft: AdvisorySurfaceRecommendationInput): AdvisorySurfaceRecommendation => {
      const text = [draft.title, draft.summary]
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .join(" ")
        .toLowerCase();
      const participantCount = new Set((draft.participantAgentIds ?? []).map((id) => id.trim()).filter(Boolean)).size;
      const matchedSignals: string[] = [];

      if (draft.requiresGovernance) matchedSignals.push("requires_governance");
      if (draft.requestsBoardAnswer) matchedSignals.push("requests_board_answer");
      if (draft.blocksExecution) matchedSignals.push("blocks_execution");
      if (draft.needsCrossFunctionalCoordination) matchedSignals.push("needs_cross_functional_coordination");
      if (participantCount > 1) matchedSignals.push("multiple_participants");
      if (includesKeyword(text, APPROVAL_KEYWORDS)) matchedSignals.push("approval_keywords");
      if (includesKeyword(text, DECISION_QUESTION_KEYWORDS)) matchedSignals.push("decision_keywords");
      if (includesKeyword(text, CONFERENCE_ROOM_KEYWORDS)) matchedSignals.push("conference_room_keywords");

      if (draft.requiresGovernance || includesKeyword(text, APPROVAL_KEYWORDS)) {
        return {
          recommendedSurface: "approval",
          reason: "Governed commitments and formal signoff requests should resolve through approvals.",
          matchedSignals,
        };
      }

      if (draft.requestsBoardAnswer || draft.blocksExecution || includesKeyword(text, DECISION_QUESTION_KEYWORDS)) {
        return {
          recommendedSurface: "decision_question",
          reason: "Blocking agent-to-board asks should use decision questions until formal signoff is required.",
          matchedSignals,
        };
      }

      if (
        draft.needsCrossFunctionalCoordination ||
        participantCount > 1 ||
        includesKeyword(text, CONFERENCE_ROOM_KEYWORDS)
      ) {
        return {
          recommendedSurface: "conference_room",
          reason: "Multi-party coordination belongs in conference rooms.",
          matchedSignals,
        };
      }

      return {
        recommendedSurface: "comment",
        reason: "Routine execution updates and narrow follow-ups should stay in issue comments.",
        matchedSignals,
      };
    },

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
        await persistEngagementAdvisorState(row.id, {
          advisorKind: input.advisorKind ?? null,
          advisorEnabled: input.advisorEnabled ?? false,
        }, tx);
        await syncAssignments(tx, row.id, companyId, input.assignedAgentIds ?? []);
        const engagement = await getRow(row.id, tx);
        if (!engagement) throw notFound("Shared-service engagement not found");
        const [hydrated] = await hydrate([engagement], tx);
        return hydrated!;
      });
    },

    update: async (id: string, input: UpdateSharedServiceEngagement) => {
      const existing = await getRow(id);
      if (!existing) return null;
      const nextAdvisorKind = input.advisorKind === undefined ? existing.advisorKind ?? null : input.advisorKind;
      const nextAdvisorEnabled = input.advisorEnabled ?? existing.advisorEnabled ?? false;
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
        await persistEngagementAdvisorState(id, {
          advisorKind: nextAdvisorKind,
          advisorEnabled: nextAdvisorEnabled,
        }, tx);
        if (input.assignedAgentIds) {
          await syncAssignments(tx, updated.id, updated.companyId, input.assignedAgentIds);
        }
        await reconcileConsultingScopes(updated.id, tx);
        const refreshed = await getRow(updated.id, tx);
        if (!refreshed) return null;
        const [engagement] = await hydrate([refreshed], tx);
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
