import { z } from "zod";
import {
  EVAL_ARTIFACT_SCHEMA_VERSION,
  EVAL_CONTRACT_VERSION,
  EVAL_DIMENSIONS,
  EVAL_FAILURE_KINDS,
  EVAL_GRADER_KINDS,
  EVAL_HORIZON_BUCKETS,
  EVAL_LAYERS,
  EVAL_RUN_STATUSES,
  EVAL_SCORECARD_VERSION,
} from "../evals.js";
import type {
  ComponentEvalAdapterType,
  ComponentEvalExecutionStatus,
  ComponentEvalRunRequest,
  ComponentEvalRunResult,
  ComponentEvalTraceSummary,
  EvalAcceptanceOracle,
  EvalBundle,
  EvalEnvironmentManifest,
  EvalExternalDependencyPolicy,
  EvalFailure,
  EvalFailureTaxonomy,
  EvalFairnessConstraints,
  EvalGrader,
  EvalReplaySpec,
  EvalRunArtifact,
  EvalScenario,
  EvalScorecard,
  EvalStatusCount,
  EvalSummaryDimensionStats,
  EvalSummaryIndex,
  EvalSummaryScenarioEntry,
  EvalTimeoutPolicy,
  EvalTraceEvent,
} from "../types/evals.js";

const trimmedString = z.string().trim().min(1);
const nullableTrimmedString = trimmedString.nullable();

export const evalDimensionSchema = z.enum(EVAL_DIMENSIONS);
export const evalLayerSchema = z.enum(EVAL_LAYERS);
export const evalRunStatusSchema = z.enum(EVAL_RUN_STATUSES);
export const evalHorizonBucketSchema = z.enum(EVAL_HORIZON_BUCKETS);
export const evalGraderKindSchema = z.enum(EVAL_GRADER_KINDS);
export const evalFailureKindSchema = z.enum(EVAL_FAILURE_KINDS);

export const evalFairnessConstraintsSchema = z.object({
  budgetCeilingUsd: z.number().finite().nullable(),
  timeCeilingMinutes: z.number().finite().nullable(),
  tools: z.array(trimmedString),
  repoState: trimmedString,
  approvalPolicy: trimmedString,
  successCriteria: z.array(trimmedString),
}) as z.ZodType<EvalFairnessConstraints>;

export const evalScenarioOverlayFileSchema = z.object({
  path: trimmedString,
  content: z.string(),
  mode: z.enum(["replace", "append"]),
});

export const evalScenarioOverlaySchema = z.object({
  label: trimmedString,
  files: z.array(evalScenarioOverlayFileSchema),
  cleanup: z.enum(["delete", "retain_on_failure", "retain"]),
});

export const evalRunSourceKindSchema = z.enum(["seeded", "observed"]);

export const evalScenarioFixtureSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("portable_company_package"),
    basePackagePath: trimmedString,
    overlays: z.array(evalScenarioOverlaySchema),
    hermetic: z.boolean(),
    externalDependencies: z.array(trimmedString),
  }),
  z.object({
    kind: z.literal("observed_issue_continuity"),
    lookbackHours: z.number().int().positive(),
    maxRuns: z.number().int().positive(),
    hermetic: z.literal(false),
    externalDependencies: z.array(trimmedString),
  }),
]);

export const evalTimeoutPolicySchema = z.object({
  maxMinutes: z.number().int().positive(),
  idleMinutes: z.number().int().positive().nullable(),
}) as z.ZodType<EvalTimeoutPolicy>;

export const evalScenarioSchema = z.object({
  id: trimmedString,
  title: trimmedString,
  description: nullableTrimmedString,
  dimension: evalDimensionSchema,
  layer: evalLayerSchema,
  horizonBucket: evalHorizonBucketSchema,
  canary: z.boolean(),
  tags: z.array(trimmedString),
  fixture: evalScenarioFixtureSchema,
  fairnessConstraints: evalFairnessConstraintsSchema,
  timeoutPolicy: evalTimeoutPolicySchema,
  requiredArtifacts: z.array(trimmedString),
  chaosProfile: nullableTrimmedString,
}) as z.ZodType<EvalScenario>;

