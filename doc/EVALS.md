# Architecture Evals

Paperclip architecture evals test the organization design itself, not only prompt quality.

## Scope

Wave 1 is internal-only and artifact-backed.

- raw eval artifacts are the source of truth
- summary indexes are rebuildable query surfaces
- instance-admin APIs and UI surfaces are read-only
- no eval-specific database tables are introduced
- no eval-driven workflow mutations are introduced

`evals/promptfoo` remains the component lane for narrow prompt and skill behavior.
That lane runs through Paperclip itself:

- promptfoo is the case and assertion harness
- `POST /api/instance/evals/component-run` is the execution surface
- Paperclip runs the real local adapters (`codex_local`, `claude_local`) behind that endpoint
- `claude_local` preserves the host Claude auth environment during component evals because temp `HOME` or `CLAUDE_CONFIG_DIR` values deauthenticate Claude Max on macOS
- component eval runs are transient and do not enter the architecture artifact index

`evals/architecture` is the architecture lane for reliability, runtime stability, and utility.

## Versions

Wave 1 locks these versions up front:

- `evalContractVersion`
- `scorecardVersion`
- `artifactSchemaVersion`

Versioned artifacts are required for replay, migrations, and scorecard evolution.

## Eval Contract

The shared Wave 1 contract includes:

- `EvalScenario`
- `EvalBundle`
- `EvalEnvironmentManifest`
- `EvalReplaySpec`
- `EvalTraceEvent`
- `EvalGrader`
- `EvalAcceptanceOracle`
- `EvalFailureTaxonomy`
- `EvalRunArtifact`
- `EvalScorecard`
- `EvalSummaryIndex`

Run states are fixed in Wave 1:

- `passed`
- `failed`
- `flaky`
- `timed_out`
- `blocked`
- `invalid`

## What gets measured

### Reliability

Reliability asks whether the architecture reaches acceptable outcomes repeatedly under the same scenario constraints.

Wave 1 reliability coverage starts with:

- deterministic invariants
- role evals
- handoff evals
- failure-promoted skill hardening from open typed review findings
- a small seeded end-to-end canary set
- shared-state execution baselines against relay-style execution

### Runtime stability

Runtime stability asks whether the architecture survives long runs, restarts, delays, and concurrency without corrupting coordination.

Wave 1 stages stability work:

1. restart and resume
2. approval delay
3. tool-call failure
4. repo read-only
5. stale and conflicting comments
6. budget caps
7. controlled flakiness

### Utility

Utility asks whether the hierarchy earns its cost versus simpler alternatives.

Wave 1 utility remains informational. It does not gate PRs until the nightly harness is stable.

Wave 3 adds observed runtime continuity traces beside the seeded lane. These observed runs are sourced from real issue-backed heartbeat executions, remain internal-only, nightly-only, and informational, and reuse runtime evidence rather than introducing a parallel workflow engine.

Wave 4 repositions relay-style execution as a baseline lane, not the recommended default. Observed evals should also report adoption metrics for the new UX default:

- percent of executing issues prepared before start
- continuity-health warning incidence
- ownership churn
- legacy relay-role creation rate
- dashboard execution-health accuracy

## Reproducibility

Every run must capture a replay envelope:

- git SHA
- eval contract versions
- scenario package hash
- bundle hash
- resolved model identifier and version
- skill and tool versions
- feature flags
- seed
- timeout policy
- chaos profile
- environment manifest

Raw artifacts must be sufficient to reproduce the run locally without requiring hidden DB-only state.

Observed runs carry an explicit source marker:

- `seeded`
- `observed`

## Artifact Model

Wave 1 artifacts live under the Paperclip instance root:

- `data/evals/architecture/runs/<runId>/manifest.json`
- `data/evals/architecture/runs/<runId>/trace.ndjson`
- `data/evals/architecture/runs/<runId>/scorecard.json`
- `data/evals/architecture/runs/<runId>/replay.json`
- `data/evals/architecture/runs/<runId>/summary-entry.json`
- `data/evals/architecture/runs/<runId>/artifact.json`
- `data/evals/architecture/runs/<runId>/artifacts/*`
- `data/evals/architecture/summary/index.json`

`artifact.json` is the canonical per-run bundle for read APIs.
`summary/index.json` must always be rebuildable from the run artifacts.

Observed continuity artifacts may add runtime evidence snapshots such as heartbeat context, continuity bundle hashes, issue activity, document revisions, and linked approvals. These artifacts stay redacted by default just like seeded runs.

