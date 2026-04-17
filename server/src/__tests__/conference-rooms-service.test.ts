import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  conferenceRoomApprovals,
  conferenceRoomComments,
  conferenceRoomIssueLinks,
  conferenceRoomParticipants,
  conferenceRoomQuestionResponses,
  conferenceRooms,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
}));

vi.mock("../services/heartbeat.ts", () => ({
  heartbeatService: () => mockHeartbeatService,
}));

import { conferenceRoomService } from "../services/conference-rooms.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres conference room service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type ActorInfo = {
  actorType: "user" | "agent";
  actorId: string;
  agentId?: string | null;
  runId?: string | null;
};

type AgentSeed = {
  id?: string;
  name?: string;
  role?: string;
  title?: string | null;
  status?: string;
  orgLevel?: "executive" | "director" | "staff";
  operatingClass?: "board" | "manager" | "worker";
  capabilityProfileKey?: string;
  departmentKey?: string;
  adapterType?: string;
  adapterConfig?: Record<string, unknown>;
  runtimeConfig?: Record<string, unknown>;
  permissions?: Record<string, unknown>;
};

const boardActor: ActorInfo = {
  actorType: "user",
  actorId: "board-user",
  agentId: null,
  runId: null,
};

describeEmbeddedPostgres("conferenceRoomService", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof conferenceRoomService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-conference-rooms-");
    db = createDb(tempDb.connectionString);
    svc = conferenceRoomService(db);
  }, 20_000);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await db.delete(conferenceRoomApprovals);
    await db.delete(agentWakeupRequests);
    await db.delete(conferenceRoomQuestionResponses);
    await db.delete(conferenceRoomComments);
    await db.delete(conferenceRoomIssueLinks);
    await db.delete(conferenceRoomParticipants);
    await db.delete(conferenceRooms);
    await db.delete(activityLog);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, overrides: AgentSeed = {}) {
    const agentId = overrides.id ?? randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: overrides.name ?? `Agent-${agentId.slice(0, 6)}`,
      role: overrides.role ?? "engineer",
      title: overrides.title ?? null,
      status: overrides.status ?? "active",
      orgLevel: overrides.orgLevel ?? "staff",
      operatingClass: overrides.operatingClass ?? "worker",
      capabilityProfileKey: overrides.capabilityProfileKey ?? "worker",
      departmentKey: overrides.departmentKey ?? "engineering",
      adapterType: overrides.adapterType ?? "codex_local",
      adapterConfig: overrides.adapterConfig ?? {},
      runtimeConfig: overrides.runtimeConfig ?? {},
      permissions: overrides.permissions ?? {},
    });
    return agentId;
  }

  async function createRoom(companyId: string, participantAgentIds: string[]) {
    const room = await svc.create(companyId, {
      title: "Onboarding Meeting",
      summary: "Kickoff room",
      agenda: "checklist",
      kind: "project_leadership",
      issueIds: [],
      participantAgentIds,
    }, boardActor);
    if (!room) throw new Error("Room creation failed");
    return room;
  }

  it("allows inviting non-leader agents and wakes them on room creation", async () => {
    const companyId = await seedCompany();
    const workerId = await seedAgent(companyId, { name: "Worker Agent", orgLevel: "staff", operatingClass: "worker" });

    const room = await createRoom(companyId, [workerId]);

    expect(room.participants.map((participant) => participant.agentId)).toEqual([workerId]);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      workerId,
      expect.objectContaining({
        reason: "conference_room_invite",
        payload: expect.objectContaining({
          conferenceRoomId: room.id,
          title: room.title,
        }),
        contextSnapshot: expect.objectContaining({
          conferenceRoomId: room.id,
          taskKey: `conference-room:${room.id}`,
          source: "conference_room.invite",
        }),
      }),
    );
  });

  it("creates pending responses and wakes all invitees for board questions", async () => {
    const companyId = await seedCompany();
    const agentOneId = await seedAgent(companyId, { name: "Technical Project Lead" });
    const agentTwoId = await seedAgent(companyId, { name: "CEO" });
    const room = await createRoom(companyId, [agentOneId, agentTwoId]);
    mockHeartbeatService.wakeup.mockClear();

    const question = await svc.addComment(room.id, {
      body: "How do you feel about the audit?",
      messageType: "question",
    }, boardActor);

    expect(question.messageType).toBe("question");
    expect(question.responses).toHaveLength(2);
    expect(question.responses.map((response) => response.status)).toEqual(["pending", "pending"]);

    const storedResponses = await db
      .select()
      .from(conferenceRoomQuestionResponses)
      .where(eq(conferenceRoomQuestionResponses.questionCommentId, question.id));

    expect(storedResponses).toHaveLength(2);
    expect(storedResponses.map((response) => response.status)).toEqual(["pending", "pending"]);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(2);
    expect(mockHeartbeatService.wakeup).toHaveBeenNthCalledWith(
      1,
      agentOneId,
      expect.objectContaining({
        reason: "conference_room_question",
        payload: expect.objectContaining({
          conferenceRoomId: room.id,
          conferenceRoomCommentId: question.id,
          messageType: "question",
        }),
      }),
    );
    expect(mockHeartbeatService.wakeup).toHaveBeenNthCalledWith(
      2,
      agentTwoId,
      expect.objectContaining({
        reason: "conference_room_question",
        payload: expect.objectContaining({
          conferenceRoomId: room.id,
          conferenceRoomCommentId: question.id,
          messageType: "question",
        }),
      }),
    );
  });

  it("does not create response obligations or wakes for board notes", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, { name: "Technical Project Lead" });
    const room = await createRoom(companyId, [agentId]);
    mockHeartbeatService.wakeup.mockClear();

    const note = await svc.addComment(room.id, {
      body: "General note for the room.",
      messageType: "note",
    }, boardActor);

    expect(note.messageType).toBe("note");
    expect(note.responses).toEqual([]);
    expect(await db.select().from(conferenceRoomQuestionResponses)).toEqual([]);
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("marks only the replying agent as replied when they answer under a question thread", async () => {
    const companyId = await seedCompany();
    const agentOneId = await seedAgent(companyId, { name: "Technical Project Lead" });
    const agentTwoId = await seedAgent(companyId, { name: "CEO" });
    const room = await createRoom(companyId, [agentOneId, agentTwoId]);
    const question = await svc.addComment(room.id, {
      body: "Where do you stand on the audit?",
      messageType: "question",
    }, boardActor);
    mockHeartbeatService.wakeup.mockClear();

    const reply = await svc.addComment(room.id, {
      body: "I support the direction.",
      parentCommentId: question.id,
      messageType: "note",
    }, {
      actorType: "agent",
      actorId: agentOneId,
      agentId: agentOneId,
      runId: null,
    });

    const responses = await db
      .select()
      .from(conferenceRoomQuestionResponses)
      .where(eq(conferenceRoomQuestionResponses.questionCommentId, question.id));

    const byAgentId = new Map(responses.map((response) => [response.agentId, response]));
    expect(byAgentId.get(agentOneId)?.status).toBe("replied");
    expect(byAgentId.get(agentOneId)?.repliedCommentId).toBe(reply.id);
    expect(byAgentId.get(agentTwoId)?.status).toBe("pending");
    expect(byAgentId.get(agentTwoId)?.repliedCommentId).toBeNull();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("hydrates the latest room wake failure alongside pending question responses", async () => {
    const companyId = await seedCompany();
    const agentOneId = await seedAgent(companyId, { name: "Technical Project Lead" });
    const agentTwoId = await seedAgent(companyId, { name: "CEO" });
    const room = await createRoom(companyId, [agentOneId, agentTwoId]);
    const question = await svc.addComment(room.id, {
      body: "Please reply in-thread.",
      messageType: "question",
    }, boardActor);

    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId: agentOneId,
      source: "automation",
      triggerDetail: "system",
      reason: "conference_room_question",
      payload: {
        conferenceRoomId: room.id,
        conferenceRoomCommentId: question.id,
        messageType: "question",
      },
      status: "failed",
      error: "Your access token could not be refreshed. Please log out and sign in again.",
    });

    const comments = await svc.listComments(room.id);
    const hydratedQuestion = comments.find((comment) => comment.id === question.id);

    expect(hydratedQuestion?.responses.find((response) => response.agentId === agentOneId)).toEqual(
      expect.objectContaining({
        status: "pending",
        latestWakeStatus: "failed",
        latestWakeError: "Your access token could not be refreshed. Please log out and sign in again.",
      }),
    );
    expect(hydratedQuestion?.responses.find((response) => response.agentId === agentTwoId)).toEqual(
      expect.objectContaining({
        status: "pending",
        latestWakeStatus: null,
        latestWakeError: null,
      }),
    );
  });

  it("wakes the other invited agents when an agent posts a new top-level note", async () => {
    const companyId = await seedCompany();
    const senderId = await seedAgent(companyId, { name: "Technical Project Lead" });
    const peerOneId = await seedAgent(companyId, { name: "CEO" });
    const peerTwoId = await seedAgent(companyId, { name: "Staff Engineer" });
    const room = await createRoom(companyId, [senderId, peerOneId, peerTwoId]);
    mockHeartbeatService.wakeup.mockClear();

    const note = await svc.addComment(room.id, {
      body: "New issue found in the kickoff plan.",
      messageType: "note",
    }, {
      actorType: "agent",
      actorId: senderId,
      agentId: senderId,
      runId: null,
    });

    expect(note.parentCommentId).toBeNull();
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(2);
    const wokenAgentIds = new Set(mockHeartbeatService.wakeup.mock.calls.map((call) => call[0]));
    expect(wokenAgentIds).toEqual(new Set([peerOneId, peerTwoId]));
    for (const [, wake] of mockHeartbeatService.wakeup.mock.calls) {
      expect(wake).toEqual(expect.objectContaining({
        reason: "conference_room_message",
        payload: expect.objectContaining({
          conferenceRoomId: room.id,
          conferenceRoomCommentId: note.id,
          messageType: "note",
        }),
      }));
    }
  });

  it("dismisses unresolved question responses when the room closes", async () => {
    const companyId = await seedCompany();
    const agentOneId = await seedAgent(companyId, { name: "Technical Project Lead" });
    const agentTwoId = await seedAgent(companyId, { name: "CEO" });
    const room = await createRoom(companyId, [agentOneId, agentTwoId]);
    const question = await svc.addComment(room.id, {
      body: "Please respond before we close this room.",
      messageType: "question",
    }, boardActor);

    await svc.update(room.id, { status: "closed" }, boardActor);

    const responses = await db
      .select()
      .from(conferenceRoomQuestionResponses)
      .where(eq(conferenceRoomQuestionResponses.questionCommentId, question.id));

    expect(responses).toHaveLength(2);
    expect(responses.map((response) => response.status)).toEqual(["dismissed", "dismissed"]);
  });
});
