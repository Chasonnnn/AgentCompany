import { and, asc, desc, eq, ne, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agents,
  companySkills,
  issues,
  projects,
  sharedServiceEngagements,
  sharedSkillProposals,
  sharedSkills,
} from "@paperclipai/db";

const OFFICE_OPERATOR_ARCHETYPE_KEY = "chief_of_staff";
const OPEN_SHARED_SKILL_PROPOSAL_STATUSES = ["pending", "revision_requested"] as const;
const MAX_QUEUE_ITEMS = 8;
const MAX_RECENT_ACTIONS = 10;

type OfficeCoordinationTrigger = {
  reason: string;
  entityType?: string | null;
  entityId?: string | null;
  summary?: string | null;
};

type OfficeCoordinationIssueItem = {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
  projectId: string | null;
  projectName: string | null;
  updatedAt: string;
};

type OfficeCoordinationStaffingGap = {
  projectId: string;
  projectName: string;
  missingRoles: string[];
  openIssueCount: number;
};

type OfficeCoordinationEngagementItem = {
  id: string;
  title: string;
  serviceAreaKey: string;
  status: string;
  targetProjectId: string;
  targetProjectName: string | null;
  updatedAt: string;
};

type OfficeCoordinationSharedSkillItem = {
  sharedSkillId: string;
  key: string;
  name: string;
  mirrorState: string;
  sourceDriftState: string;
  openProposalId: string | null;
  openProposalStatus: string | null;
  openProposalSummary: string | null;
};

type OfficeCoordinationRecentAction = {
  action: string;
  entityType: string;
  entityId: string;
  summary: string | null;
  createdAt: string;
};

