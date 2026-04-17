import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  addConferenceRoomCommentSchema,
  createConferenceRoomSchema,
  requestConferenceRoomDecisionSchema,
  updateConferenceRoomSchema,
} from "@paperclipai/shared";
import { forbidden, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { conferenceRoomService, issueService } from "../services/index.js";
import { serializeApprovalForActor } from "../services/conference-context.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

export function conferenceRoomRoutes(db: Db) {
  const router = Router();
  const rooms = conferenceRoomService(db);
  const issuesSvc = issueService(db);

  async function getRoomOrThrow(id: string) {
    const room = await rooms.getById(id);
    if (!room) throw notFound("Conference room not found");
    return room;
  }

  async function assertRoomAccess(req: Parameters<typeof assertCompanyAccess>[0], roomId: string) {
    const room = await getRoomOrThrow(roomId);
    assertCompanyAccess(req, room.companyId);
    if (req.actor.type === "board") return room;
    if (!req.actor.agentId) throw forbidden("Agent authentication required");
    if (!(await rooms.hasParticipant(room.id, req.actor.agentId))) {
      throw forbidden("Conference room access requires an invitation");
    }
    return room;
  }

  router.get("/companies/:companyId/conference-rooms", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = req.actor.type === "board"
      ? await rooms.listForCompany(companyId)
      : req.actor.agentId
        ? await rooms.listForAgent(companyId, req.actor.agentId)
        : [];
    res.json(result);
  });

  router.post("/companies/:companyId/conference-rooms", validate(createConferenceRoomSchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    const room = await rooms.create(companyId, req.body, {
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId ?? null,
      runId: actor.runId ?? null,
    });
    res.status(201).json(room);
  });

  router.get("/conference-rooms/:id", async (req, res) => {
    const room = await assertRoomAccess(req, req.params.id as string);
    res.json(room);
  });

  router.patch("/conference-rooms/:id", validate(updateConferenceRoomSchema), async (req, res) => {
    assertBoard(req);
    const room = await assertRoomAccess(req, req.params.id as string);
    const actor = getActorInfo(req);
    const updated = await rooms.update(room.id, req.body, {
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId ?? null,
      runId: actor.runId ?? null,
    });
    res.json(updated);
  });

  router.get("/conference-rooms/:id/comments", async (req, res) => {
    const room = await assertRoomAccess(req, req.params.id as string);
    const comments = await rooms.listComments(room.id);
    res.json(comments);
  });

  router.post("/conference-rooms/:id/comments", validate(addConferenceRoomCommentSchema), async (req, res) => {
    const room = await assertRoomAccess(req, req.params.id as string);
    const actor = getActorInfo(req);
    const comment = await rooms.addComment(room.id, req.body, {
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId ?? null,
      runId: actor.runId ?? null,
    });
    res.status(201).json(comment);
  });

  router.post(
    "/conference-rooms/:id/request-board-decision",
    validate(requestConferenceRoomDecisionSchema),
    async (req, res) => {
      assertBoard(req);
      const room = await assertRoomAccess(req, req.params.id as string);
      const actor = getActorInfo(req);
      const approval = await rooms.requestBoardDecision(room.id, req.body, {
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId ?? null,
        runId: actor.runId ?? null,
      });
      res.status(201).json(serializeApprovalForActor(approval, "board"));
    },
  );

  router.get("/issues/:id/conference-rooms", async (req, res) => {
    const issue = await issuesSvc.getById(req.params.id as string);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const result = await rooms.listForIssue(issue.id);
    if (req.actor.type === "board" || !req.actor.agentId) {
      res.json(result);
      return;
    }
    const visible: typeof result = [];
    for (const room of result) {
      if (await rooms.hasParticipant(room.id, req.actor.agentId)) {
        visible.push(room);
      }
    }
    res.json(visible);
  });

  router.post("/issues/:id/conference-rooms", validate(createConferenceRoomSchema), async (req, res) => {
    assertBoard(req);
    const issue = await issuesSvc.getById(req.params.id as string);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const actor = getActorInfo(req);
    const room = await rooms.create(issue.companyId, {
      ...req.body,
      issueIds: Array.from(new Set([issue.id, ...(req.body.issueIds ?? [])])),
    }, {
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId ?? null,
      runId: actor.runId ?? null,
    });
    res.status(201).json(room);
  });

  return router;
}
