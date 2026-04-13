import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  DEFAULT_EVAL_FAILURE_TAXONOMY,
  EVAL_ARTIFACT_SCHEMA_VERSION,
  EVAL_CONTRACT_VERSION,
  EVAL_SCORECARD_VERSION,
  evalRunArtifactSchema,
  evalSummaryIndexSchema,
  rebuildEvalSummaryIndex,
  summarizeEvalRunArtifact,
  validateEvalTraceCompleteness,
  type EvalBundle,
  type EvalRunArtifact,
  type EvalScenario,
  type EvalScorecard,
  type EvalTraceEvent,
} from "../../packages/shared/src/index.js";
import { resolvePaperclipInstanceRoot } from "../../server/src/home-paths.js";

const execFileAsync = promisify(execFile);

function toPosixPath(value: string) {
  return value.split(path.sep).join("/");
}

async function ensureDir(dirPath: string) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function writeJson(filePath: string, value: unknown) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(filePath: string, value: string) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, value, "utf8");
}

async function hashFile(filePath: string) {
  const contents = await fs.readFile(filePath);
  return createHash("sha256").update(contents).digest("hex");
}

async function hashDirectory(dirPath: string) {
  const hash = createHash("sha256");

  async function visit(currentPath: string) {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const nextPath = path.join(currentPath, entry.name);
      const relativePath = toPosixPath(path.relative(dirPath, nextPath));
      hash.update(relativePath);
      if (entry.isDirectory()) {
        await visit(nextPath);
        continue;
      }
      const contents = await fs.readFile(nextPath);
      hash.update(contents);
    }
  }

  await visit(dirPath);
  return hash.digest("hex");
}

async function listFixtureFiles(dirPath: string) {
  const files: string[] = [];

  async function visit(currentPath: string) {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const nextPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await visit(nextPath);
        continue;
      }
      files.push(toPosixPath(path.relative(dirPath, nextPath)));
    }
  }

  await visit(dirPath);
  return files;
}

async function safeGitSha(repoRoot: string) {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
    return stdout.trim() || "unknown";
  } catch {
    return "unknown";
  }
}

function bundleRuntimeShape(bundle: EvalBundle) {
  if (bundle.baselineKind === "single_strong_worker") {
    return { managerTouches: 0, tokenCost: 750, conferenceRoomTurns: 0, approvalWaitMinutes: 0 };
  }
  if (bundle.baselineKind === "flat_pod") {
    return { managerTouches: 2, tokenCost: 930, conferenceRoomTurns: 1, approvalWaitMinutes: 2 };
  }
  if (bundle.baselineKind === "full_hierarchy") {
    return { managerTouches: 4, tokenCost: 1180, conferenceRoomTurns: 2, approvalWaitMinutes: 4 };
  }
  if (bundle.ablationKind === "remove_packet_conventions") {
    return { managerTouches: 1, tokenCost: 890, conferenceRoomTurns: 1, approvalWaitMinutes: 1 };
  }
  return { managerTouches: 2, tokenCost: 980, conferenceRoomTurns: 1, approvalWaitMinutes: 1 };
}

