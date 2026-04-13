import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { evalService as baseEvalService } from "../services/evals.js";
import { assertInstanceAdmin } from "./authz.js";

type EvalRouteDeps = {
  evalService: ReturnType<typeof baseEvalService>;
};

export function evalRoutes(_db: Db, deps?: Partial<EvalRouteDeps>) {
  const router = Router();
  const svc = deps?.evalService ?? baseEvalService();

  router.get("/instance/evals/summary", async (req, res) => {
    assertInstanceAdmin(req);
    res.json(await svc.getSummary());
  });

  router.get("/instance/evals/runs", async (req, res) => {
    assertInstanceAdmin(req);
    res.json(await svc.listRuns());
  });

  router.get("/instance/evals/runs/:runId", async (req, res) => {
    assertInstanceAdmin(req);
    const run = await svc.getRun(req.params.runId);
    if (!run) {
      res.status(404).json({ error: "Eval run not found" });
      return;
    }
    res.json(run);
  });

  return router;
}