type OfficeCoordinationSnapshot = {
  companyId: string;
  officeAgentId: string;
  trigger: OfficeCoordinationTrigger | null;
  queueCounts: {
    untriagedIntake: number;
    unassignedIssues: number;
    blockedIssues: number;
    staleIssues: number;
    staffingGaps: number;
    engagementsNeedingAttention: number;
    sharedSkillItems: number;
  };
  untriagedIntake: OfficeCoordinationIssueItem[];
  unassignedIssues: OfficeCoordinationIssueItem[];
  blockedIssues: OfficeCoordinationIssueItem[];
  staleIssues: OfficeCoordinationIssueItem[];
  staffingGaps: OfficeCoordinationStaffingGap[];
  engagementsNeedingAttention: OfficeCoordinationEngagementItem[];
  sharedSkillItems: OfficeCoordinationSharedSkillItem[];
  recentActions: OfficeCoordinationRecentAction[];
};

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asString(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function summarizeActivity(details: unknown) {
  const record = asRecord(details);
  return (
    asString(record.summary)
    ?? asString(record.identifier)
    ?? asString(record.title)
    ?? asString(record.name)
    ?? asString(record.issueTitle)
    ?? asString(record.outcomeSummary)
    ?? null
  );
}

function isOfficeOperatorRow(row: {
  role: string;
  archetypeKey: string | null;
  status: string;
}) {
  if (row.status === "terminated") return false;
  return row.role === "coo" || row.archetypeKey === OFFICE_OPERATOR_ARCHETYPE_KEY;
}

function toIssueItem(row: {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
  projectId: string | null;
  projectName: string | null;
  updatedAt: Date;
}): OfficeCoordinationIssueItem {
  return {
    id: row.id,
    identifier: row.identifier,
    title: row.title,
    status: row.status,
    priority: row.priority,
    projectId: row.projectId,
    projectName: row.projectName,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function officeCoordinationService(db: Db) {
  async function findOfficeOperator(companyId: string) {
    const rows = await db
      .select()
      .from(agents)
      .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated")))
      .orderBy(asc(agents.createdAt), asc(agents.name));
    return rows.find((row) => isOfficeOperatorRow(row)) ?? null;
  }

  async function isOfficeOperatorAgent(agentId: string, companyId: string) {
    const row = await db
      .select({
        id: agents.id,
        companyId: agents.companyId,
        role: agents.role,
        archetypeKey: agents.archetypeKey,
        status: agents.status,
      })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
    if (!row || row.companyId !== companyId) return false;
    return isOfficeOperatorRow(row);
  }

  async function buildWakeSnapshot(input: {
    companyId: string;
    officeAgentId: string;
    trigger?: OfficeCoordinationTrigger | null;
  }): Promise<OfficeCoordinationSnapshot> {
    const continuityHealthExpr = sql<string | null>`${issues.continuityState} ->> 'health'`;
    const openIssueRows = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        priority: issues.priority,
        parentId: issues.parentId,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        projectId: issues.projectId,
        projectName: projects.name,
        continuityHealth: continuityHealthExpr,
        updatedAt: issues.updatedAt,
      })
      .from(issues)
      .leftJoin(projects, eq(projects.id, issues.projectId))
      .where(
        and(
          eq(issues.companyId, input.companyId),
          ne(issues.status, "done"),
          ne(issues.status, "cancelled"),
        ),
      )
      .orderBy(desc(issues.updatedAt));

    const untriagedIntakeRows = openIssueRows.filter(
      (row) =>
        !row.assigneeAgentId
        && !row.assigneeUserId
        && row.parentId == null
        && (row.status === "backlog" || row.status === "todo"),
    );
    const unassignedIssueRows = openIssueRows.filter(
      (row) =>
        !row.assigneeAgentId
        && !row.assigneeUserId
        && !(
          row.parentId == null
          && (row.status === "backlog" || row.status === "todo")
        ),
    );
    const blockedIssueRows = openIssueRows.filter((row) => row.status === "blocked");
    const staleIssueRows = openIssueRows.filter((row) => row.continuityHealth === "stale_progress");

    const activeProjects = await db
      .select({
        id: projects.id,
        name: projects.name,
        status: projects.status,
        leadAgentId: projects.leadAgentId,
      })
      .from(projects)
      .where(
        and(
          eq(projects.companyId, input.companyId),
          ne(projects.status, "completed"),
          ne(projects.status, "cancelled"),
        ),
      )
      .orderBy(asc(projects.name));

    const issueCountsByProject = new Map<
      string,
      { openIssueCount: number; assignedIssueCount: number }
    >();
    for (const row of openIssueRows) {
      if (!row.projectId) continue;
      const current = issueCountsByProject.get(row.projectId) ?? {
        openIssueCount: 0,
        assignedIssueCount: 0,
      };
      current.openIssueCount += 1;
      if (row.assigneeAgentId || row.assigneeUserId) {
        current.assignedIssueCount += 1;
      }
      issueCountsByProject.set(row.projectId, current);
    }

    const staffingGaps = activeProjects
      .map((project) => {
        const counts = issueCountsByProject.get(project.id) ?? {
          openIssueCount: 0,
          assignedIssueCount: 0,
        };
        const missingRoles: string[] = [];
        if (!project.leadAgentId) {
          missingRoles.push("project_lead");
        }
        if (counts.openIssueCount > 0 && counts.assignedIssueCount === 0) {
          missingRoles.push("continuity_owner");
        }
        if (missingRoles.length === 0) return null;
        return {
          projectId: project.id,
          projectName: project.name,
          missingRoles,
          openIssueCount: counts.openIssueCount,
        } satisfies OfficeCoordinationStaffingGap;
      })
      .filter((entry): entry is OfficeCoordinationStaffingGap => Boolean(entry));

    const engagementRows = await db
      .select({
        id: sharedServiceEngagements.id,
        title: sharedServiceEngagements.title,
        serviceAreaKey: sharedServiceEngagements.serviceAreaKey,
        status: sharedServiceEngagements.status,
        targetProjectId: sharedServiceEngagements.targetProjectId,
        targetProjectName: projects.name,
        updatedAt: sharedServiceEngagements.updatedAt,
      })
      .from(sharedServiceEngagements)
      .leftJoin(projects, eq(projects.id, sharedServiceEngagements.targetProjectId))
      .where(
        and(
          eq(sharedServiceEngagements.companyId, input.companyId),
          ne(sharedServiceEngagements.status, "closed"),
        ),
      )
      .orderBy(desc(sharedServiceEngagements.updatedAt));

    const attachedSharedSkillRows = await db
      .select({
        sharedSkillId: sharedSkills.id,
        key: sharedSkills.key,
        name: sharedSkills.name,
        mirrorState: sharedSkills.mirrorState,
        sourceDriftState: sharedSkills.sourceDriftState,
      })
      .from(companySkills)
      .innerJoin(sharedSkills, eq(companySkills.sharedSkillId, sharedSkills.id))
      .where(
        and(
          eq(companySkills.companyId, input.companyId),
          eq(companySkills.sourceType, "shared_mirror"),
        ),
      )
      .orderBy(asc(sharedSkills.name));
    const sharedSkillIds = attachedSharedSkillRows.map((row) => row.sharedSkillId);
    const proposalRows = sharedSkillIds.length === 0
      ? []
      : await db
          .select({
            id: sharedSkillProposals.id,
            sharedSkillId: sharedSkillProposals.sharedSkillId,
            status: sharedSkillProposals.status,
            summary: sharedSkillProposals.summary,
            createdAt: sharedSkillProposals.createdAt,
          })
          .from(sharedSkillProposals)
          .where(
            and(
              or(...sharedSkillIds.map((id) => eq(sharedSkillProposals.sharedSkillId, id))),
              or(
                ...OPEN_SHARED_SKILL_PROPOSAL_STATUSES.map((status) =>
                  eq(sharedSkillProposals.status, status),
                ),
              ),
            ),
          )
          .orderBy(desc(sharedSkillProposals.createdAt));

    const firstOpenProposalBySkill = new Map<
      string,
      {
        id: string;
        status: string;
        summary: string;
      }
    >();
    for (const row of proposalRows) {
      if (firstOpenProposalBySkill.has(row.sharedSkillId)) continue;
      firstOpenProposalBySkill.set(row.sharedSkillId, {
        id: row.id,
        status: row.status,
        summary: row.summary,
      });
    }

    const sharedSkillItems = attachedSharedSkillRows
      .map((row) => {
        const openProposal = firstOpenProposalBySkill.get(row.sharedSkillId) ?? null;
        if (row.sourceDriftState === "in_sync" && !openProposal) return null;
        return {
          sharedSkillId: row.sharedSkillId,
          key: row.key,
          name: row.name,
          mirrorState: row.mirrorState,
          sourceDriftState: row.sourceDriftState,
          openProposalId: openProposal?.id ?? null,
          openProposalStatus: openProposal?.status ?? null,
          openProposalSummary: openProposal?.summary ?? null,
        } satisfies OfficeCoordinationSharedSkillItem;
      })
      .filter((entry): entry is OfficeCoordinationSharedSkillItem => Boolean(entry));

    const recentActionRows = await db
      .select({
        action: activityLog.action,
        entityType: activityLog.entityType,
        entityId: activityLog.entityId,
        details: activityLog.details,
        createdAt: activityLog.createdAt,
      })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, input.companyId),
          eq(activityLog.agentId, input.officeAgentId),
        ),
      )
      .orderBy(desc(activityLog.createdAt))
      .limit(MAX_RECENT_ACTIONS);

    return {
      companyId: input.companyId,
      officeAgentId: input.officeAgentId,
      trigger: input.trigger ?? null,
      queueCounts: {
        untriagedIntake: untriagedIntakeRows.length,
        unassignedIssues: unassignedIssueRows.length,
        blockedIssues: blockedIssueRows.length,
        staleIssues: staleIssueRows.length,
        staffingGaps: staffingGaps.length,
        engagementsNeedingAttention: engagementRows.length,
        sharedSkillItems: sharedSkillItems.length,
      },
      untriagedIntake: untriagedIntakeRows.slice(0, MAX_QUEUE_ITEMS).map(toIssueItem),
      unassignedIssues: unassignedIssueRows.slice(0, MAX_QUEUE_ITEMS).map(toIssueItem),
      blockedIssues: blockedIssueRows.slice(0, MAX_QUEUE_ITEMS).map(toIssueItem),
      staleIssues: staleIssueRows.slice(0, MAX_QUEUE_ITEMS).map(toIssueItem),
      staffingGaps: staffingGaps.slice(0, MAX_QUEUE_ITEMS),
      engagementsNeedingAttention: engagementRows.slice(0, MAX_QUEUE_ITEMS).map((row) => ({
        id: row.id,
        title: row.title,
        serviceAreaKey: row.serviceAreaKey,
        status: row.status,
        targetProjectId: row.targetProjectId,
        targetProjectName: row.targetProjectName,
        updatedAt: row.updatedAt.toISOString(),
      })),
      sharedSkillItems: sharedSkillItems.slice(0, MAX_QUEUE_ITEMS),
      recentActions: recentActionRows.map((row) => ({
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        summary: summarizeActivity(row.details),
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  return {
    findOfficeOperator,
    isOfficeOperatorAgent,
    buildWakeSnapshot,
  };
}
