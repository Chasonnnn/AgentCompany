import type {
  EvalFailure,
  EvalFailureTaxonomy,
  EvalRunArtifact,
  EvalRunListItem,
  EvalStatusCount,
  EvalSummaryDimensionStats,
  EvalSummaryIndex,
  EvalSummaryScenarioEntry,
} from "./types/evals.js";

export const EVAL_CONTRACT_VERSION = 1;
export const EVAL_SCORECARD_VERSION = 1;
export const EVAL_ARTIFACT_SCHEMA_VERSION = 1;

export const EVAL_DIMENSIONS = ["reliability", "stability", "utility"] as const;
export type EvalDimension = (typeof EVAL_DIMENSIONS)[number];

export const EVAL_LAYERS = ["invariant", "role", "handoff", "workflow", "portfolio", "soak"] as const;
export type EvalLayer = (typeof EVAL_LAYERS)[number];

export const EVAL_RUN_STATUSES = [
  "passed",
  "failed",
  "flaky",
  "timed_out",
  "blocked",
  "invalid",
] as const;
export type EvalRunStatus = (typeof EVAL_RUN_STATUSES)[number];

export const EVAL_HORIZON_BUCKETS = [
  "5_15m",
  "15_60m",
  "1_4h",
  "half_day",
  "full_day_plus",
] as const;
export type EvalHorizonBucket = (typeof EVAL_HORIZON_BUCKETS)[number];

export const EVAL_GRADER_KINDS = [
  "hard_check",
  "metric_extractor",
  "rubric",
  "acceptance_oracle",
] as const;
export type EvalGraderKind = (typeof EVAL_GRADER_KINDS)[number];

export const EVAL_FAILURE_KINDS = [
  "scope_violation",
  "authority_bypass",
  "duplicate_work",
  "deadlock",
  "resume_failure",
  "stale_context",
  "artifact_missing",
  "grader_error",
] as const;
export type EvalFailureKind = (typeof EVAL_FAILURE_KINDS)[number];

export const DEFAULT_EVAL_FAILURE_TAXONOMY: EvalFailureTaxonomy[] = [
  {
    kind: "scope_violation",
    label: "Scope violation",
    description: "A run crossed a declared scope boundary or leaked execution authority.",
    hardFailure: true,
  },
  {
    kind: "authority_bypass",
    label: "Authority bypass",
    description: "A governed decision or routing action bypassed the expected approval or leadership chain.",
    hardFailure: true,
  },
  {
    kind: "duplicate_work",
    label: "Duplicate work",
    description: "Multiple actors or resumptions performed overlapping work for the same lane.",
    hardFailure: true,
  },
  {
    kind: "deadlock",
    label: "Deadlock",
    description: "The run stopped making progress because coordination could not resolve.",
    hardFailure: true,
  },
  {
    kind: "resume_failure",
    label: "Resume failure",
    description: "The architecture failed to recover cleanly after a restart or interruption.",
    hardFailure: true,
  },
  {
    kind: "stale_context",
    label: "Stale context",
    description: "Agents continued with out-of-date state or contradicted durable artifacts.",
    hardFailure: false,
  },
  {
    kind: "artifact_missing",
    label: "Artifact missing",
    description: "A required artifact, event class, or artifact reference was missing from the run trace.",
    hardFailure: true,
  },
  {
    kind: "grader_error",
    label: "Grader error",
    description: "The harness could not score or validate the run coherently.",
    hardFailure: true,
  },
];

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  }
  return sorted[mid];
}

function percentile(values: number[], percentileValue: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1));
  return sorted[index] ?? null;
}

