import path from "node:path";
import { promises as fs } from "node:fs";
import {
  buildEmptyEvalSummaryIndex,
  evalRunArtifactSchema,
  evalSummaryIndexSchema,
  type EvalRunArtifact,
  type EvalRunListItem,
  type EvalSummaryIndex,
} from "@paperclipai/shared";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

const SAFE_RUN_ID_RE = /^[a-zA-Z0-9._-]+$/;

function defaultArtifactRoot() {
  return path.join(resolvePaperclipInstanceRoot(), "data", "evals", "architecture");
}

function resolveRunPath(rootPath: string, runId: string) {
  if (!SAFE_RUN_ID_RE.test(runId)) {
    return null;
  }
  return path.join(rootPath, "runs", runId, "artifact.json");
}

export function evalService(options?: {
  artifactRoot?: string;
}) {
  const artifactRoot = options?.artifactRoot ?? defaultArtifactRoot();

  async function getSummary(): Promise<EvalSummaryIndex> {
    const summaryPath = path.join(artifactRoot, "summary", "index.json");
    const raw = await fs.readFile(summaryPath, "utf8").catch(() => null);
    if (!raw) {
      return buildEmptyEvalSummaryIndex();
    }
    return evalSummaryIndexSchema.parse(JSON.parse(raw));
  }

  async function listRuns(): Promise<EvalRunListItem[]> {
    const summary = await getSummary();
    return [...summary.runs].sort((left, right) => {
      return Date.parse(right.completedAt) - Date.parse(left.completedAt);
    });
  }

  async function getRun(runId: string): Promise<EvalRunArtifact | null> {
    const artifactPath = resolveRunPath(artifactRoot, runId);
    if (!artifactPath) return null;
    const raw = await fs.readFile(artifactPath, "utf8").catch(() => null);
    if (!raw) return null;
    const parsed = evalRunArtifactSchema.parse(JSON.parse(raw));
    return {
      ...parsed,
      redactionMode: "redacted",
    };
  }

  return {
    artifactRoot,
    getSummary,
    listRuns,
    getRun,
  };
}
