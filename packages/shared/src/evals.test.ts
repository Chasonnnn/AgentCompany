import { describe, expect, it } from "vitest";
import {
  DEFAULT_EVAL_FAILURE_TAXONOMY,
  EVAL_ARTIFACT_SCHEMA_VERSION,
  EVAL_CONTRACT_VERSION,
  EVAL_SCORECARD_VERSION,
  rebuildEvalSummaryIndex,
  validateEvalTraceCompleteness,
} from "./evals.js";
import {
  componentEvalRunRequestSchema,
  componentEvalRunResultSchema,
  evalRunArtifactSchema,
  evalSummaryIndexSchema,
} from "./validators/evals.js";

function createArtifact(runId: string) {
  return {
    artifactSchemaVersion: EVAL_ARTIFACT_SCHEMA_VERSION,
    evalContractVersion: EVAL_CONTRACT_VERSION,
    scorecardVersion: EVAL_SCORECARD_VERSION,
    runId,
    sourceKind: "seeded",
    observedRun: null,
    scenario: {
      id: "worker-isolation",
      title: "Worker isolation across projects",
      description: "Ensure a worker cannot hold raw execution scope in two projects at once.",
      dimension: "reliability",
      layer: "invariant",
      horizonBucket: "15_60m",
      canary: true,
      tags: ["governance", "scope"],
      fixture: {
        kind: "portable_company_package",
        basePackagePath: "/tmp/base-company",
        overlays: [
          {
            label: "two-project-overlay",
            cleanup: "delete",
            files: [
              {
                path: "projects/platform/PROJECT.md",
                content: "# Platform\n",
                mode: "replace",
              },
            ],
          },
        ],
        hermetic: true,
        externalDependencies: [],
      },
      fairnessConstraints: {
        budgetCeilingUsd: 5,
        timeCeilingMinutes: 30,
        tools: ["paperclip-api", "git"],
        repoState: "clean-main",
        approvalPolicy: "default_governed",
        successCriteria: ["no duplicate assignment", "scope boundary preserved"],
      },
      timeoutPolicy: {
        maxMinutes: 30,
        idleMinutes: 5,
      },
      requiredArtifacts: ["manifest", "trace", "scorecard", "replay"],
      chaosProfile: null,
    },
    bundle: {
      id: "canary-reliability",
      label: "Canary Reliability",
      description: "Small seeded reliability canary bundle.",
      lane: "canary",
      scenarioIds: ["worker-isolation"],
      featureFlags: [],
      baselineKind: null,
      ablationKind: null,
    },
    environment: {
      repoRoot: "/Users/chason/paperclip",
      gitSha: "abc123",
      evalContractVersion: EVAL_CONTRACT_VERSION,
      scorecardVersion: EVAL_SCORECARD_VERSION,
      artifactSchemaVersion: EVAL_ARTIFACT_SCHEMA_VERSION,
      scenarioPackageHash: "pkg-hash",
      bundleHash: "bundle-hash",
      modelId: "gpt-5.4",
      modelVersion: "gpt-5.4",
      promptBundleHash: "prompt-hash",
      skillVersions: { paperclip: "1.0.0" },
      toolVersions: { git: "2.49.0" },
      featureFlags: [],
      seed: 7,
      timeoutPolicy: {
        maxMinutes: 30,
        idleMinutes: 5,
      },
      chaosProfile: null,
      instanceRoot: "/tmp/paperclip-instance",
      nodeVersion: "v24.0.0",
      platform: "darwin-arm64",
      startedAt: "2026-04-13T12:00:00.000Z",
    },
    replay: {
      sourceKind: "seeded",
      scenarioId: "worker-isolation",
      bundleId: "canary-reliability",
      lane: "canary",
      command: "pnpm evals:architecture:canary",
      artifactRoot: "/tmp/paperclip-instance/data/evals/architecture",
      basePackagePath: "/tmp/base-company",
      overlayLabels: ["two-project-overlay"],
      featureFlags: [],
      seed: 7,
      fairnessConstraints: {
        budgetCeilingUsd: 5,
        timeCeilingMinutes: 30,
        tools: ["paperclip-api", "git"],
        repoState: "clean-main",
        approvalPolicy: "default_governed",
        successCriteria: ["no duplicate assignment", "scope boundary preserved"],
      },
      externalDependencyPolicy: {
        hermetic: true,
        dependencies: [],
        notes: null,
      },
      observedRun: null,
      env: {
        NODE_ENV: "test",
      },
    },
    graders: [
      {
        id: "hard-check.worker-isolation",
        kind: "hard_check",
        label: "Worker isolation hard check",
        version: "1",
        description: "Ensure no worker holds raw execution scope in two projects.",
        metricKeys: ["scope_violations"],
      },
    ],
    acceptanceOracle: {
      id: "accepted.worker-isolation",
      label: "Accepted outcome",
      version: "1",
      description: "Required artifacts present and no hard-check failures.",
      requiredArtifacts: ["manifest", "trace", "scorecard", "replay"],
    },
    failureTaxonomy: DEFAULT_EVAL_FAILURE_TAXONOMY,
    trace: [
      {
        evalRunId: runId,
        scenarioId: "worker-isolation",
        bundleId: "canary-reliability",
        traceId: "trace-1",
        timestamp: "2026-04-13T12:00:00.000Z",
        eventType: "scenario_started",
        eventClass: "scenario",
        status: "started",
        message: "Seeded scenario started.",
        parentTraceId: null,
        correlationId: "corr-1",
        agentId: null,
        projectId: null,
        issueId: null,
        roomId: null,
        approvalId: null,
        artifactRef: "runs/worker-isolation/manifest.json",
        metadata: null,
      },
      {
        evalRunId: runId,
        scenarioId: "worker-isolation",
        bundleId: "canary-reliability",
        traceId: "trace-2",
        timestamp: "2026-04-13T12:00:01.000Z",
        eventType: "artifact_materialized",
        eventClass: "artifact",
        status: "ok",
        message: "Manifest written.",
        parentTraceId: "trace-1",
        correlationId: "corr-1",
        agentId: null,
        projectId: null,
        issueId: null,
        roomId: null,
        approvalId: null,
        artifactRef: "runs/worker-isolation/manifest.json",
        metadata: null,
      },
      {
        evalRunId: runId,
        scenarioId: "worker-isolation",
        bundleId: "canary-reliability",
        traceId: "trace-3",
        timestamp: "2026-04-13T12:00:02.000Z",
        eventType: "scenario_completed",
        eventClass: "scenario",
        status: "passed",
        message: "Seeded scenario completed.",
        parentTraceId: "trace-1",
        correlationId: "corr-1",
        agentId: null,
        projectId: null,
        issueId: null,
        roomId: null,
        approvalId: null,
        artifactRef: "runs/worker-isolation/scorecard.json",
        metadata: null,
      },
    ],
    capturedArtifacts: [
      {
        label: "manifest",
        kind: "manifest",
        relativePath: "runs/worker-isolation/manifest.json",
        redacted: true,
        sha256: "a",
      },
      {
        label: "trace",
        kind: "trace",
        relativePath: "runs/worker-isolation/trace.ndjson",
        redacted: true,
        sha256: "b",
      },
      {
        label: "scorecard",
        kind: "scorecard",
        relativePath: "runs/worker-isolation/scorecard.json",
        redacted: true,
        sha256: "c",
      },
      {
        label: "replay",
        kind: "replay",
        relativePath: "runs/worker-isolation/replay.json",
        redacted: true,
        sha256: "d",
      },
    ],
    scorecard: {
      scorecardVersion: EVAL_SCORECARD_VERSION,
      runId,
      scenarioId: "worker-isolation",
      bundleId: "canary-reliability",
      dimension: "reliability",
      status: "passed",
      acceptedOutcome: true,
      humanTouchMinutes: 0,
      managerTouches: 1,
      coordinationTax: {
        tokenCost: 1200,
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
        durationMs: 2_000,
        retries: 0,
        queueDepth: 1,
      },
      rubrics: {
        roleQuality: 1,
        handoffQuality: 1,
        decisionQuality: 1,
        notes: ["seeded run"],
      },
      acceptance: {
        passed: true,
        rationale: ["Required artifacts present", "No hard-check failures"],
      },
      failureKinds: [],
      scopeViolationCount: 0,
    },
    startedAt: "2026-04-13T12:00:00.000Z",
    completedAt: "2026-04-13T12:00:02.000Z",
    status: "passed",
    redactionMode: "redacted",
    notes: ["seeded canary"],
  } as const;
}

