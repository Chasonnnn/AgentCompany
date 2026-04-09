import { and, desc, eq, inArray, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  approvals,
  conferenceRoomApprovals,
  conferenceRoomComments,
  conferenceRoomIssueLinks,
  conferenceRoomParticipants,
  conferenceRooms,
  issueApprovals,
  issues,
} from "@paperclipai/db";
import type {
  ConferenceRoom,
  ConferenceRoomComment,
  RequestBoardApprovalPayload,
  RequestConferenceRoomDecision,
  UpdateConferenceRoom,
  CreateConferenceRoom,
} from "@paperclipai/shared";
import { normalizeRequestBoardApprovalPayload } from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";
import { logActivity } from "./activity-log.js";
import { conferenceContextService } from "./conference-context.js";
import { heartbeatService } from "./heartbeat.js";

type ActorInfo = {
  actorType: "user" | "agent";
  actorId: string;
  agentId?: string | null;
  runId?: string | null;
};

function readTrimmed(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function approvalTitleSummary(payload: Record<string, unknown>) {
  return {
    title: readTrimmed(payload.title) ?? "Board decision",
    summary: readTrimmed(payload.summary) ?? "",
  };
}

export function conferenceRoomService(db: Db) {
  const heartbeat = heartbeatService(db);

  async function getRoomRow(id: string) {
    return db
      .select()
      .from(conferenceRooms)
      .where(eq(conferenceRooms.id, id))
      .then((rows) => rows[0] ?? null);
  }

  async function hasParticipant(roomId: string, agentId: string) {
    const row = await db
      .select({ id: conferenceRoomParticipants.id })
      .from(conferenceRoomParticipants)
      .where(and(eq(conferenceRoomParticipants.conferenceRoomId, roomId), eq(conferenceRoomParticipants.agentId, agentId)))
      .then((rows) => rows[0] ?? null);
    return Boolean(row);
  }

  async function assertIssueIds(companyId: string, issueIds: string[]) {
    if (issueIds.length === 0) return [];
    const uniqueIssueIds = Array.from(new Set(issueIds));
    const rows = await db
      .select()
      .from(issues)
      .where(inArray(issues.id, uniqueIssueIds));
    if (rows.length !== uniqueIssueIds.length) {
      throw notFound("One or more linked issues were not found");
    }
    for (const row of rows) {
      if (row.companyId !== companyId) {
        throw unprocessable("Linked issues must belong to the same company");
      }
    }
    return rows;
  }

  async function assertLeaderParticipants(companyId: string, participantAgentIds: string[]) {
    if (participantAgentIds.length === 0) return [];
    const uniqueAgentIds = Array.from(new Set(participantAgentIds));
    const rows = await db
      .select()
      .from(agents)
      .where(inArray(agents.id, uniqueAgentIds));
    if (rows.length !== uniqueAgentIds.length) {
      throw notFound("One or more participant agents were not found");
    }
    for (const row of rows) {
      if (row.companyId !== companyId) {
        throw unprocessable("Participants must belong to the same company");
      }
      if (row.status === "terminated") {
        throw unprocessable("Terminated agents cannot be invited");
      }
      if (
        row.operatingClass !== "executive" &&
        row.operatingClass !== "project_leadership" &&
        row.operatingClass !== "shared_service_lead"
      ) {
        throw unprocessable("Conference rooms only allow executive, project leadership, or shared-service lead participants");
      }
    }
    return rows;
  }

  async function hydrateRooms(rows: typeof conferenceRooms.$inferSelect[]): Promise<ConferenceRoom[]> {
    if (rows.length === 0) return [];
    const roomIds = rows.map((row) => row.id);

    const [participantRows, issueRows, decisionRows, commentRows] = await Promise.all([
      db
        .select()
        .from(conferenceRoomParticipants)
        .where(inArray(conferenceRoomParticipants.conferenceRoomId, roomIds)),
      db
        .select({
          roomId: conferenceRoomIssueLinks.conferenceRoomId,
          issueId: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          priority: issues.priority,
          createdAt: conferenceRoomIssueLinks.createdAt,
        })
        .from(conferenceRoomIssueLinks)
        .innerJoin(issues, eq(conferenceRoomIssueLinks.issueId, issues.id))
        .where(inArray(conferenceRoomIssueLinks.conferenceRoomId, roomIds)),
      db
        .select({
          roomId: conferenceRoomApprovals.conferenceRoomId,
          approvalId: approvals.id,
          status: approvals.status,
          requestedByAgentId: approvals.requestedByAgentId,
          requestedByUserId: approvals.requestedByUserId,
          payload: approvals.payload,
          createdAt: approvals.createdAt,
          updatedAt: approvals.updatedAt,
        })
        .from(conferenceRoomApprovals)
        .innerJoin(approvals, eq(conferenceRoomApprovals.approvalId, approvals.id))
        .where(inArray(conferenceRoomApprovals.conferenceRoomId, roomIds))
        .orderBy(desc(conferenceRoomApprovals.createdAt)),
      db
        .select({
          roomId: conferenceRoomComments.conferenceRoomId,
          createdAt: conferenceRoomComments.createdAt,
        })
        .from(conferenceRoomComments)
        .where(inArray(conferenceRoomComments.conferenceRoomId, roomIds)),
    ]);

    const participantsByRoom = new Map<string, typeof participantRows>();
    for (const participant of participantRows) {
      const group = participantsByRoom.get(participant.conferenceRoomId) ?? [];
      group.push(participant);
      participantsByRoom.set(participant.conferenceRoomId, group);
    }

    const issuesByRoom = new Map<string, typeof issueRows>();
    for (const issueRow of issueRows) {
      const group = issuesByRoom.get(issueRow.roomId) ?? [];
      group.push(issueRow);
      issuesByRoom.set(issueRow.roomId, group);
    }

    const decisionsByRoom = new Map<string, typeof decisionRows>();
    for (const decision of decisionRows) {
      const group = decisionsByRoom.get(decision.roomId) ?? [];
      group.push(decision);
      decisionsByRoom.set(decision.roomId, group);
    }

    const latestCommentAtByRoom = new Map<string, Date>();
    for (const comment of commentRows) {
      const current = latestCommentAtByRoom.get(comment.roomId);
      if (!current || comment.createdAt > current) {
        latestCommentAtByRoom.set(comment.roomId, comment.createdAt);
      }
    }

    return rows.map((room) => ({
      ...room,
      linkedIssues: (issuesByRoom.get(room.id) ?? []).map((issueRow) => ({
        issueId: issueRow.issueId,
        identifier: issueRow.identifier,
        title: issueRow.title,
        status: issueRow.status,
        priority: issueRow.priority,
        createdAt: issueRow.createdAt,
      })),
      participants: (participantsByRoom.get(room.id) ?? []).sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime()),
      decisions: (decisionsByRoom.get(room.id) ?? []).map((decision) => {
        const payload = approvalTitleSummary(decision.payload);
        return {
          approvalId: decision.approvalId,
          status: decision.status,
          requestedByAgentId: decision.requestedByAgentId,
          requestedByUserId: decision.requestedByUserId,
          title: payload.title,
          summary: payload.summary,
          createdAt: decision.createdAt,
          updatedAt: decision.updatedAt,
        };
      }),
      latestCommentAt: latestCommentAtByRoom.get(room.id) ?? null,
    })) as ConferenceRoom[];
  }

  async function wakeParticipants(
    roomId: string,
    companyId: string,
    agentIds: string[],
    actor: ActorInfo,
    issueIds: string[],
    title: string,
  ) {
    for (const agentId of agentIds) {
      try {
        await heartbeat.wakeup(agentId, {
          source: "automation",
          triggerDetail: "system",
          reason: "conference_room_invite",
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          payload: {
            conferenceRoomId: roomId,
            companyId,
            issueIds,
            title,
          },
          contextSnapshot: {
            source: "conference_room.invite",
            conferenceRoomId: roomId,
            issueIds,
          },
        });
      } catch {
        // Room creation/update should not fail because an invite wakeup could not be queued.
      }
    }
  }

  return {
    getById: async (id: string) => {
      const row = await getRoomRow(id);
      if (!row) return null;
      const [room] = await hydrateRooms([row]);
      return room ?? null;
    },

    hasParticipant,

    listForCompany: async (companyId: string) => {
      const rows = await db
        .select()
        .from(conferenceRooms)
        .where(eq(conferenceRooms.companyId, companyId))
        .orderBy(desc(conferenceRooms.updatedAt));
      return hydrateRooms(rows);
    },

    listForAgent: async (companyId: string, agentId: string) => {
      const rows = await db
        .select({
          id: conferenceRooms.id,
          companyId: conferenceRooms.companyId,
          title: conferenceRooms.title,
          summary: conferenceRooms.summary,
          agenda: conferenceRooms.agenda,
          status: conferenceRooms.status,
          createdByAgentId: conferenceRooms.createdByAgentId,
          createdByUserId: conferenceRooms.createdByUserId,
          createdAt: conferenceRooms.createdAt,
          updatedAt: conferenceRooms.updatedAt,
        })
        .from(conferenceRoomParticipants)
        .innerJoin(conferenceRooms, eq(conferenceRoomParticipants.conferenceRoomId, conferenceRooms.id))
        .where(
          and(
            eq(conferenceRoomParticipants.companyId, companyId),
            eq(conferenceRoomParticipants.agentId, agentId),
            ne(conferenceRooms.status, "archived"),
          ),
        )
        .orderBy(desc(conferenceRooms.updatedAt));
      return hydrateRooms(rows);
    },

    listForIssue: async (issueId: string) => {
      const rows = await db
        .select({
          id: conferenceRooms.id,
          companyId: conferenceRooms.companyId,
          title: conferenceRooms.title,
          summary: conferenceRooms.summary,
          agenda: conferenceRooms.agenda,
          status: conferenceRooms.status,
          createdByAgentId: conferenceRooms.createdByAgentId,
          createdByUserId: conferenceRooms.createdByUserId,
          createdAt: conferenceRooms.createdAt,
          updatedAt: conferenceRooms.updatedAt,
        })
        .from(conferenceRoomIssueLinks)
        .innerJoin(conferenceRooms, eq(conferenceRoomIssueLinks.conferenceRoomId, conferenceRooms.id))
        .where(eq(conferenceRoomIssueLinks.issueId, issueId))
        .orderBy(desc(conferenceRooms.updatedAt));
      return hydrateRooms(rows);
    },

    create: async (companyId: string, input: CreateConferenceRoom, actor: ActorInfo) => {
      const issuesForRoom = await assertIssueIds(companyId, input.issueIds);
      const participants = await assertLeaderParticipants(companyId, input.participantAgentIds);
      const now = new Date();

      const created = await db.transaction(async (tx) => {
        const room = await tx
          .insert(conferenceRooms)
          .values({
            companyId,
            title: input.title,
            summary: input.summary,
            agenda: input.agenda ?? null,
            status: "open",
            createdByAgentId: actor.agentId ?? null,
            createdByUserId: actor.actorType === "user" ? actor.actorId : null,
            updatedAt: now,
          })
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!room) {
          throw unprocessable("Unable to create conference room");
        }

        if (issuesForRoom.length > 0) {
          await tx.insert(conferenceRoomIssueLinks).values(
            issuesForRoom.map((issue) => ({
              companyId,
              conferenceRoomId: room.id,
              issueId: issue.id,
              linkedByAgentId: actor.agentId ?? null,
              linkedByUserId: actor.actorType === "user" ? actor.actorId : null,
            })),
          );
        }

        if (participants.length > 0) {
          await tx.insert(conferenceRoomParticipants).values(
            participants.map((participant) => ({
              companyId,
              conferenceRoomId: room.id,
              agentId: participant.id,
              addedByAgentId: actor.agentId ?? null,
              addedByUserId: actor.actorType === "user" ? actor.actorId : null,
              updatedAt: now,
            })),
          );
        }

        await logActivity(tx as unknown as Db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId ?? null,
          runId: actor.runId ?? null,
          action: "conference_room.created",
          entityType: "conference_room",
          entityId: room.id,
          details: {
            issueIds: issuesForRoom.map((issue) => issue.id),
            participantAgentIds: participants.map((participant) => participant.id),
          },
        });

        return room;
      });

      await wakeParticipants(
        created.id,
        companyId,
        participants.map((participant) => participant.id),
        actor,
        issuesForRoom.map((issue) => issue.id),
        created.title,
      );

      const [room] = await hydrateRooms([created]);
      return room ?? null;
    },

    update: async (roomId: string, input: UpdateConferenceRoom, actor: ActorInfo) => {
      const existing = await getRoomRow(roomId);
      if (!existing) throw notFound("Conference room not found");

      const nextIssueIds = input.issueIds !== undefined
        ? (await assertIssueIds(existing.companyId, input.issueIds)).map((issue) => issue.id)
        : null;
      const nextParticipants = input.participantAgentIds !== undefined
        ? await assertLeaderParticipants(existing.companyId, input.participantAgentIds)
        : null;
      const now = new Date();

      const previousParticipants = await db
        .select({ agentId: conferenceRoomParticipants.agentId })
        .from(conferenceRoomParticipants)
        .where(eq(conferenceRoomParticipants.conferenceRoomId, roomId));
      const previousParticipantIds = new Set(previousParticipants.map((row) => row.agentId));

      const updated = await db.transaction(async (tx) => {
        const room = await tx
          .update(conferenceRooms)
          .set({
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.summary !== undefined ? { summary: input.summary } : {}),
            ...(input.agenda !== undefined ? { agenda: input.agenda ?? null } : {}),
            ...(input.status !== undefined ? { status: input.status } : {}),
            updatedAt: now,
          })
          .where(eq(conferenceRooms.id, roomId))
          .returning()
          .then((rows) => rows[0] ?? null);

        if (!room) throw notFound("Conference room not found");

        if (nextIssueIds !== null) {
          await tx.delete(conferenceRoomIssueLinks).where(eq(conferenceRoomIssueLinks.conferenceRoomId, roomId));
          if (nextIssueIds.length > 0) {
            await tx.insert(conferenceRoomIssueLinks).values(
              nextIssueIds.map((issueId) => ({
                companyId: room.companyId,
                conferenceRoomId: roomId,
                issueId,
                linkedByAgentId: actor.agentId ?? null,
                linkedByUserId: actor.actorType === "user" ? actor.actorId : null,
              })),
            );
          }
        }

        if (nextParticipants !== null) {
          await tx.delete(conferenceRoomParticipants).where(eq(conferenceRoomParticipants.conferenceRoomId, roomId));
          if (nextParticipants.length > 0) {
            await tx.insert(conferenceRoomParticipants).values(
              nextParticipants.map((participant) => ({
                companyId: room.companyId,
                conferenceRoomId: roomId,
                agentId: participant.id,
                addedByAgentId: actor.agentId ?? null,
                addedByUserId: actor.actorType === "user" ? actor.actorId : null,
                updatedAt: now,
              })),
            );
          }
        }

        await logActivity(tx as unknown as Db, {
          companyId: room.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId ?? null,
          runId: actor.runId ?? null,
          action: "conference_room.updated",
          entityType: "conference_room",
          entityId: room.id,
          details: {
            updatedFields: Object.keys(input),
            issueIds: nextIssueIds ?? undefined,
            participantAgentIds: nextParticipants?.map((participant) => participant.id),
          },
        });

        return room;
      });

      const participantIdsToWake = nextParticipants
        ? nextParticipants
            .map((participant) => participant.id)
            .filter((participantId) => !previousParticipantIds.has(participantId))
        : [];

      if (participantIdsToWake.length > 0) {
        const linkedIssueIds = nextIssueIds ?? (
          await db
            .select({ issueId: conferenceRoomIssueLinks.issueId })
            .from(conferenceRoomIssueLinks)
            .where(eq(conferenceRoomIssueLinks.conferenceRoomId, roomId))
        ).map((row) => row.issueId);
        await wakeParticipants(roomId, updated.companyId, participantIdsToWake, actor, linkedIssueIds, updated.title);
      }

      const [room] = await hydrateRooms([updated]);
      return room ?? null;
    },

    listComments: async (roomId: string): Promise<ConferenceRoomComment[]> =>
      db
        .select()
        .from(conferenceRoomComments)
        .where(eq(conferenceRoomComments.conferenceRoomId, roomId))
        .orderBy(conferenceRoomComments.createdAt)
        .then((rows) => rows.map((row) => ({ ...row }))),

    addComment: async (roomId: string, body: string, actor: ActorInfo) => {
      const room = await getRoomRow(roomId);
      if (!room) throw notFound("Conference room not found");
      const comment = await db
        .insert(conferenceRoomComments)
        .values({
          companyId: room.companyId,
          conferenceRoomId: roomId,
          authorAgentId: actor.agentId ?? null,
          authorUserId: actor.actorType === "user" ? actor.actorId : null,
          body,
        })
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!comment) throw unprocessable("Unable to add conference room comment");

      await db
        .update(conferenceRooms)
        .set({ updatedAt: new Date() })
        .where(eq(conferenceRooms.id, roomId));

      await logActivity(db, {
        companyId: room.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId ?? null,
        runId: actor.runId ?? null,
        action: "conference_room.comment_added",
        entityType: "conference_room",
        entityId: roomId,
        details: {},
      });

      return comment;
    },

    requestBoardDecision: async (roomId: string, input: RequestConferenceRoomDecision, actor: ActorInfo) => {
      const room = await getRoomRow(roomId);
      if (!room) throw notFound("Conference room not found");

      const linkedIssues = await db
        .select({
          id: issues.id,
          companyId: issues.companyId,
          projectId: issues.projectId,
          projectWorkspaceId: issues.projectWorkspaceId,
          goalId: issues.goalId,
          parentId: issues.parentId,
          title: issues.title,
          description: issues.description,
          status: issues.status,
          priority: issues.priority,
          assigneeAgentId: issues.assigneeAgentId,
          assigneeUserId: issues.assigneeUserId,
          checkoutRunId: issues.checkoutRunId,
          executionRunId: issues.executionRunId,
          executionAgentNameKey: issues.executionAgentNameKey,
          executionLockedAt: issues.executionLockedAt,
          createdByAgentId: issues.createdByAgentId,
          createdByUserId: issues.createdByUserId,
          issueNumber: issues.issueNumber,
          identifier: issues.identifier,
          originKind: issues.originKind,
          originId: issues.originId,
          originRunId: issues.originRunId,
          requestDepth: issues.requestDepth,
          billingCode: issues.billingCode,
          assigneeAdapterOverrides: issues.assigneeAdapterOverrides,
          executionPolicy: issues.executionPolicy,
          executionState: issues.executionState,
          executionWorkspaceId: issues.executionWorkspaceId,
          executionWorkspacePreference: issues.executionWorkspacePreference,
          executionWorkspaceSettings: issues.executionWorkspaceSettings,
          startedAt: issues.startedAt,
          completedAt: issues.completedAt,
          cancelledAt: issues.cancelledAt,
          hiddenAt: issues.hiddenAt,
          createdAt: issues.createdAt,
          updatedAt: issues.updatedAt,
        })
        .from(conferenceRoomIssueLinks)
        .innerJoin(issues, eq(conferenceRoomIssueLinks.issueId, issues.id))
        .where(eq(conferenceRoomIssueLinks.conferenceRoomId, roomId));

      const primaryIssue = linkedIssues.length === 1 ? linkedIssues[0]! : null;

      return db.transaction(async (tx) => {
        const repoContext = primaryIssue
          ? await conferenceContextService(tx as unknown as Db).resolveForIssue(primaryIssue.id)
          : null;
        const normalizedPayload = normalizeRequestBoardApprovalPayload({
          conferenceRoomId: roomId,
          title: input.title,
          summary: input.summary,
          recommendedAction: input.recommendedAction,
          nextActionOnApproval: input.nextActionOnApproval,
          risks: input.risks,
          proposedComment: input.proposedComment,
          ...(repoContext ? { repoContext } : {}),
        });
        const payload: RequestBoardApprovalPayload = normalizedPayload;
        const approval = await tx
          .insert(approvals)
          .values({
            companyId: room.companyId,
            type: "request_board_approval",
            requestedByAgentId: actor.agentId ?? null,
            requestedByUserId: actor.actorType === "user" ? actor.actorId : null,
            status: "pending",
            payload,
            decisionNote: null,
            decidedByUserId: null,
            decidedAt: null,
            updatedAt: new Date(),
          })
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!approval) throw unprocessable("Unable to create board decision request");

        await tx.insert(conferenceRoomApprovals).values({
          companyId: room.companyId,
          conferenceRoomId: roomId,
          approvalId: approval.id,
          linkedByAgentId: actor.agentId ?? null,
          linkedByUserId: actor.actorType === "user" ? actor.actorId : null,
        });

        if (linkedIssues.length > 0) {
          await tx.insert(issueApprovals).values(
            linkedIssues.map((issue) => ({
              companyId: room.companyId,
              issueId: issue.id,
              approvalId: approval.id,
              linkedByAgentId: actor.agentId ?? null,
              linkedByUserId: actor.actorType === "user" ? actor.actorId : null,
            })),
          ).onConflictDoNothing();
        }

        await tx
          .update(conferenceRooms)
          .set({ updatedAt: new Date() })
          .where(eq(conferenceRooms.id, roomId));

        await logActivity(tx as unknown as Db, {
          companyId: room.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId ?? null,
          runId: actor.runId ?? null,
          action: "conference_room.board_decision_requested",
          entityType: "conference_room",
          entityId: roomId,
          details: {
            approvalId: approval.id,
            issueIds: linkedIssues.map((issue) => issue.id),
          },
        });

        return approval;
      });
    },
  };
}