export const evalBundleSchema = z.object({
  id: trimmedString,
  label: trimmedString,
  description: nullableTrimmedString,
  lane: z.enum(["component", "canary", "nightly", "soak", "baseline"]),
  scenarioIds: z.array(trimmedString),
  featureFlags: z.array(trimmedString),
  baselineKind: z.enum(["single_strong_worker", "flat_pod", "full_hierarchy"]).nullable(),
  ablationKind: z.enum([
    "remove_vp_layer",
    "remove_conference_rooms",
    "remove_consultant_path",
    "collapse_director_and_tech_lead",
    "remove_packet_conventions",
  ]).nullable(),
}) as z.ZodType<EvalBundle>;

const evalBundleLaneSchema = z.enum(["component", "canary", "nightly", "soak", "baseline"]);

export const evalEnvironmentManifestSchema = z.object({
  repoRoot: trimmedString,
  gitSha: trimmedString,
  evalContractVersion: z.literal(EVAL_CONTRACT_VERSION),
  scorecardVersion: z.literal(EVAL_SCORECARD_VERSION),
  artifactSchemaVersion: z.literal(EVAL_ARTIFACT_SCHEMA_VERSION),
  scenarioPackageHash: trimmedString,
  bundleHash: trimmedString,
  modelId: nullableTrimmedString,
  modelVersion: nullableTrimmedString,
  promptBundleHash: nullableTrimmedString,
  skillVersions: z.record(z.string(), trimmedString),
  toolVersions: z.record(z.string(), trimmedString),
  featureFlags: z.array(trimmedString),
  seed: z.number().int(),
  timeoutPolicy: evalTimeoutPolicySchema,
  chaosProfile: nullableTrimmedString,
  instanceRoot: nullableTrimmedString,
  nodeVersion: trimmedString,
  platform: trimmedString,
  startedAt: trimmedString,
}) as z.ZodType<EvalEnvironmentManifest>;

export const evalExternalDependencyPolicySchema = z.object({
  hermetic: z.boolean(),
  dependencies: z.array(trimmedString),
  notes: nullableTrimmedString,
}) as z.ZodType<EvalExternalDependencyPolicy>;

export const evalObservedRunReferenceSchema = z.object({
  companyId: nullableTrimmedString,
  issueId: nullableTrimmedString,
  heartbeatRunId: nullableTrimmedString,
  agentId: nullableTrimmedString,
});

export const evalReplaySpecSchema = z.object({
  sourceKind: evalRunSourceKindSchema,
  scenarioId: trimmedString,
  bundleId: trimmedString,
  lane: evalBundleLaneSchema,
  command: trimmedString,
  artifactRoot: trimmedString,
  basePackagePath: nullableTrimmedString,
  overlayLabels: z.array(trimmedString),
  featureFlags: z.array(trimmedString),
  seed: z.number().int(),
  fairnessConstraints: evalFairnessConstraintsSchema,
  externalDependencyPolicy: evalExternalDependencyPolicySchema,
  observedRun: evalObservedRunReferenceSchema.nullable(),
  env: z.record(z.string(), z.string()),
}) as z.ZodType<EvalReplaySpec>;

export const evalTraceEventSchema = z.object({
  evalRunId: trimmedString,
  scenarioId: trimmedString,
  bundleId: trimmedString,
  traceId: trimmedString,
  timestamp: trimmedString,
  eventType: trimmedString,
  eventClass: z.enum(["system", "artifact", "routing", "decision", "approval", "comment", "scenario"]),
  status: nullableTrimmedString,
  message: nullableTrimmedString,
  parentTraceId: nullableTrimmedString,
  correlationId: nullableTrimmedString,
  agentId: nullableTrimmedString,
  projectId: nullableTrimmedString,
  issueId: nullableTrimmedString,
  roomId: nullableTrimmedString,
  approvalId: nullableTrimmedString,
  artifactRef: nullableTrimmedString,
  metadata: z.record(z.string(), z.unknown()).nullable(),
}) as z.ZodType<EvalTraceEvent>;

export const evalGraderSchema = z.object({
  id: trimmedString,
  kind: evalGraderKindSchema,
  label: trimmedString,
  version: trimmedString,
  description: nullableTrimmedString,
  metricKeys: z.array(trimmedString),
}) as z.ZodType<EvalGrader>;