describe("architecture eval shared contracts", () => {
  it("round-trips run artifacts through the schema", () => {
    const artifact = createArtifact("run-1");
    expect(evalRunArtifactSchema.parse(artifact)).toMatchObject({
      runId: "run-1",
      scorecard: {
        status: "passed",
      },
    });
  });

  it("marks missing required events or artifacts as invalid trace completeness failures", () => {
    const artifact = createArtifact("run-2");
    const broken = {
      ...artifact,
      trace: artifact.trace.filter((event) => event.eventType !== "artifact_materialized"),
      capturedArtifacts: artifact.capturedArtifacts.filter((entry) => entry.label !== "replay"),
    };

    const failures = validateEvalTraceCompleteness(broken as any);
    expect(failures.map((failure) => failure.kind)).toContain("artifact_missing");
    expect(failures.some((failure) => failure.message.includes("artifact_materialized"))).toBe(true);
    expect(failures.some((failure) => failure.message.includes("replay"))).toBe(true);
  });

  it("rebuilds summary indexes from raw artifacts", () => {
    const summary = rebuildEvalSummaryIndex([
      createArtifact("run-1") as any,
      createArtifact("run-2") as any,
    ], "2026-04-13T13:00:00.000Z");

    const parsed = evalSummaryIndexSchema.parse(summary);
    expect(parsed.runCount).toBe(2);
    expect(new Set(parsed.runs.map((run) => run.runId))).toEqual(new Set(["run-1", "run-2"]));
    expect(parsed.runs.every((run) => run.status === "passed")).toBe(true);
    expect(summary.dimensions[0]?.totalRuns).toBe(2);
  });

  it("parses component eval requests", () => {
    const parsed = componentEvalRunRequestSchema.parse({
      caseId: "reliability.deterministic_first",
      adapterType: "codex_local",
      prompt: "Respond with hello.",
      vars: {
        agentId: "agent-1",
      },
      timeoutMs: 30_000,
    });

    expect(parsed.adapterType).toBe("codex_local");
    expect(parsed.timeoutMs).toBe(30_000);
  });

  it("parses component eval results", () => {
    const parsed = componentEvalRunResultSchema.parse({
      executionStatus: "succeeded",
      adapterType: "claude_local",
      modelId: "claude-sonnet",
      finalText: "Run context-now first.",
      durationMs: 1250,
      stderrExcerpt: null,
      traceSummary: {
        eventKinds: ["assistant", "result"],
        toolNames: [],
        sessionId: "session-1",
        warnings: [],
      },
      rawTranscript: [{ type: "assistant", text: "Run context-now first." }],
      errorMessage: null,
    });

    expect(parsed.executionStatus).toBe("succeeded");
    expect(parsed.traceSummary.sessionId).toBe("session-1");
  });
});
