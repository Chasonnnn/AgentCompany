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
  type EvalFailure,
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

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

async function observedDatabaseUrl() {
  const { resolveDatabaseTarget } = await import("../../packages/db/src/runtime-config.js");
  const target = resolveDatabaseTarget();
  if (target.mode === "postgres") {
    return target.connectionString;
  }
  return `postgres://paperclip:paperclip@127.0.0.1:${target.port}/paperclip`;
}

function portableFixtureOrThrow(scenario: EvalScenario) {
  if (scenario.fixture.kind !== "portable_company_package") {
    throw new Error(`Scenario '${scenario.id}' does not use a portable company package fixture.`);
  }
  return scenario.fixture;
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
  const fixture = portableFixtureOrThrow(input.scenario);
  const sourceDir = path.resolve(input.repoRoot, fixture.basePackagePath);
  const targetDir = path.join(fixtureRoot, "company-package");
  await fs.cp(sourceDir, targetDir, { recursive: true });

  for (const overlay of fixture.overlays) {
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

async function listObservedIssueRuns(input: {
  lookbackHours: number;
  maxRuns: number;
}) {
  const [{ and, desc, gte, sql }, { createDb, heartbeatRuns }] = await Promise.all([
    import("../../packages/db/node_modules/drizzle-orm"),
    import("../../packages/db/src/index.js"),
  ]);
  const db = createDb(await observedDatabaseUrl());
  const since = new Date(Date.now() - input.lookbackHours * 60 * 60 * 1000);
  return db
    .select({
      id: heartbeatRuns.id,
      companyId: heartbeatRuns.companyId,
      agentId: heartbeatRuns.agentId,
      status: heartbeatRuns.status,
      startedAt: heartbeatRuns.startedAt,
      finishedAt: heartbeatRuns.finishedAt,
      createdAt: heartbeatRuns.createdAt,
      error: heartbeatRuns.error,
      errorCode: heartbeatRuns.errorCode,
      processLossRetryCount: heartbeatRuns.processLossRetryCount,
      contextSnapshot: heartbeatRuns.contextSnapshot,
    })
    .from(heartbeatRuns)
    .where(and(
      gte(heartbeatRuns.createdAt, since),
      sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' is not null`,
    ))
    .orderBy(desc(heartbeatRuns.createdAt))
    .limit(input.maxRuns);
}

async function executeObservedRun(input: {
  repoRoot: string;
  artifactRoot?: string;
  lookbackHours: number;
  maxRuns: number;
  run: Awaited<ReturnType<typeof listObservedIssueRuns>>[number];
  seed?: number;
}) {
  const artifactRoot = input.artifactRoot ?? defaultArtifactRoot();
  const seed = input.seed ?? 7;
  const [{ and, desc, eq, inArray }, dbModule, { issueContinuityService }] = await Promise.all([
    import("../../packages/db/node_modules/drizzle-orm"),
    import("../../packages/db/src/index.js"),
    import("../../server/src/services/issue-continuity.js"),
  ]);
  const {
    activityLog,
    approvals,
    createDb,
    documentRevisions,
    heartbeatRuns,
    issueApprovals,
    issueComments,
    issueDocuments,
    issues,
  } = dbModule;
  const db = createDb(await observedDatabaseUrl());
  const continuitySvc = issueContinuityService(db);
  const gitSha = await safeGitSha(input.repoRoot);
  const contextSnapshot = asRecord(input.run.contextSnapshot);
  const issueId = readString(contextSnapshot.issueId);
  const issue = issueId
    ? await db
        .select({
          id: issues.id,
          companyId: issues.companyId,
          identifier: issues.identifier,
          title: issues.title,
          projectId: issues.projectId,
          continuityState: issues.continuityState,
        })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null)
    : null;
  const continuity = issueId ? await continuitySvc.getIssueContinuity(issueId) : null;

  const observedReference = {
    companyId: input.run.companyId,
    issueId,
    heartbeatRunId: input.run.id,
    agentId: input.run.agentId,
  };
  const scenario: EvalScenario = {
    id: `observed-${input.run.id}`,
    title: `Observed continuity trace ${issue?.identifier ?? input.run.id}`,
    description: issue?.title ?? "Observed runtime continuity trace.",
    dimension: "stability",
    layer: "workflow",
    horizonBucket: "1_4h",
    canary: false,
    tags: ["observed", "continuity", "runtime"],
    fixture: {
      kind: "observed_issue_continuity",
      lookbackHours: input.lookbackHours,
      maxRuns: input.maxRuns,
      hermetic: false,
      externalDependencies: ["runtime_database"],
    },
    fairnessConstraints: {
      budgetCeilingUsd: null,
      timeCeilingMinutes: 180,
      tools: ["heartbeat", "documents", "approvals", "activity_log"],
      repoState: "observed-runtime",
      approvalPolicy: "runtime-observed",
      successCriteria: [
        "trace completeness holds",
        "continuity bundle resumes cleanly",
        "continuity-specific failures are classified",
      ],
    },
    timeoutPolicy: { maxMinutes: 180, idleMinutes: null },
    requiredArtifacts: ["manifest", "trace", "scorecard", "replay", "observed-evidence"],
    chaosProfile: null,
  };
  const bundle: EvalBundle = {
    id: "observed-continuity-nightly",
    label: "Observed continuity nightly",
    description: "Nightly observed continuity trace capture from issue-backed heartbeat runs.",
    lane: "nightly",
    scenarioIds: [scenario.id],
    featureFlags: ["observed_continuity"],
    baselineKind: null,
    ablationKind: null,
  };

  const runId = `${scenario.id}-${Date.now()}`;
  const runDir = path.join(artifactRoot, "runs", runId);
  const startedAt = input.run.startedAt?.toISOString?.() ?? input.run.createdAt.toISOString();
  const completedAt = input.run.finishedAt?.toISOString?.() ?? input.run.createdAt.toISOString();
  const relativeManifestPath = toPosixPath(path.join("runs", runId, "manifest.json"));
  const relativeTracePath = toPosixPath(path.join("runs", runId, "trace.ndjson"));
  const relativeScorecardPath = toPosixPath(path.join("runs", runId, "scorecard.json"));
  const relativeReplayPath = toPosixPath(path.join("runs", runId, "replay.json"));
  const relativeObservedEvidencePath = toPosixPath(path.join("runs", runId, "artifacts", "observed-evidence.json"));
  const relativeSummaryEntryPath = toPosixPath(path.join("runs", runId, "summary-entry.json"));

  await ensureDir(runDir);

  const documentRows = issueId
    ? await db
        .select({
          key: issueDocuments.key,
          documentId: issueDocuments.documentId,
          updatedAt: issueDocuments.updatedAt,
        })
        .from(issueDocuments)
        .where(eq(issueDocuments.issueId, issueId))
    : [];
  const documentIds = documentRows.map((row) => row.documentId);
  const revisionRows = documentIds.length > 0
    ? await db
        .select({
          id: documentRevisions.id,
          documentId: documentRevisions.documentId,
          revisionNumber: documentRevisions.revisionNumber,
          createdAt: documentRevisions.createdAt,
          createdByAgentId: documentRevisions.createdByAgentId,
          createdByRunId: documentRevisions.createdByRunId,
        })
        .from(documentRevisions)
        .where(inArray(documentRevisions.documentId, documentIds))
        .orderBy(desc(documentRevisions.createdAt))
    : [];
  const activityRows = issueId
    ? await db
        .select({
          id: activityLog.id,
          action: activityLog.action,
          actorType: activityLog.actorType,
          actorId: activityLog.actorId,
          agentId: activityLog.agentId,
          runId: activityLog.runId,
          details: activityLog.details,
          createdAt: activityLog.createdAt,
        })
        .from(activityLog)
        .where(and(eq(activityLog.entityType, "issue"), eq(activityLog.entityId, issueId)))
        .orderBy(desc(activityLog.createdAt))
        .limit(12)
    : [];
  const commentRows = issueId
    ? await db
        .select({
          id: issueComments.id,
          createdAt: issueComments.createdAt,
          createdByRunId: issueComments.createdByRunId,
        })
        .from(issueComments)
        .where(eq(issueComments.issueId, issueId))
        .orderBy(desc(issueComments.createdAt))
        .limit(6)
    : [];
  const linkedApprovals = issueId
    ? await db
        .select({
          approvalId: approvals.id,
          status: approvals.status,
          type: approvals.type,
          decidedAt: approvals.decidedAt,
        })
        .from(issueApprovals)
        .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
        .where(eq(issueApprovals.issueId, issueId))
    : [];

  const trace: EvalTraceEvent[] = [
    {
      evalRunId: runId,
      scenarioId: scenario.id,
      bundleId: bundle.id,
      traceId: "trace-start",
      timestamp: startedAt,
      eventType: "observed_scenario_started",
      eventClass: "scenario",
      status: "started",
      message: `Observed heartbeat run '${input.run.id}' entered eval capture.`,
      parentTraceId: null,
      correlationId: input.run.id,
      agentId: input.run.agentId,
      projectId: issue?.projectId ?? null,
      issueId,
      roomId: null,
      approvalId: null,
      artifactRef: relativeManifestPath,
      metadata: { sourceKind: "observed" },
    },
    {
      evalRunId: runId,
      scenarioId: scenario.id,
      bundleId: bundle.id,
      traceId: "trace-runtime",
      timestamp: startedAt,
      eventType: "heartbeat_run_observed",
      eventClass: "system",
      status: input.run.status,
      message: input.run.error ?? `Heartbeat run status: ${input.run.status}`,
      parentTraceId: "trace-start",
      correlationId: input.run.id,
      agentId: input.run.agentId,
      projectId: issue?.projectId ?? null,
      issueId,
      roomId: null,
      approvalId: null,
      artifactRef: relativeObservedEvidencePath,
      metadata: {
        heartbeatRunId: input.run.id,
        retries: input.run.processLossRetryCount,
      },
    },
  ];

  for (const row of revisionRows.slice(0, 10)) {
    trace.push({
      evalRunId: runId,
      scenarioId: scenario.id,
      bundleId: bundle.id,
      traceId: `trace-doc-${row.id}`,
      timestamp: row.createdAt.toISOString(),
      eventType: "continuity_document_revision",
      eventClass: "artifact",
      status: "ok",
      message: `Continuity document revision ${row.revisionNumber} observed.`,
      parentTraceId: "trace-start",
      correlationId: input.run.id,
      agentId: row.createdByAgentId ?? null,
      projectId: issue?.projectId ?? null,
      issueId,
      roomId: null,
      approvalId: null,
      artifactRef: relativeObservedEvidencePath,
      metadata: {
        documentId: row.documentId,
        revisionId: row.id,
      },
    });
  }

  for (const row of activityRows.slice(0, 10)) {
    trace.push({
      evalRunId: runId,
      scenarioId: scenario.id,
      bundleId: bundle.id,
      traceId: `trace-activity-${row.id}`,
      timestamp: row.createdAt.toISOString(),
      eventType: row.action,
      eventClass:
        row.action.includes("approval") ? "approval"
          : row.action.includes("comment") ? "comment"
            : row.action.includes("review") || row.action.includes("handoff") ? "decision"
              : "routing",
      status: "ok",
      message: row.action,
      parentTraceId: "trace-start",
      correlationId: input.run.id,
      agentId: row.agentId ?? null,
      projectId: issue?.projectId ?? null,
      issueId,
      roomId: null,
      approvalId: null,
      artifactRef: relativeObservedEvidencePath,
      metadata: row.details ?? null,
    });
  }

  for (const row of linkedApprovals.slice(0, 6)) {
    trace.push({
      evalRunId: runId,
      scenarioId: scenario.id,
      bundleId: bundle.id,
      traceId: `trace-approval-${row.approvalId}`,
      timestamp: (row.decidedAt ?? input.run.createdAt).toISOString(),
      eventType: "issue_approval_observed",
      eventClass: "approval",
      status: row.status,
      message: `Approval ${row.type} is ${row.status}.`,
      parentTraceId: "trace-start",
      correlationId: input.run.id,
      agentId: null,
      projectId: issue?.projectId ?? null,
      issueId,
      roomId: null,
      approvalId: row.approvalId,
      artifactRef: relativeObservedEvidencePath,
      metadata: { approvalType: row.type },
    });
  }

  const failures: EvalFailure[] = [];
  if ((continuity?.continuityState.missingDocumentKeys.length ?? 0) > 0) {
    failures.push({
      kind: "artifact_missing",
      message: `Continuity is missing required docs: ${continuity?.continuityState.missingDocumentKeys.join(", ")}`,
      traceId: "trace-runtime",
      artifactRef: relativeObservedEvidencePath,
      entityId: issueId,
    });
  }
  if (continuity?.continuityState.health === "invalid_handoff") {
    failures.push({
      kind: "resume_failure",
      message: "Continuity is blocked by an invalid handoff state.",
      traceId: "trace-runtime",
      artifactRef: relativeObservedEvidencePath,
      entityId: issueId,
    });
  }
  if ((continuity?.continuityState.returnedBranchIssueIds?.length ?? 0) > 0) {
    failures.push({
      kind: "duplicate_work",
      message: `Returned branches still need owner merge confirmation: ${continuity?.continuityState.returnedBranchIssueIds?.length ?? 0}`,
      traceId: "trace-runtime",
      artifactRef: relativeObservedEvidencePath,
      entityId: issueId,
    });
  }

  const acceptedOutcome = failures.length === 0;
  const scorecard: EvalScorecard = {
    scorecardVersion: EVAL_SCORECARD_VERSION,
    runId,
    scenarioId: scenario.id,
    bundleId: bundle.id,
    dimension: scenario.dimension,
    status:
      input.run.status === "completed" || input.run.status === "succeeded"
        ? (acceptedOutcome ? "passed" : "failed")
        : input.run.status === "failed"
          ? "failed"
          : input.run.status === "timed_out"
            ? "timed_out"
            : "invalid",
    acceptedOutcome,
    humanTouchMinutes: 0,
    managerTouches: activityRows.length,
    coordinationTax: {
      tokenCost: 0,
      approvalWaitMinutes: linkedApprovals.length,
      conferenceRoomTurns: 0,
      managerTouches: activityRows.length,
      acceptedOutcomeCount: acceptedOutcome ? 1 : 0,
    },
    hardChecks: {
      passed: failures.length === 0 ? 2 : Math.max(0, 2 - failures.length),
      failed: failures.length,
      failures,
    },
    metrics: {
      durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
      retries: input.run.processLossRetryCount,
      tokenCost: 0,
      queueDepth: 1,
      issueAgeP95Minutes: null,
      ownershipChurn: activityRows.filter((row) => row.action.includes("assignee")).length,
      staleProgressIncidence: continuity?.continuityState.health === "stale_progress" ? 1 : 0,
      invalidHandoffRecovery: continuity?.continuityState.health === "invalid_handoff" ? 0 : 1,
      reviewerReturnLatencyMinutes: continuity?.continuityState.lastReviewReturnAt ? 0 : null,
      branchMergeLoss: continuity?.continuityState.returnedBranchIssueIds?.length ?? 0,
    },
    rubrics: {
      roleQuality: null,
      handoffQuality: continuity?.continuityState.health === "invalid_handoff" ? 0 : null,
      decisionQuality: linkedApprovals.length > 0 ? 1 : null,
      notes: ["Observed run captured from runtime evidence."],
    },
    acceptance: {
      passed: acceptedOutcome,
      rationale: acceptedOutcome
        ? ["Trace completeness passed", "No continuity hard-check failures"]
        : failures.map((failure) => failure.message),
    },
    failureKinds: failures.map((failure) => failure.kind),
    scopeViolationCount: 0,
  };

  trace.push({
    evalRunId: runId,
    scenarioId: scenario.id,
    bundleId: bundle.id,
    traceId: "trace-complete",
    timestamp: completedAt,
    eventType: "observed_scenario_completed",
    eventClass: "scenario",
    status: scorecard.status,
    message: `Observed continuity capture finished with ${scorecard.status}.`,
    parentTraceId: "trace-start",
    correlationId: input.run.id,
    agentId: input.run.agentId,
    projectId: issue?.projectId ?? null,
    issueId,
    roomId: null,
    approvalId: null,
    artifactRef: relativeScorecardPath,
    metadata: { sourceKind: "observed" },
  });

  const scenarioPackageHash = createHash("sha256")
    .update(JSON.stringify({
      issueId,
      continuityBundleHash: continuity?.continuityBundle.bundleHash ?? null,
      heartbeatRunId: input.run.id,
    }))
    .digest("hex");
  const bundleHash = createHash("sha256").update(JSON.stringify(bundle)).digest("hex");

  const artifact: EvalRunArtifact = {
    artifactSchemaVersion: EVAL_ARTIFACT_SCHEMA_VERSION,
    evalContractVersion: EVAL_CONTRACT_VERSION,
    scorecardVersion: EVAL_SCORECARD_VERSION,
    runId,
    sourceKind: "observed",
    observedRun: observedReference,
    scenario,
    bundle,
    environment: {
      repoRoot: input.repoRoot,
      gitSha,
      evalContractVersion: EVAL_CONTRACT_VERSION,
      scorecardVersion: EVAL_SCORECARD_VERSION,
      artifactSchemaVersion: EVAL_ARTIFACT_SCHEMA_VERSION,
      scenarioPackageHash,
      bundleHash,
      modelId: "observed-runtime",
      modelVersion: "observed-runtime",
      promptBundleHash: continuity?.continuityBundle.bundleHash ?? null,
      skillVersions: { paperclip: "wave-3-observed" },
      toolVersions: { heartbeat: "runtime", documents: "runtime" },
      featureFlags: bundle.featureFlags,
      seed,
      timeoutPolicy: scenario.timeoutPolicy,
      chaosProfile: scenario.chaosProfile,
      instanceRoot: resolvePaperclipInstanceRoot(),
      nodeVersion: process.version,
      platform: `${process.platform}-${process.arch}`,
      startedAt,
    },
    replay: {
      sourceKind: "observed",
      scenarioId: scenario.id,
      bundleId: bundle.id,
      lane: bundle.lane,
      command: "pnpm evals:architecture:observed",
      artifactRoot,
      basePackagePath: null,
      overlayLabels: [],
      featureFlags: bundle.featureFlags,
      seed,
      fairnessConstraints: scenario.fairnessConstraints,
      externalDependencyPolicy: {
        hermetic: false,
        dependencies: ["runtime_database"],
        notes: "Observed continuity evals depend on a live Paperclip runtime database.",
      },
      observedRun: observedReference,
      env: {
        NODE_ENV: process.env.NODE_ENV ?? "development",
      },
    },
    graders: [
      {
        id: "hard-check.observed",
        kind: "hard_check",
        label: "Observed hard checks",
        version: "1",
        description: "Runtime continuity hard checks built from observed evidence.",
        metricKeys: ["staleProgressIncidence", "invalidHandoffRecovery", "branchMergeLoss"],
      },
      {
        id: "metrics.observed",
        kind: "metric_extractor",
        label: "Observed metric extractor",
        version: "1",
        description: "Extracts continuity-specific metrics from runtime evidence.",
        metricKeys: ["durationMs", "ownershipChurn", "reviewerReturnLatencyMinutes"],
      },
      {
        id: "acceptance.observed",
        kind: "acceptance_oracle",
        label: "Observed acceptance oracle",
        version: "1",
        description: "Observed runs are accepted when continuity evidence is complete and hard checks pass.",
        metricKeys: [],
      },
    ],
    acceptanceOracle: {
      id: "accepted.observed",
      label: "Observed accepted outcome",
      version: "1",
      description: "Observed accepted outcome = required evidence present + no continuity hard-check failures.",
      requiredArtifacts: scenario.requiredArtifacts,
    },
    failureTaxonomy: DEFAULT_EVAL_FAILURE_TAXONOMY,
    trace,
    capturedArtifacts: [
      { label: "manifest", kind: "manifest", relativePath: relativeManifestPath, redacted: true, sha256: null },
      { label: "trace", kind: "trace", relativePath: relativeTracePath, redacted: true, sha256: null },
      { label: "scorecard", kind: "scorecard", relativePath: relativeScorecardPath, redacted: true, sha256: null },
      { label: "replay", kind: "replay", relativePath: relativeReplayPath, redacted: true, sha256: null },
      { label: "observed-evidence", kind: "trace", relativePath: relativeObservedEvidencePath, redacted: true, sha256: null },
    ],
    scorecard,
    startedAt,
    completedAt,
    status: scorecard.status,
    redactionMode: "redacted",
    notes: ["Observed continuity eval artifacts are informational only in Wave 3."],
  };

  const manifest = {
    runId,
    scenarioId: scenario.id,
    bundleId: bundle.id,
    sourceKind: "observed",
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
  await writeJson(path.join(runDir, "artifacts", "observed-evidence.json"), {
    observedRun: observedReference,
    issue: issue
      ? {
          id: issue.id,
          identifier: issue.identifier,
          title: issue.title,
        }
      : null,
    continuityState: continuity?.continuityState ?? null,
    continuityBundleHash: continuity?.continuityBundle.bundleHash ?? null,
    documentKeys: documentRows.map((row) => row.key),
    recentRevisions: revisionRows.slice(0, 10),
    recentActivity: activityRows,
    recentComments: commentRows,
    linkedApprovals,
  });
  await writeJson(path.join(runDir, "artifact.json"), artifact);

  for (const capturedArtifact of artifact.capturedArtifacts) {
    const absolutePath = path.join(artifactRoot, capturedArtifact.relativePath);
    capturedArtifact.sha256 = await hashFile(absolutePath);
  }
  await writeJson(path.join(runDir, "artifact.json"), artifact);

  const completenessFailures = validateEvalTraceCompleteness(artifact);
  if (completenessFailures.length > 0) {
    throw new Error(`Observed eval artifact '${runId}' failed trace completeness: ${completenessFailures[0]?.message}`);
  }

  return evalRunArtifactSchema.parse(artifact);
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
  const fixture = portableFixtureOrThrow(input.scenario);

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
          hermetic: fixture.hermetic,
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
    sourceKind: "seeded",
    observedRun: null,
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
      sourceKind: "seeded",
      scenarioId: input.scenario.id,
      bundleId: input.bundle.id,
      lane: input.bundle.lane,
      command: `pnpm evals:architecture${input.bundle.lane === "canary" ? ":canary" : input.bundle.lane === "nightly" ? ":nightly" : input.bundle.lane === "soak" ? ":soak" : ":baseline"}`,
      artifactRoot,
      basePackagePath: path.resolve(input.repoRoot, fixture.basePackagePath),
      overlayLabels: fixture.overlays.map((overlay) => overlay.label),
      featureFlags: input.bundle.featureFlags,
      seed,
      fairnessConstraints: input.scenario.fairnessConstraints,
      externalDependencyPolicy: {
        hermetic: fixture.hermetic,
        dependencies: fixture.externalDependencies,
        notes: fixture.externalDependencies.length > 0
          ? "Live dependencies declared by scenario metadata."
          : null,
      },
      observedRun: null,
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

export async function runObservedLane(input: {
  repoRoot: string;
  artifactRoot?: string;
  lookbackHours?: number;
  maxRuns?: number;
  seed?: number;
}) {
  const artifactRoot = input.artifactRoot ?? defaultArtifactRoot();
  await ensureDir(artifactRoot);
  const observedRuns = await listObservedIssueRuns({
    lookbackHours: input.lookbackHours ?? 24,
    maxRuns: input.maxRuns ?? 12,
  });
  const artifacts: EvalRunArtifact[] = [];
  for (const run of observedRuns) {
    artifacts.push(await executeObservedRun({
      repoRoot: input.repoRoot,
      artifactRoot,
      lookbackHours: input.lookbackHours ?? 24,
      maxRuns: input.maxRuns ?? 12,
      run,
      seed: input.seed,
    }));
  }
  const summary = await rebuildSummaryFromArtifactRoot(artifactRoot);
  return { artifacts, summary };
}

export function getDefaultArtifactRoot() {
  return defaultArtifactRoot();
}