function buildScenarioSpecificEvent(
  scenario: EvalScenario,
  runId: string,
  bundleId: string,
  timestamp: string,
): EvalTraceEvent {
  const base = {
    evalRunId: runId,
    scenarioId: scenario.id,
    bundleId,
    timestamp,
    status: "ok",
    parentTraceId: "trace-start",
    correlationId: "corr-1",
    artifactRef: null,
    metadata: { seeded: true },
  } as const;

  switch (scenario.layer) {
    case "invariant":
      return {
        ...base,
        traceId: "trace-routing",
        eventType: "scope_guard_checked",
        eventClass: "routing",
        message: "Worker scope isolation validated.",
        agentId: "worker-1",
        projectId: "project-platform",
        issueId: "ISSUE-1",
        roomId: null,
        approvalId: null,
      };
    case "handoff":
      return {
        ...base,
        traceId: "trace-handoff",
        eventType: "handoff_recorded",
        eventClass: "comment",
        message: "Director summary handed off to tech lead.",
        agentId: "director-1",
        projectId: "project-platform",
        issueId: "ISSUE-2",
        roomId: "room-platform",
        approvalId: null,
      };
    case "role":
      return {
        ...base,
        traceId: "trace-role",
        eventType: "leadership_route_confirmed",
        eventClass: "routing",
        message: "Leadership routing preserved.",
        agentId: "vp-eng",
        projectId: "project-platform",
        issueId: "ISSUE-3",
        roomId: "room-portfolio",
        approvalId: null,
      };
    case "workflow":
      return {
        ...base,
        traceId: "trace-approval",
        eventType: "approval_linked",
        eventClass: "approval",
        message: "Room decision resolved through approval.",
        agentId: "tech-lead-1",
        projectId: "project-platform",
        issueId: "ISSUE-4",
        roomId: "room-architecture",
        approvalId: "approval-1",
      };
    case "portfolio":
      return {
        ...base,
        traceId: "trace-portfolio",
        eventType: "bundle_comparison_recorded",
        eventClass: "decision",
        message: "Utility bundle comparison captured.",
        agentId: "director-portfolio",
        projectId: "project-platform",
        issueId: "ISSUE-5",
        roomId: "room-executive",
        approvalId: null,
      };
    case "soak":
    default:
      return {
        ...base,
        traceId: "trace-soak",
        eventType: "resume_checkpoint",
        eventClass: "routing",
        message: "Restart and resume checkpoint reached.",
        agentId: "team-lead-1",
        projectId: "project-runtime",
        issueId: "ISSUE-6",
        roomId: "room-incident",
        approvalId: null,
      };
  }
}

export async function materializeScenarioFixture(input: {
  repoRoot: string;
  scenario: EvalScenario;
}) {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-eval-fixture-"));
  const sourceDir = path.resolve(input.repoRoot, input.scenario.fixture.basePackagePath);
  const targetDir = path.join(fixtureRoot, "company-package");
  await fs.cp(sourceDir, targetDir, { recursive: true });

  for (const overlay of input.scenario.fixture.overlays) {
    for (const file of overlay.files) {
      const targetFile = path.join(targetDir, file.path);
      await ensureDir(path.dirname(targetFile));
      if (file.mode === "append") {
        const existing = await fs.readFile(targetFile, "utf8").catch(() => "");
        await fs.writeFile(targetFile, `${existing}${file.content}`, "utf8");
        continue;
      }
      await fs.writeFile(targetFile, file.content, "utf8");
    }
  }

  return {
    fixtureRoot,
    targetDir,
    cleanup: async () => {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    },
  };
}

function defaultArtifactRoot() {
  return path.join(resolvePaperclipInstanceRoot(), "data", "evals", "architecture");
}

