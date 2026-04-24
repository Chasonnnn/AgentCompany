import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { activityService as baseActivityService } from "../services/activity.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { heartbeatService, issueService } from "../services/index.js";
import { sanitizeRecord } from "../redaction.js";
import {
  buildIssuePrivilegeResolver,
  isActorPrivilegedForIssue,
  redactRunId,
} from "../run-id-redaction.js";

const createActivitySchema = z.object({
  actorType: z.enum(["agent", "user", "system"]).optional().default("system"),
  actorId: z.string().min(1),
  action: z.string().min(1),
  entityType: z.string().min(1),
  entityId: z.string().min(1),
  agentId: z.string().uuid().optional().nullable(),
  details: z.record(z.unknown()).optional().nullable(),
});

type ActivityRouteDeps = {
  activityService: ReturnType<typeof baseActivityService>;
  heartbeatService: ReturnType<typeof heartbeatService>;
  issueService: ReturnType<typeof issueService>;
};

export function activityRoutes(db: Db, deps?: Partial<ActivityRouteDeps>) {
  const router = Router();
  const svc = deps?.activityService ?? baseActivityService(db);
  const heartbeat = deps?.heartbeatService ?? heartbeatService(db);
  const issueSvc = deps?.issueService ?? issueService(db);

  async function resolveIssueByRef(rawId: string) {
    if (/^[A-Z]+-\d+$/i.test(rawId)) {
      return issueSvc.getByIdentifier(rawId);
    }
    return issueSvc.getById(rawId);
  }

  router.get("/companies/:companyId/activity", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const filters = {
      companyId,
      agentId: req.query.agentId as string | undefined,
      entityType: req.query.entityType as string | undefined,
      entityId: req.query.entityId as string | undefined,
    };
    const rows = await svc.list(filters);
    const issueIds = Array.from(
      new Set(
        rows
          .filter((row) => row.entityType === "issue" && typeof row.entityId === "string")
          .map((row) => row.entityId as string),
      ),
    );
    const isPrivilegedForIssue = await buildIssuePrivilegeResolver(db, req, companyId, issueIds);
    const redacted = rows.map((row) => {
      if (!row.runId) return row;
      const privileged =
        row.entityType === "issue" && typeof row.entityId === "string"
          ? isPrivilegedForIssue(row.entityId)
          : req.actor.type === "board";
      return { ...row, runId: redactRunId(row.runId, privileged) };
    });
    res.json(redacted);
  });

  router.post("/companies/:companyId/activity", validate(createActivitySchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const event = await svc.create({
      companyId,
      ...req.body,
      details: req.body.details ? sanitizeRecord(req.body.details) : null,
    });
    res.status(201).json(event);
  });

  router.get("/issues/:id/activity", async (req, res) => {
    const rawId = req.params.id as string;
    const issue = await resolveIssueByRef(rawId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const rows = await svc.forIssue(issue.id);
    const privileged = await isActorPrivilegedForIssue(db, req, issue);
    const redacted = rows.map((row) =>
      row.runId ? { ...row, runId: redactRunId(row.runId, privileged) } : row,
    );
    res.json(redacted);
  });

  router.get("/issues/:id/runs", async (req, res) => {
    const rawId = req.params.id as string;
    const issue = await resolveIssueByRef(rawId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const rows = await svc.runsForIssue(issue.companyId, issue.id);
    const privileged = await isActorPrivilegedForIssue(db, req, issue);
    const redacted = rows.map((row) => {
      const next: Record<string, unknown> = { ...row, runId: redactRunId(row.runId, privileged) };
      if ("retryOfRunId" in row) {
        next.retryOfRunId = redactRunId(row.retryOfRunId ?? null, privileged);
      }
      return next;
    });
    res.json(redacted);
  });

  router.get("/heartbeat-runs/:runId/issues", async (req, res) => {
    const runId = req.params.runId as string;
    const run = await heartbeat.getRun(runId);
    if (!run) {
      res.json([]);
      return;
    }
    assertCompanyAccess(req, run.companyId);
    const result = await svc.issuesForRun(runId);
    res.json(result);
  });

  return router;
}