export const evalAcceptanceOracleSchema = z.object({
  id: trimmedString,
  label: trimmedString,
  version: trimmedString,
  description: nullableTrimmedString,
  requiredArtifacts: z.array(trimmedString),
}) as z.ZodType<EvalAcceptanceOracle>;

export const evalFailureTaxonomySchema = z.object({
  kind: evalFailureKindSchema,
  label: trimmedString,
  description: trimmedString,
  hardFailure: z.boolean(),
}) as z.ZodType<EvalFailureTaxonomy>;

export const evalFailureSchema = z.object({
  kind: evalFailureKindSchema,
  message: trimmedString,
  traceId: nullableTrimmedString,
  artifactRef: nullableTrimmedString,
  entityId: nullableTrimmedString,
}) as z.ZodType<EvalFailure>;

export const evalCoordinationTaxSchema = z.object({
  tokenCost: z.number().finite(),
  approvalWaitMinutes: z.number().finite(),
  conferenceRoomTurns: z.number().finite(),
  managerTouches: z.number().finite(),
  acceptedOutcomeCount: z.number().finite(),
});

export const evalScorecardSchema = z.object({
  scorecardVersion: z.literal(EVAL_SCORECARD_VERSION),
  runId: trimmedString,
  scenarioId: trimmedString,
  bundleId: trimmedString,
  dimension: evalDimensionSchema,
  status: evalRunStatusSchema,
  acceptedOutcome: z.boolean(),
  humanTouchMinutes: z.number().finite(),
  managerTouches: z.number().finite(),
  coordinationTax: evalCoordinationTaxSchema,
  hardChecks: z.object({
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    failures: z.array(evalFailureSchema),
  }),
  metrics: z.record(z.string(), z.number().finite().nullable()),
  rubrics: z.object({
    roleQuality: z.number().finite().nullable(),
    handoffQuality: z.number().finite().nullable(),
    decisionQuality: z.number().finite().nullable(),
    notes: z.array(trimmedString),
  }),
  acceptance: z.object({
    passed: z.boolean(),
    rationale: z.array(trimmedString),
  }),
  failureKinds: z.array(evalFailureKindSchema),
  scopeViolationCount: z.number().int().nonnegative(),
}) as z.ZodType<EvalScorecard>;

export const evalArtifactFileRefSchema = z.object({
  label: trimmedString,
  kind: trimmedString,
  relativePath: trimmedString,
  redacted: z.boolean(),
  sha256: nullableTrimmedString,
});

export const evalRunArtifactSchema = z.object({
  artifactSchemaVersion: z.literal(EVAL_ARTIFACT_SCHEMA_VERSION),
  evalContractVersion: z.literal(EVAL_CONTRACT_VERSION),
  scorecardVersion: z.literal(EVAL_SCORECARD_VERSION),
  runId: trimmedString,
  sourceKind: evalRunSourceKindSchema,
  scenario: evalScenarioSchema,
  bundle: evalBundleSchema,
  environment: evalEnvironmentManifestSchema,
  replay: evalReplaySpecSchema,
  observedRun: evalObservedRunReferenceSchema.nullable(),
  graders: z.array(evalGraderSchema),
  acceptanceOracle: evalAcceptanceOracleSchema,
  failureTaxonomy: z.array(evalFailureTaxonomySchema),
  trace: z.array(evalTraceEventSchema),
  capturedArtifacts: z.array(evalArtifactFileRefSchema),
  scorecard: evalScorecardSchema,
  startedAt: trimmedString,
  completedAt: trimmedString,
  status: evalRunStatusSchema,
  redactionMode: z.enum(["redacted", "full"]),
  notes: z.array(trimmedString),
}) as z.ZodType<EvalRunArtifact>;

export const evalStatusCountSchema = z.object({
  status: evalRunStatusSchema,
  count: z.number().int().nonnegative(),
}) as z.ZodType<EvalStatusCount>;