export async function executeSeededRun(input: {
  repoRoot: string;
  scenario: EvalScenario;
  bundle: EvalBundle;
  artifactRoot?: string;
  seed?: number;
}) {
  const artifactRoot = input.artifactRoot ?? defaultArtifactRoot();
  const seed = input.seed ?? 7;
  const materialized = await materializeScenarioFixture({
    repoRoot: input.repoRoot,
    scenario: input.scenario,
  });

  const startedAt = new Date().toISOString();
  const runId = `${input.scenario.id}-${input.bundle.id}-${Date.now()}`;
  const runDir = path.join(artifactRoot, "runs", runId);
  const gitSha = await safeGitSha(input.repoRoot);
  const scenarioPackageHash = await hashDirectory(materialized.targetDir);
  const bundleHash = createHash("sha256").update(JSON.stringify(input.bundle)).digest("hex");
  const fixtureFiles = await listFixtureFiles(materialized.targetDir);
  const runtimeShape = bundleRuntimeShape(input.bundle);

  await ensureDir(runDir);
  const relativeManifestPath = toPosixPath(path.join("runs", runId, "manifest.json"));
  const relativeTracePath = toPosixPath(path.join("runs", runId, "trace.ndjson"));
  const relativeScorecardPath = toPosixPath(path.join("runs", runId, "scorecard.json"));
  const relativeReplayPath = toPosixPath(path.join("runs", runId, "replay.json"));
  const relativeFixtureTreePath = toPosixPath(path.join("runs", runId, "artifacts", "fixture-tree.json"));
  const relativeSummaryEntryPath = toPosixPath(path.join("runs", runId, "summary-entry.json"));

  const trace: EvalTraceEvent[] = [
    {
      evalRunId: runId,
      scenarioId: input.scenario.id,
      bundleId: input.bundle.id,
      traceId: "trace-start",
      timestamp: startedAt,
      eventType: "scenario_started",
      eventClass: "scenario",
      status: "started",
      message: `Seeded scenario '${input.scenario.title}' started.`,
      parentTraceId: null,
      correlationId: "corr-1",
      agentId: null,
      projectId: null,
      issueId: null,
      roomId: null,
      approvalId: null,
      artifactRef: relativeManifestPath,
      metadata: {
        lane: input.bundle.lane,
        hermetic: input.scenario.fixture.hermetic,
      },
    },
    buildScenarioSpecificEvent(
      input.scenario,
      runId,
      input.bundle.id,
      new Date(Date.now() + 1_000).toISOString(),
    ),
    {
      evalRunId: runId,
      scenarioId: input.scenario.id,
      bundleId: input.bundle.id,
      traceId: "trace-artifact",
      timestamp: new Date(Date.now() + 2_000).toISOString(),
      eventType: "artifact_materialized",
      eventClass: "artifact",
      status: "ok",
      message: "Seeded artifacts written.",
      parentTraceId: "trace-start",
      correlationId: "corr-1",
      agentId: null,
      projectId: null,
      issueId: null,
      roomId: null,
      approvalId: null,
      artifactRef: relativeFixtureTreePath,
      metadata: {
        artifactCount: 5,
      },
    },
  ];

  const completedAt = new Date(Date.now() + 3_000).toISOString();
  trace.push({
    evalRunId: runId,
    scenarioId: input.scenario.id,
    bundleId: input.bundle.id,
    traceId: "trace-complete",
    timestamp: completedAt,
    eventType: "scenario_completed",
    eventClass: "scenario",
    status: "passed",
    message: `Seeded scenario '${input.scenario.title}' completed.`,
    parentTraceId: "trace-start",
    correlationId: "corr-1",
    agentId: null,
    projectId: null,
    issueId: null,
    roomId: null,
    approvalId: null,
    artifactRef: relativeScorecardPath,
    metadata: {
      lane: input.bundle.lane,
    },
  });

  const scorecard: EvalScorecard = {
    scorecardVersion: EVAL_SCORECARD_VERSION,
    runId,
    scenarioId: input.scenario.id,
    bundleId: input.bundle.id,
    dimension: input.scenario.dimension,
    status: "passed",
    acceptedOutcome: true,
    humanTouchMinutes: 0,
    managerTouches: runtimeShape.managerTouches,
    coordinationTax: {
      tokenCost: runtimeShape.tokenCost,
      approvalWaitMinutes: runtimeShape.approvalWaitMinutes,
      conferenceRoomTurns: runtimeShape.conferenceRoomTurns,
      managerTouches: runtimeShape.managerTouches,
      acceptedOutcomeCount: 1,
    },
    hardChecks: {
      passed: 3,
      failed: 0,
      failures: [],
    },
    metrics: {
      durationMs: 3_000,
      retries: 0,
      issueAgeP95Minutes: input.scenario.dimension === "stability" ? 30 : 10,
      queueDepth: input.bundle.baselineKind === "single_strong_worker" ? 1 : 2,
      tokenCost: runtimeShape.tokenCost,
    },
    rubrics: {
      roleQuality: 1,
      handoffQuality: input.scenario.layer === "handoff" ? 1 : null,
      decisionQuality: input.scenario.layer === "workflow" || input.scenario.layer === "portfolio" ? 1 : null,
      notes: [`Seeded ${input.bundle.lane} run.`],
    },
    acceptance: {
      passed: true,
      rationale: [
        "Required artifacts present",
        "No hard-check failures",
        "Seeded scenario completed",
      ],
    },
    failureKinds: [],
    scopeViolationCount: 0,
  };

  const artifact: EvalRunArtifact = {
    artifactSchemaVersion: EVAL_ARTIFACT_SCHEMA_VERSION,
    evalContractVersion: EVAL_CONTRACT_VERSION,
    scorecardVersion: EVAL_SCORECARD_VERSION,
    runId,
    scenario: input.scenario,
    bundle: input.bundle,
    environment: {
      repoRoot: input.repoRoot,
      gitSha,
      evalContractVersion: EVAL_CONTRACT_VERSION,
      scorecardVersion: EVAL_SCORECARD_VERSION,
      artifactSchemaVersion: EVAL_ARTIFACT_SCHEMA_VERSION,
      scenarioPackageHash,
      bundleHash,
      modelId: "seeded-paperclip-runner",
      modelVersion: "seeded-paperclip-runner",
      promptBundleHash: null,
      skillVersions: { paperclip: "wave-1" },
      toolVersions: { git: "system" },
      featureFlags: input.bundle.featureFlags,
      seed,
      timeoutPolicy: input.scenario.timeoutPolicy,
      chaosProfile: input.scenario.chaosProfile,
      instanceRoot: resolvePaperclipInstanceRoot(),
      nodeVersion: process.version,
      platform: `${process.platform}-${process.arch}`,
      startedAt,
    },
    replay: {
      scenarioId: input.scenario.id,
      bundleId: input.bundle.id,
      lane: input.bundle.lane,
      command: `pnpm evals:architecture${input.bundle.lane === "canary" ? ":canary" : input.bundle.lane === "nightly" ? ":nightly" : input.bundle.lane === "soak" ? ":soak" : ":baseline"}`,
      artifactRoot,
      basePackagePath: path.resolve(input.repoRoot, input.scenario.fixture.basePackagePath),
      overlayLabels: input.scenario.fixture.overlays.map((overlay) => overlay.label),
      featureFlags: input.bundle.featureFlags,
      seed,
      fairnessConstraints: input.scenario.fairnessConstraints,
      externalDependencyPolicy: {
        hermetic: input.scenario.fixture.hermetic,
        dependencies: input.scenario.fixture.externalDependencies,
        notes: input.scenario.fixture.externalDependencies.length > 0
          ? "Live dependencies declared by scenario metadata."
          : null,
      },
      env: {
        NODE_ENV: process.env.NODE_ENV ?? "development",
      },
    },
    graders: [
      {
        id: "hard-check.seeded",
        kind: "hard_check",
        label: "Seeded hard checks",
        version: "1",
        description: "Deterministic seeded hard checks for Wave 1 architecture evals.",
        metricKeys: ["durationMs", "tokenCost"],
      },
      {
        id: "metrics.seeded",
        kind: "metric_extractor",
        label: "Seeded metric extractor",
        version: "1",
        description: "Deterministic seeded metric extractor.",
        metricKeys: ["queueDepth", "issueAgeP95Minutes"],
      },
      {
        id: "rubric.seeded",
        kind: "rubric",
        label: "Seeded rubric grader",
        version: "1",
        description: "Deterministic seeded rubric grader.",
        metricKeys: ["roleQuality", "handoffQuality", "decisionQuality"],
      },
      {
        id: "acceptance.seeded",
        kind: "acceptance_oracle",
        label: "Seeded acceptance oracle",
        version: "1",
        description: "Accepted outcome = required artifacts present + no hard-check failures + oracle passes.",
        metricKeys: [],
      },
    ],
    acceptanceOracle: {
      id: "accepted.seeded",
      label: "Accepted outcome",
      version: "1",
      description: "Accepted outcome = required artifacts present + no hard-check failures + oracle passes.",
      requiredArtifacts: input.scenario.requiredArtifacts,
    },
    failureTaxonomy: DEFAULT_EVAL_FAILURE_TAXONOMY,
    trace,
    capturedArtifacts: [
      { label: "manifest", kind: "manifest", relativePath: relativeManifestPath, redacted: true, sha256: null },
      { label: "trace", kind: "trace", relativePath: relativeTracePath, redacted: true, sha256: null },
      { label: "scorecard", kind: "scorecard", relativePath: relativeScorecardPath, redacted: true, sha256: null },
      { label: "replay", kind: "replay", relativePath: relativeReplayPath, redacted: true, sha256: null },
      { label: "fixture-tree", kind: "fixture-tree", relativePath: relativeFixtureTreePath, redacted: true, sha256: null },
    ],
    scorecard,
    startedAt,
    completedAt,
    status: "passed",
    redactionMode: "redacted",
    notes: [`Seeded ${input.bundle.lane} run for ${input.scenario.id}.`],
  };

  const manifest = {
    runId,
    scenarioId: input.scenario.id,
    bundleId: input.bundle.id,
    startedAt,
    completedAt,
    status: artifact.status,
    versions: {
      evalContractVersion: EVAL_CONTRACT_VERSION,
      scorecardVersion: EVAL_SCORECARD_VERSION,
      artifactSchemaVersion: EVAL_ARTIFACT_SCHEMA_VERSION,
    },
    environment: artifact.environment,
  };

  const summaryEntry = summarizeEvalRunArtifact(artifact);

  await writeJson(path.join(runDir, "manifest.json"), manifest);
  await writeText(path.join(runDir, "trace.ndjson"), `${trace.map((event) => JSON.stringify(event)).join("\n")}\n`);
  await writeJson(path.join(runDir, "scorecard.json"), scorecard);
  await writeJson(path.join(runDir, "replay.json"), artifact.replay);
  await writeJson(path.join(runDir, "summary-entry.json"), summaryEntry);
  await writeJson(path.join(runDir, "artifacts", "fixture-tree.json"), {
    basePackagePath: artifact.replay.basePackagePath,
    files: fixtureFiles,
  });
  await writeJson(path.join(runDir, "artifact.json"), artifact);

  for (const capturedArtifact of artifact.capturedArtifacts) {
    const absolutePath = path.join(artifactRoot, capturedArtifact.relativePath);
    capturedArtifact.sha256 = await hashFile(absolutePath);
  }
  await writeJson(path.join(runDir, "artifact.json"), artifact);

  const completenessFailures = validateEvalTraceCompleteness(artifact);
  if (completenessFailures.length > 0) {
    throw new Error(`Seeded eval artifact '${runId}' failed trace completeness: ${completenessFailures[0]?.message}`);
  }

  await materialized.cleanup();
  return evalRunArtifactSchema.parse(artifact);
}

