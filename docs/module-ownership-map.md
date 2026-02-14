# Module Ownership Map (Governance-First v0)

Use this map to land changes in the right files first.

## RPC + CLI + Protocol

- Area: method contracts, params, transport behavior
- Owner files: `src/server/router.ts`, `src/server/main.ts`, `src/cli.ts`
- Paired docs/contracts: `docs/protocol/v1.md`, `README.md`
- Required tests: `test/server-router.test.ts`, `test/server-main.test.ts`

## Policy + Visibility

- Area: read/approve authorization rules and enforcement
- Owner files: `src/policy/policy.ts`, `src/policy/enforce.ts`
- Paired docs/contracts: `AGENTS.md`, `docs/protocol/v1.md`
- Required tests: `test/policy.test.ts`, `test/artifact-read-policy.test.ts`

## Memory Governance Workflow

- Area: memory proposal/approval/listing and schema normalization
- Owner files:
  - `src/memory/propose_memory_delta.ts`
  - `src/memory/approve_memory_delta.ts`
  - `src/memory/list_memory_deltas.ts`
  - `src/memory/memory_delta.ts`
- Paired docs/contracts: `docs/protocol/v1.md`, `AGENTS.md`
- Required tests:
  - `test/memory-delta.test.ts`
  - `test/memory-list-policy.test.ts`
  - `test/memory-delta-normalization.test.ts`
  - `test/server-router.test.ts`

## Redaction + Secret Handling

- Area: secret detection/redaction invariants and fail-closed checks
- Owner files: `src/core/redaction.ts`, `src/share/redaction.ts`
- Paired docs/contracts: `AGENTS.md`
- Required tests: `test/core-redaction.test.ts`, `test/memory-redaction.test.ts`, `test/inbox-resolve.test.ts`

## Context Planning + Retrieval

- Area: layered context planning, policy-filtered composition, context trace persistence
- Owner files:
  - `src/runtime/context_plan.ts`
  - `src/runtime/job_runner.ts`
  - `src/runtime/worker_adapter.ts`
  - `src/schemas/context_plan.ts`
- Paired docs/contracts: `docs/protocol/v1.md`, `README.md`, `AGENTS.md`
- Required tests:
  - `test/context-plan.test.ts`
  - `test/context-plan-policy.test.ts`
  - `test/job-runner.test.ts`
  - `test/job-runner-heartbeat.test.ts`

## Session Candidate Extraction

- Area: review-only memory candidate extraction from run/job outcomes
- Owner files:
  - `src/memory/extract_session_commit_candidates.ts`
  - `src/schemas/memory_candidate_report.ts`
  - `src/server/router.ts`
  - `src/cli.ts`
- Paired docs/contracts: `docs/protocol/v1.md`, `README.md`
- Required tests:
  - `test/memory-candidate-extraction.test.ts`
  - `test/server-router.test.ts`

## Inbox Review Resolution

- Area: approve/deny flows and review artifacts/events
- Owner files: `src/inbox/resolve.ts`, `src/runtime/review_inbox.ts`
- Paired docs/contracts: `docs/protocol/v1.md`
- Required tests: `test/inbox-resolve.test.ts`, `test/review-inbox.test.ts`, `test/ui-resolve.test.ts`

## Index + Read Models

- Area: artifact/review projections and monitor/read-model behavior
- Owner files: `src/index/sqlite.ts`, `src/runtime/run_monitor.ts`, `src/runtime/review_inbox.ts`
- Paired docs/contracts: `docs/protocol/v1.md`
- Required tests: `test/index-sqlite.test.ts`, `test/index-sqlite-artifacts.test.ts`, `test/ui-manager-dashboard.test.ts`
