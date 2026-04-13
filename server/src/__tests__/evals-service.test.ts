import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EVAL_ARTIFACT_SCHEMA_VERSION,
  EVAL_CONTRACT_VERSION,
  EVAL_SCORECARD_VERSION,
  rebuildEvalSummaryIndex,
  type EvalRunArtifact,
} from "@paperclipai/shared";
import { evalService } from "../services/evals.js";

const tempDirs: string[] = [];

async function createTempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "paperclip-eval-service-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function seedArtifactRoot(artifactRoot: string) {
  const runId = "run-1";
  const runDir = path.join(artifactRoot, "runs", runId);
  await mkdir(path.join(runDir, "artifacts"), { recursive: true });

  const artifact: EvalRunArtifact = {
    artifactSchemaVersion: EVAL_ARTIFACT_SCHEMA_VERSION,
    evalContractVersion: EVAL_CONTRACT_VERSION,
    scorecardVersion: EVAL_SCORECARD_VERSION,
    runId,
    scenario: {
      id: "worker-isolation-across-projects",
      title: "Worker isolation across projects",
      description: "Seeded service test scenario.",
      dimension: "reliability",
      layer: "invariant",
      horizonBucket: "15_60m",
      canary: true,
      tags: ["scope"],
      fixture: {
        kind: "portable_company_package",
        basePackagePath: "/tmp/base-company",
        overlays: [],
        hermetic: true,
        externalDependencies: [],
      },
      fairnessConstraints: {
        budgetCeilingUsd: 5,
        timeCeilingMinutes: 30,
        tools: ["paperclip-api"],
        repoState: "clean-main",
        approvalPolicy: "default_governed",
        successCriteria: ["required artifacts present"],
      },
      timeoutPolicy: {
        maxMinutes: 30,
        idleMinutes: 5,
      },
      requiredArtifacts: ["manifest", "trace", "scorecard", "replay"],
      chaosProfile: null,
    },
    bundle: {
      id: "architecture-canary",
      label: "Architecture Canary",
      description: "Seeded service test bundle.",
      lane: "canary",
      scenarioIds: ["worker-isolation-across-projects"],
      featureFlags: [],
      baselineKind: null,
      ablationKind: null,
    },
    environment: {
      repoRoot: process.cwd(),
      gitSha: "abc123",
      evalContractVersion: EVAL_CONTRACT_VERSION,
      scorecardVersion: EVAL_SCORECARD_VERSION,
      artifactSchemaVersion: EVAL_ARTIFACT_SCHEMA_VERSION,
      scenarioPackageHash: "pkg-hash",
      bundleHash: "bundle-hash",
      modelId: "seeded-runner",
      modelVersion: "seeded-runner",
      promptBundleHash: null,
      skillVersions: { paperclip: "wave-1" },
      toolVersions: { git: "system" },
      featureFlags: [],
      seed: 7,
      timeoutPolicy: {
        maxMinutes: 30,
        idleMinutes: 5,
      },
      chaosProfile: null,
      instanceRoot: artifactRoot,
      nodeVersion: process.version,
      platform: `${process.platform}-${process.arch}`,
      startedAt: "2026-04-13T12:00:00.000Z",
    },
    replay: {
      scenarioId: "worker-isolation-across-projects",
      bundleId: "architecture-canary",
      lane: "canary",
      command: "pnpm evals:architecture:canary",
      artifactRoot,
      basePackagePath: "/tmp/base-company",
      overlayLabels: [],
      featureFlags: [],
      seed: 7,
      fairnessConstraints: {
        budgetCeilingUsd: 5,
        timeCeilingMinutes: 30,
        tools: ["paperclip-api"],
        repoState: "clean-main",
        approvalPolicy: "default_governed",
        successCriteria: ["required artifacts present"],
      },
      externalDependencyPolicy: {
        hermetic: true,
        dependencies: [],
        notes: null,
      },
      env: {
        NODE_ENV: "test",
      },
    },
    graders: [],
    acceptanceOracle: {
      id: "accepted.seeded",
      label: "Accepted outcome",
      version: "1",
      description: "Required artifacts present and no hard-check failures.",
      requiredArtifacts: ["manifest", "trace", "scorecard", "replay"],
    },
    failureTaxonomy: [],
    trace: [
      {
        evalRunId: runId,
        scenarioId: "worker-isolation-across-projects",
        bundleId: "architecture-canary",
        traceId: "trace-start",
        timestamp: "2026-04-13T12:00:00.000Z",
        eventType: "scenario_started",
        eventClass: "scenario",
        status: "started",
        message: "started",
        parentTraceId: null,
        correlationId: "corr-1",
        agentId: null,
        projectId: null,
        issueId: null,
        roomId: null,
        approvalId: null,
        artifactRef: "runs/run-1/manifest.json",
        metadata: null,
      },
      {
        evalRunId: runId,
        scenarioId: "worker-isolation-across-projects",
        bundleId: "architecture-canary",
        traceId: "trace-artifact",
        timestamp: "2026-04-13T12:00:01.000Z",
        eventType: "artifact_materialized",
        eventClass: "artifact",
        status: "ok",
        message: "artifact",
        parentTraceId: "trace-start",
        correlationId: "corr-1",
        agentId: null,
        projectId: null,
        issueId: null,
        roomId: null,
        approvalId: null,
        artifactRef: "runs/run-1/trace.ndjson",
        metadata: null,
      },
      {
        evalRunId: runId,
        scenarioId: "worker-isolation-across-projects",
        bundleId: "architecture-canary",
        traceId: "trace-complete",
        timestamp: "2026-04-13T12:00:02.000Z",
        eventType: "scenario_completed",
        eventClass: "scenario",
        status: "passed",
        message: "done",
        parentTraceId: "trace-start",
        correlationId: "corr-1",
        agentId: null,
        projectId: null,
        issueId: null,
        roomId: null,
        approvalId: null,
        artifactRef: "runs/run-1/scorecard.json",
        metadata: null,
      },
    ],
    capturedArtifacts: [
      { label: "manifest", kind: "manifest", relativePath: "runs/run-1/manifest.json", redacted: true, sha256: "a" },
      { label: "trace", kind: "trace", relativePath: "runs/run-1/trace.ndjson", redacted: true, sha256: "b" },
      { label: "scorecard", kind: "scorecard", relativePath: "runs/run-1/scorecard.json", redacted: true, sha256: "c" },
      { label: "replay", kind: "replay", relativePath: "runs/run-1/replay.json", redacted: true, sha256: "d" },
    ],
    scorecard: {
      scorecardVersion: EVAL_SCORECARD_VERSION,
      runId,
      scenarioId: "worker-isolation-across-projects",
      bundleId: "architecture-canary",
      dimension: "reliability",
      status: "passed",
      acceptedOutcome: true,
      humanTouchMinutes: 0,
      managerTouches: 1,
      coordinationTax: {
        tokenCost: 800,
        approvalWaitMinutes: 0,
        conferenceRoomTurns: 0,
        managerTouches: 1,
        acceptedOutcomeCount: 1,
      },
      hardChecks: {
        passed: 3,
        failed: 0,
        failures: [],
      },
      metrics: {
        durationMs: 2000,
      },
      rubrics: {
        roleQuality: 1,
        handoffQuality: null,
        decisionQuality: null,
        notes: [],
      },
      acceptance: {
        passed: true,
        rationale: ["Seeded service test artifact"],
      },
      failureKinds: [],
      scopeViolationCount: 0,
    },
    startedAt: "2026-04-13T12:00:00.000Z",
    completedAt: "2026-04-13T12:00:02.000Z",
    status: "passed",
    redactionMode: "redacted",
    notes: [],
  };

  const summary = rebuildEvalSummaryIndex([artifact], "2026-04-13T12:05:00.000Z");

  await writeFile(path.join(runDir, "artifact.json"), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  await mkdir(path.join(artifactRoot, "summary"), { recursive: true });
  await writeFile(path.join(artifactRoot, "summary", "index.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  return artifact;
}

describe("eval service", () => {
  it("reads summaries and redacted run details from artifact storage", async () => {
    const artifactRoot = await createTempDir();
    const run = await seedArtifactRoot(artifactRoot);

    const svc = evalService({ artifactRoot });
    const summary = await svc.getSummary();
    expect(summary.runCount).toBe(1);

    const runs = await svc.listRuns();
    expect(runs[0]?.runId).toBe(run.runId);

    const detail = await svc.getRun(run.runId);
    expect(detail?.redactionMode).toBe("redacted");
    expect(detail?.scenario.id).toBe(run.scenario.id);
  });

  it("falls back to an empty summary when no artifacts exist", async () => {
    const artifactRoot = await createTempDir();
    const svc = evalService({ artifactRoot });
    const summary = await svc.getSummary();
    expect(summary.runCount).toBe(0);
    expect(summary.runs).toEqual([]);
  });
});