export async function loadArtifactsFromRoot(artifactRoot: string) {
  const runsDir = path.join(artifactRoot, "runs");
  const entries = await fs.readdir(runsDir, { withFileTypes: true }).catch(() => []);
  const artifacts: EvalRunArtifact[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const artifactPath = path.join(runsDir, entry.name, "artifact.json");
    const raw = await fs.readFile(artifactPath, "utf8").catch(() => null);
    if (!raw) continue;
    artifacts.push(evalRunArtifactSchema.parse(JSON.parse(raw)));
  }
  return artifacts;
}

export async function rebuildSummaryFromArtifactRoot(artifactRoot: string) {
  const artifacts = await loadArtifactsFromRoot(artifactRoot);
  const summary = rebuildEvalSummaryIndex(artifacts);
  await writeJson(path.join(artifactRoot, "summary", "index.json"), summary);
  return evalSummaryIndexSchema.parse(summary);
}

export async function runSeededLane(input: {
  repoRoot: string;
  artifactRoot?: string;
  bundle: EvalBundle;
  scenarios: EvalScenario[];
  seed?: number;
}) {
  const artifactRoot = input.artifactRoot ?? defaultArtifactRoot();
  await ensureDir(artifactRoot);
  const artifacts: EvalRunArtifact[] = [];
  for (const scenario of input.scenarios) {
    artifacts.push(await executeSeededRun({
      repoRoot: input.repoRoot,
      scenario,
      bundle: input.bundle,
      artifactRoot,
      seed: input.seed,
    }));
  }
  const summary = await rebuildSummaryFromArtifactRoot(artifactRoot);
  return { artifacts, summary };
}

export function getDefaultArtifactRoot() {
  return defaultArtifactRoot();
}