export const evalSummaryDimensionStatsSchema = z.object({
  dimension: evalDimensionSchema,
  totalRuns: z.number().int().nonnegative(),
  acceptedOutcomes: z.number().int().nonnegative(),
  statusCounts: z.array(evalStatusCountSchema),
  medianDurationMs: z.number().int().nonnegative().nullable(),
  p95DurationMs: z.number().int().nonnegative().nullable(),
  rolling7DayPassRate: z.number().min(0).max(1).nullable(),
  scopeViolationCount: z.number().int().nonnegative(),
}) as z.ZodType<EvalSummaryDimensionStats>;

export const evalSummaryScenarioEntrySchema = z.object({
  scenarioId: trimmedString,
  title: trimmedString,
  dimension: evalDimensionSchema,
  layer: evalLayerSchema,
  horizonBucket: evalHorizonBucketSchema,
  latestRunId: nullableTrimmedString,
  latestStatus: evalRunStatusSchema.nullable(),
  lastCompletedAt: nullableTrimmedString,
  runCount: z.number().int().nonnegative(),
  acceptedOutcomes: z.number().int().nonnegative(),
}) as z.ZodType<EvalSummaryScenarioEntry>;

export const evalRunListItemSchema = z.object({
  runId: trimmedString,
  sourceKind: evalRunSourceKindSchema,
  scenarioId: trimmedString,
  scenarioTitle: trimmedString,
  bundleId: trimmedString,
  bundleLabel: trimmedString,
  dimension: evalDimensionSchema,
  layer: evalLayerSchema,
  horizonBucket: evalHorizonBucketSchema,
  status: evalRunStatusSchema,
  acceptedOutcome: z.boolean(),
  startedAt: trimmedString,
  completedAt: trimmedString,
  durationMs: z.number().int().nonnegative(),
  artifactDirectory: z.string(),
  failureKinds: z.array(evalFailureKindSchema),
  tags: z.array(trimmedString),
});

export const evalSummaryIndexSchema = z.object({
  artifactSchemaVersion: z.literal(EVAL_ARTIFACT_SCHEMA_VERSION),
  evalContractVersion: z.literal(EVAL_CONTRACT_VERSION),
  scorecardVersion: z.literal(EVAL_SCORECARD_VERSION),
  generatedAt: trimmedString,
  runCount: z.number().int().nonnegative(),
  latestRunId: nullableTrimmedString,
  statusCounts: z.array(evalStatusCountSchema),
  dimensions: z.array(evalSummaryDimensionStatsSchema),
  scenarios: z.array(evalSummaryScenarioEntrySchema),
  failingScenarios: z.array(evalSummaryScenarioEntrySchema),
  runs: z.array(evalRunListItemSchema),
}) as z.ZodType<EvalSummaryIndex>;

export const componentEvalAdapterTypeSchema = (
  z.enum(["codex_local", "claude_local"])
) as z.ZodType<ComponentEvalAdapterType>;

export const componentEvalExecutionStatusSchema = z.enum([
  "succeeded",
  "failed",
  "timed_out",
  "blocked",
  "invalid",
]) as z.ZodType<ComponentEvalExecutionStatus>;

export const componentEvalTraceSummarySchema = z.object({
  eventKinds: z.array(trimmedString),
  toolNames: z.array(trimmedString),
  sessionId: nullableTrimmedString,
  warnings: z.array(trimmedString),
}) as z.ZodType<ComponentEvalTraceSummary>;

export const componentEvalRunRequestSchema = z.object({
  caseId: trimmedString,
  adapterType: componentEvalAdapterTypeSchema,
  prompt: trimmedString,
  vars: z.record(z.string(), z.unknown()),
  timeoutMs: z.number().int().positive().max(10 * 60 * 1000).optional(),
}) as z.ZodType<ComponentEvalRunRequest>;

export const componentEvalRunResultSchema = z.object({
  executionStatus: componentEvalExecutionStatusSchema,
  adapterType: componentEvalAdapterTypeSchema,
  modelId: nullableTrimmedString,
  finalText: z.string(),
  durationMs: z.number().int().nonnegative(),
  stderrExcerpt: nullableTrimmedString,
  traceSummary: componentEvalTraceSummarySchema,
  rawTranscript: z.array(z.unknown()).nullable(),
  errorMessage: nullableTrimmedString,
}) as z.ZodType<ComponentEvalRunResult>;
