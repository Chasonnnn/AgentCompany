import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { componentEvalRunRequestSchema } from "@paperclipai/shared";
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

  router.post("/instance/evals/component-run", async (req, res) => {
    assertInstanceAdmin(req);
    const parsed = componentEvalRunRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      const adapterIssue = parsed.error.issues.find((issue) => issue.path[0] === "adapterType");
      const unsupportedAdapterType =
        adapterIssue != null &&
        typeof req.body?.adapterType === "string" &&
        req.body.adapterType.trim().length > 0;
      res.status(unsupportedAdapterType ? 422 : 400).json({
        error: unsupportedAdapterType ? "Unsupported component eval adapter type" : "Invalid component eval request",
        details: parsed.error.flatten(),
      });
      return;
    }
    res.json(await svc.runComponent(parsed.data));
  });

  return router;
}
