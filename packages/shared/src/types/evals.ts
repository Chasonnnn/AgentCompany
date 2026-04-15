import type {
  EvalDimension,
  EvalFailureKind,
  EvalGraderKind,
  EvalHorizonBucket,
  EvalLayer,
  EvalRunStatus,
} from "../evals.js";

export interface EvalFairnessConstraints {
  budgetCeilingUsd: number | null;
  timeCeilingMinutes: number | null;
  tools: string[];
  repoState: string;
  approvalPolicy: string;
  successCriteria: string[];
}

export interface EvalScenarioOverlayFile {
  path: string;
  content: string;
  mode: "replace" | "append";
}

export interface EvalScenarioOverlay {
  label: string;
  files: EvalScenarioOverlayFile[];
  cleanup: "delete" | "retain_on_failure" | "retain";
}

export type EvalRunSourceKind = "seeded" | "observed";

export interface EvalPortableScenarioFixture {
  kind: "portable_company_package";
  basePackagePath: string;
  overlays: EvalScenarioOverlay[];
  hermetic: boolean;
  externalDependencies: string[];
}

export interface EvalObservedScenarioFixture {
  kind: "observed_issue_continuity";
  lookbackHours: number;
  maxRuns: number;
  hermetic: false;
  externalDependencies: string[];
}

export type EvalScenarioFixture = EvalPortableScenarioFixture | EvalObservedScenarioFixture;

export interface EvalTimeoutPolicy {
  maxMinutes: number;
  idleMinutes: number | null;
}

export interface EvalScenario {
  id: string;
  title: string;
  description: string | null;
  dimension: EvalDimension;
  layer: EvalLayer;
  horizonBucket: EvalHorizonBucket;
  canary: boolean;
  tags: string[];
  fixture: EvalScenarioFixture;
  fairnessConstraints: EvalFairnessConstraints;
  timeoutPolicy: EvalTimeoutPolicy;
  requiredArtifacts: string[];
  chaosProfile: string | null;
}

export interface EvalBundle {
  id: string;
  label: string;
  description: string | null;
  lane: "component" | "canary" | "nightly" | "soak" | "baseline";
  scenarioIds: string[];
  featureFlags: string[];
  baselineKind:
    | "single_strong_worker"
    | "flat_pod"
    | "full_hierarchy"
    | null;
  ablationKind:
    | "remove_vp_layer"
    | "remove_conference_rooms"
    | "remove_consultant_path"
    | "collapse_director_and_tech_lead"
    | "remove_packet_conventions"
    | null;
}

export interface EvalEnvironmentManifest {
  repoRoot: string;
  gitSha: string;
  evalContractVersion: number;
  scorecardVersion: number;
  artifactSchemaVersion: number;
  scenarioPackageHash: string;
  bundleHash: string;
  modelId: string | null;
  modelVersion: string | null;
  promptBundleHash: string | null;
  skillVersions: Record<string, string>;
  toolVersions: Record<string, string>;
  featureFlags: string[];
  seed: number;
  timeoutPolicy: EvalTimeoutPolicy;
  chaosProfile: string | null;
  instanceRoot: string | null;
  nodeVersion: string;
  platform: string;
  startedAt: string;
}

export interface EvalObservedRunReference {
  companyId: string | null;
  issueId: string | null;
  heartbeatRunId: string | null;
  agentId: string | null;
}

export interface EvalExternalDependencyPolicy {
  hermetic: boolean;
  dependencies: string[];
  notes: string | null;
}

export interface EvalReplaySpec {
  sourceKind: EvalRunSourceKind;
  scenarioId: string;
  bundleId: string;
  lane: EvalBundle["lane"];
  command: string;
  artifactRoot: string;
  basePackagePath: string | null;
  overlayLabels: string[];
  featureFlags: string[];
  seed: number;
  fairnessConstraints: EvalFairnessConstraints;
  externalDependencyPolicy: EvalExternalDependencyPolicy;
  observedRun: EvalObservedRunReference | null;
  env: Record<string, string>;
}

export interface EvalTraceEvent {
  evalRunId: string;
  scenarioId: string;
  bundleId: string;
  traceId: string;
  timestamp: string;
  eventType: string;
  eventClass: "system" | "artifact" | "routing" | "decision" | "approval" | "comment" | "scenario";
  status: string | null;
  message: string | null;
  parentTraceId: string | null;
  correlationId: string | null;
  agentId: string | null;
  projectId: string | null;
  issueId: string | null;
  roomId: string | null;
  approvalId: string | null;
  artifactRef: string | null;
  metadata: Record<string, unknown> | null;
}