function parseTimestamp(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function isEvalRunStatus(value: unknown): value is EvalRunStatus {
  return typeof value === "string" && EVAL_RUN_STATUSES.includes(value as EvalRunStatus);
}

export function buildEvalStatusCounts(statuses: EvalRunStatus[]): EvalStatusCount[] {
  return EVAL_RUN_STATUSES.map((status) => ({
    status,
    count: statuses.filter((entry) => entry === status).length,
  }));
}

export function buildEmptyEvalSummaryIndex(generatedAt = new Date().toISOString()): EvalSummaryIndex {
  return {
    artifactSchemaVersion: EVAL_ARTIFACT_SCHEMA_VERSION,
    evalContractVersion: EVAL_CONTRACT_VERSION,
    scorecardVersion: EVAL_SCORECARD_VERSION,
    generatedAt,
    runCount: 0,
    latestRunId: null,
    statusCounts: buildEvalStatusCounts([]),
    dimensions: EVAL_DIMENSIONS.map((dimension) => ({
      dimension,
      totalRuns: 0,
      acceptedOutcomes: 0,
      statusCounts: buildEvalStatusCounts([]),
      medianDurationMs: null,
      p95DurationMs: null,
      rolling7DayPassRate: null,
      scopeViolationCount: 0,
    })),
    scenarios: [],
    failingScenarios: [],
    runs: [],
  };
}

function buildFailure(
  kind: EvalFailureKind,
  message: string,
  traceId: string | null = null,
  artifactRef: string | null = null,
  entityId: string | null = null,
): EvalFailure {
  return { kind, message, traceId, artifactRef, entityId };
}

export function validateEvalTraceCompleteness(artifact: EvalRunArtifact): EvalFailure[] {
  const failures: EvalFailure[] = [];
  const startedAt = parseTimestamp(artifact.startedAt);
  const completedAt = parseTimestamp(artifact.completedAt);
  if (startedAt == null || completedAt == null || completedAt < startedAt) {
    failures.push(buildFailure(
      "grader_error",
      "Run timestamps are incoherent or not parseable.",
      null,
      "manifest.json",
      artifact.runId,
    ));
  }

  const requiredEventTypes = new Set(["scenario_started", "scenario_completed", "artifact_materialized"]);
  const seenEventTypes = new Set<string>();
  const artifactRefs = new Set(artifact.capturedArtifacts.map((entry) => entry.relativePath));
  let lastEventTime: number | null = null;

  for (const event of artifact.trace) {
    seenEventTypes.add(event.eventType);
    const eventTime = parseTimestamp(event.timestamp);
    if (eventTime == null) {
      failures.push(buildFailure(
        "grader_error",
        `Trace event '${event.traceId}' has an invalid timestamp.`,
        event.traceId,
        event.artifactRef,
        artifact.runId,
      ));
      continue;
    }
    if (lastEventTime != null && eventTime < lastEventTime) {
      failures.push(buildFailure(
        "grader_error",
        `Trace event '${event.traceId}' is out of chronological order.`,
        event.traceId,
        event.artifactRef,
        artifact.runId,
      ));
    }
    lastEventTime = eventTime;

    if (
      !event.evalRunId
      || !event.scenarioId
      || !event.bundleId
      || !event.traceId
    ) {
      failures.push(buildFailure(
        "artifact_missing",
        "Trace event is missing one of evalRunId, scenarioId, bundleId, or traceId.",
        event.traceId || null,
        event.artifactRef,
        artifact.runId,
      ));
    }

    if (
      event.evalRunId !== artifact.runId
      || event.scenarioId !== artifact.scenario.id
      || event.bundleId !== artifact.bundle.id
    ) {
      failures.push(buildFailure(
        "artifact_missing",
        `Trace event '${event.traceId}' does not join cleanly back to the run manifest.`,
        event.traceId,
        event.artifactRef,
        artifact.runId,
      ));
    }

    if (
      event.eventClass !== "system"
      && event.eventClass !== "artifact"
      && event.eventClass !== "scenario"
    ) {
      const hasEntityId = Boolean(
        event.agentId
        || event.projectId
        || event.issueId
        || event.roomId
        || event.approvalId,
      );
      if (!hasEntityId) {
        failures.push(buildFailure(
          "artifact_missing",
          `Authoritative event '${event.traceId}' is missing entity identifiers.`,
          event.traceId,
          event.artifactRef,
          artifact.runId,
        ));
      }
      if (!event.parentTraceId && !event.correlationId) {
        failures.push(buildFailure(
          "artifact_missing",
          `Authoritative event '${event.traceId}' is missing parent or correlation ids.`,
          event.traceId,
          event.artifactRef,
          artifact.runId,
        ));
      }
    }

    if (event.artifactRef && !artifactRefs.has(event.artifactRef)) {
      failures.push(buildFailure(
        "artifact_missing",
        `Trace event '${event.traceId}' references missing artifact '${event.artifactRef}'.`,
        event.traceId,
        event.artifactRef,
        artifact.runId,
      ));
    }
  }

  for (const requiredEventType of requiredEventTypes) {
    if (!seenEventTypes.has(requiredEventType)) {
      failures.push(buildFailure(
        "artifact_missing",
        `Required event type '${requiredEventType}' is missing from the trace.`,
        null,
        "trace.ndjson",
        artifact.runId,
      ));
    }
  }

  for (const requiredArtifact of artifact.scenario.requiredArtifacts) {
    const matched = artifact.capturedArtifacts.some((entry) => entry.label === requiredArtifact || entry.kind === requiredArtifact);
    if (!matched) {
      failures.push(buildFailure(
        "artifact_missing",
        `Required artifact '${requiredArtifact}' is missing from the capture set.`,
        null,
        requiredArtifact,
        artifact.runId,
      ));
    }
  }

  return failures;
}

function effectiveRunStatus(artifact: EvalRunArtifact): EvalRunStatus {
  return validateEvalTraceCompleteness(artifact).length > 0 ? "invalid" : artifact.status;
}

export function summarizeEvalRunArtifact(artifact: EvalRunArtifact): EvalRunListItem {
  const startedAt = parseTimestamp(artifact.startedAt) ?? 0;
  const completedAt = parseTimestamp(artifact.completedAt) ?? startedAt;
  const artifactDirectory = artifact.capturedArtifacts[0]?.relativePath
    ? artifact.capturedArtifacts[0].relativePath.split("/").slice(0, -1).join("/")
    : "";

  return {
    runId: artifact.runId,
    scenarioId: artifact.scenario.id,
    scenarioTitle: artifact.scenario.title,
    bundleId: artifact.bundle.id,
    bundleLabel: artifact.bundle.label,
    dimension: artifact.scenario.dimension,
    layer: artifact.scenario.layer,
    horizonBucket: artifact.scenario.horizonBucket,
    status: effectiveRunStatus(artifact),
    acceptedOutcome: artifact.scorecard.acceptedOutcome,
    startedAt: artifact.startedAt,
    completedAt: artifact.completedAt,
    durationMs: Math.max(0, completedAt - startedAt),
    artifactDirectory,
    failureKinds: artifact.scorecard.failureKinds,
    tags: artifact.scenario.tags,
  };
}

export function rebuildEvalSummaryIndex(
  artifacts: EvalRunArtifact[],
  generatedAt = new Date().toISOString(),
): EvalSummaryIndex {
  if (artifacts.length === 0) {
    return buildEmptyEvalSummaryIndex(generatedAt);
  }

  const runs = artifacts
    .map((artifact) => summarizeEvalRunArtifact(artifact))
    .sort((left, right) => Date.parse(right.completedAt) - Date.parse(left.completedAt));
  const latestRunId = runs[0]?.runId ?? null;

  const dimensions: EvalSummaryDimensionStats[] = EVAL_DIMENSIONS.map((dimension) => {
    const dimensionRuns = runs.filter((run) => run.dimension === dimension);
    const durations = dimensionRuns.map((run) => run.durationMs).filter((value) => value >= 0);
    const lastWeekCutoff = Date.now() - (7 * 24 * 60 * 60 * 1000);
    const lastWeekRuns = dimensionRuns.filter((run) => {
      const completedAt = parseTimestamp(run.completedAt);
      return completedAt != null && completedAt >= lastWeekCutoff;
    });

    return {
      dimension,
      totalRuns: dimensionRuns.length,
      acceptedOutcomes: dimensionRuns.filter((run) => run.acceptedOutcome).length,
      statusCounts: buildEvalStatusCounts(dimensionRuns.map((run) => run.status)),
      medianDurationMs: median(durations),
      p95DurationMs: percentile(durations, 95),
      rolling7DayPassRate: lastWeekRuns.length > 0
        ? Number((lastWeekRuns.filter((run) => run.status === "passed").length / lastWeekRuns.length).toFixed(4))
        : null,
      scopeViolationCount: artifacts
        .filter((artifact) => artifact.scenario.dimension === dimension)
        .reduce((sum, artifact) => sum + artifact.scorecard.scopeViolationCount, 0),
    };
  });

  const scenarioMap = new Map<string, EvalSummaryScenarioEntry>();
  for (const run of runs) {
    const existing = scenarioMap.get(run.scenarioId);
    if (!existing) {
      scenarioMap.set(run.scenarioId, {
        scenarioId: run.scenarioId,
        title: run.scenarioTitle,
        dimension: run.dimension,
        layer: run.layer,
        horizonBucket: run.horizonBucket,
        latestRunId: run.runId,
        latestStatus: run.status,
        lastCompletedAt: run.completedAt,
        runCount: 1,
        acceptedOutcomes: run.acceptedOutcome ? 1 : 0,
      });
      continue;
    }
    existing.runCount += 1;
    if (run.acceptedOutcome) existing.acceptedOutcomes += 1;
  }

  const scenarios = [...scenarioMap.values()].sort((left, right) => {
    return Date.parse(right.lastCompletedAt ?? "") - Date.parse(left.lastCompletedAt ?? "");
  });

  return {
    artifactSchemaVersion: EVAL_ARTIFACT_SCHEMA_VERSION,
    evalContractVersion: EVAL_CONTRACT_VERSION,
    scorecardVersion: EVAL_SCORECARD_VERSION,
    generatedAt,
    runCount: runs.length,
    latestRunId,
    statusCounts: buildEvalStatusCounts(runs.map((run) => run.status)),
    dimensions,
    scenarios,
    failingScenarios: scenarios.filter((scenario) => {
      return scenario.latestStatus != null && scenario.latestStatus !== "passed";
    }),
    runs,
  };
}
