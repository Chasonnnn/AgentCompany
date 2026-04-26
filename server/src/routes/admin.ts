import { Router } from "express";
import { listHeartbeatReaperTicks } from "../services/heartbeat.js";
import { assertInstanceAdmin } from "./authz.js";

const DEFAULT_REAPER_STATS_LIMIT = 20;
const MAX_REAPER_STATS_LIMIT = 50;

function parseLimit(value: unknown) {
  if (typeof value !== "string") return DEFAULT_REAPER_STATS_LIMIT;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_REAPER_STATS_LIMIT;
  return Math.min(parsed, MAX_REAPER_STATS_LIMIT);
}

export function adminRoutes() {
  const router = Router();

  router.get("/admin/reaper-stats", async (req, res) => {
    assertInstanceAdmin(req);
    const limit = parseLimit(Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit);
    res.json({
      limit,
      ticks: listHeartbeatReaperTicks(limit),
    });
  });

  return router;
}