export interface EvalGrader {
  id: string;
  kind: EvalGraderKind;
  label: string;
  version: string;
  description: string | null;
  metricKeys: string[];
}

export interface EvalAcceptanceOracle {
  id: string;
  label: string;
  version: string;
  description: string | null;
  requiredArtifacts: string[];
}

export interface EvalFailureTaxonomy {
  kind: EvalFailureKind;
  label: string;
  description: string;
  hardFailure: boolean;
}

export interface EvalFailure {
  kind: EvalFailureKind;
  message: string;
  traceId: string | null;
  artifactRef: string | null;
  entityId: string | null;
}

export interface EvalCoordinationTax {
  tokenCost: number;
  approvalWaitMinutes: number;
  conferenceRoomTurns: number;
  managerTouches: number;
  acceptedOutcomeCount: number;
}

export interface EvalAcceptanceResult {
  passed: boolean;
  rationale: string[];
}

export interface EvalRubricScores {
  roleQuality: number | null;
  handoffQuality: number | null;
  decisionQuality: number | null;
  notes: string[];
}

export interface EvalScorecard {
  scorecardVersion: number;
  runId: string;
  scenarioId: string;
  bundleId: string;
  dimension: EvalDimension;
  status: EvalRunStatus;
  acceptedOutcome: boolean;
  humanTouchMinutes: number;
  managerTouches: number;
  coordinationTax: EvalCoordinationTax;
  hardChecks: {
    passed: number;
    failed: number;
    failures: EvalFailure[];
  };
  metrics: Record<string, number | null>;
  rubrics: EvalRubricScores;
  acceptance: EvalAcceptanceResult;
  failureKinds: EvalFailureKind[];
  scopeViolationCount: number;
}

export interface EvalArtifactFileRef {
  label: string;
  kind: string;
  relativePath: string;
  redacted: boolean;
  sha256: string | null;
}

export interface EvalRunArtifact {
  artifactSchemaVersion: number;
  evalContractVersion: number;
  scorecardVersion: number;
  runId: string;
  sourceKind: EvalRunSourceKind;
  scenario: EvalScenario;
  bundle: EvalBundle;
  environment: EvalEnvironmentManifest;
  replay: EvalReplaySpec;
  observedRun: EvalObservedRunReference | null;
  graders: EvalGrader[];
  acceptanceOracle: EvalAcceptanceOracle;
  failureTaxonomy: EvalFailureTaxonomy[];
  trace: EvalTraceEvent[];
  capturedArtifacts: EvalArtifactFileRef[];
  scorecard: EvalScorecard;
  startedAt: string;
  completedAt: string;
  status: EvalRunStatus;
  redactionMode: "redacted" | "full";
  notes: string[];
}

export interface EvalStatusCount {
  status: EvalRunStatus;
  count: number;
}

export interface EvalRunListItem {
  runId: string;
  sourceKind: EvalRunSourceKind;
  scenarioId: string;
  scenarioTitle: string;
  bundleId: string;
  bundleLabel: string;
  dimension: EvalDimension;
  layer: EvalLayer;
  horizonBucket: EvalHorizonBucket;
  status: EvalRunStatus;
  acceptedOutcome: boolean;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  artifactDirectory: string;
  failureKinds: EvalFailureKind[];
  tags: string[];
}

export interface EvalSummaryDimensionStats {
  dimension: EvalDimension;
  totalRuns: number;
  acceptedOutcomes: number;
  statusCounts: EvalStatusCount[];
  medianDurationMs: number | null;
  p95DurationMs: number | null;
  rolling7DayPassRate: number | null;
  scopeViolationCount: number;
}

export interface EvalSummaryScenarioEntry {
  scenarioId: string;
  title: string;
  dimension: EvalDimension;
  layer: EvalLayer;
  horizonBucket: EvalHorizonBucket;
  latestRunId: string | null;
  latestStatus: EvalRunStatus | null;
  lastCompletedAt: string | null;
  runCount: number;
  acceptedOutcomes: number;
}

export interface EvalSummaryIndex {
  artifactSchemaVersion: number;
  evalContractVersion: number;
  scorecardVersion: number;
  generatedAt: string;
  runCount: number;
  latestRunId: string | null;
  statusCounts: EvalStatusCount[];
  dimensions: EvalSummaryDimensionStats[];
  scenarios: EvalSummaryScenarioEntry[];
  failingScenarios: EvalSummaryScenarioEntry[];
  runs: EvalRunListItem[];
}