## Trace Completeness

Every trace event must carry:

- `evalRunId`
- `scenarioId`
- `bundleId`
- `traceId`

Authoritative events must also carry the relevant entity ids and correlation or parent ids where applicable.

A run is `invalid` when:

- required event classes are missing
- timestamps are incoherent
- artifact references are missing
- trace joins do not line up with the run manifest

## Graders

Trace capture and grading are separate layers.

Wave 1 defines four grader classes:

1. hard checks
2. metric extractors
3. rubric graders
4. acceptance oracles

Runs may be governance-correct but not useful, or useful but governance-incorrect.
Scorecards must preserve that separation.

### Failure taxonomy

Wave 1 includes at least:

- `scope_violation`
- `authority_bypass`
- `duplicate_work`
- `deadlock`
- `resume_failure`
- `stale_context`
- `artifact_missing`
- `grader_error`

## Utility definitions

Wave 1 fixes these definitions:

- accepted outcome = required artifacts present + no hard-check failures + acceptance oracle passes
- human-touch time = explicit operator review, edit, or approval time attached to the run
- manager touches = manager-originated routing, status, or approval actions, excluding passive reads
- coordination tax = token cost, approval wait minutes, conference-room turns, and manager touches per accepted outcome

## Hermetic scenario rules

Scenario execution is isolated:

- ephemeral company and workspace fixture
- isolated instance root
- isolated artifact directory
- explicit cleanup and retention rules

Portable company packages are the base fixture format.
Scenarios may layer overlays on top of a base fixture instead of duplicating a full package.

Any scenario with live external dependencies is non-hermetic and cannot enter PR canary lanes.

## Reliability-first rollout

### Phase 0

Publish the contract, scorecard vocabulary, replay envelope, failure taxonomy, flake policy, and security rules.

### Phase 1

Implement:

- shared schemas and validators
- the artifact-backed harness
- graders and summary rebuild
- read-only instance-admin APIs
- a thin internal eval dashboard surface

### Phase 2

Seed the first eight scenarios:

1. worker isolation across projects
2. director and tech-lead handoff quality
3. consultant engagement gating
4. VP portfolio conflict handling
5. conference-room decision resolving into the right approval
6. crash and restart with no duplicate work
7. multi-project overnight soak seed
8. hierarchy vs flat pod vs single-agent baseline seed

Shared-state execution evals should explicitly compare:

- one-owner continuity execution
- bounded branch-and-merge execution
- role-pipeline relay baseline

Key metrics for this comparison:

- drift
- resume success
- ownership churn
- branch merge loss
- reviewer effectiveness
- operator touches

PR gating stays light:

- invariants
- a very small canary seed set
- promptfoo component evals through the local Paperclip endpoint

Nightly lanes report:

- pass rate
- variance
- median and p95 duration
- scope-violation count
- seven-day rolling pass rate
- change-from-baseline alerts

## Security and retention

Wave 1 rules:

- instance-admin only
- raw artifacts are redacted by default in API and UI responses
- raw artifacts are excluded from normal company portability and export flows
- PR canary artifacts retain for 14 days
- nightly and weekly raw artifacts retain for 30 days
- summary indexes retain for 90 days
- local manual runs may retain longer, but unredacted raw artifacts are never published by default

## Eval flywheel

Every recurring failure should enter the eval loop:

1. failure observed in production or internal testing
2. reduce it to a trace and artifact bundle
3. convert that bundle into a scenario, grader, or hard check
4. add it to the nightly matrix
5. promote it to PR canary only after it stabilizes

### Failure-promoted skill hardening

Reusable skill failures follow the same flywheel with one extra durability rule:

1. start from an open typed `review-findings` entry, not a loose comment thread
2. promote the failure into one hardening issue keyed by the skill plus a stable failure fingerprint
3. scaffold `spec`, `plan`, and `test-plan` before drafting or approving shared-mirror changes
4. record exact promptfoo case ids and architecture scenario ids in the verification plan
5. treat mirrored-skill proposals as approval-ready only after that evidence exists

## Observed continuity lane

Observed continuity scorecards focus on runtime execution quality rather than seeded scenario completion. At minimum they should report:

- resume stability after continuity bundle changes
- ownership churn
- stale-progress incidence
- invalid-handoff recovery
- reviewer return latency and findings closure
- branch return and merge loss

Observed continuity captures stay read-only and non-gating in this wave. They are there to harden the harness and continuity model before any release decisions depend on them.
