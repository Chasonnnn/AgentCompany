# AgentCompany Architecture v0.2

This document clarifies the runtime architecture as implemented in v0.2.

## Write Path (single command pipeline)

1. Ingress (`CLI` / JSON-RPC `server router` / UI action)
2. Coordinator command pipeline
3. Launch lane scheduler (priority queue + workspace/provider/team concurrency limits)
4. Policy gate (allow/deny + `policy.decision` audit)
5. Budget preflight/advisory gate
6. Session router (`launch/poll/collect/stop/list`)
7. Provider driver (`codex_app_server`, `claude`, `cmd`)
8. Canonical writes to workspace store
9. Append-only event log (`events.jsonl`)

## Read Path (derived views)

1. Canonical filesystem + event log
2. SQLite index sync/rebuild worker
3. Read snapshots (`monitor.snapshot`, `inbox.snapshot`, `ui.snapshot`)
4. UI/CLI rendering

## Event Contract

Event envelope (persisted in `events.jsonl`) includes:

- `schema_version`
- `event_id`
- `correlation_id`
- `causation_id`
- `ts_wallclock`
- `ts_monotonic_ms`
- `run_id`
- `session_ref`
- `actor`
- `visibility`
- `type`
- `payload`
- `prev_event_hash`
- `event_hash`

Notes:

- `event_hash` forms a per-run hash chain.
- `prev_event_hash` links each event to the previous event in the same file.
- `correlation_id` defaults to `session_ref` when omitted.

## Session Lifecycle State Machine

Allowed status transitions:

- `running -> ended|failed|stopped`
- `ended -> ended`
- `failed -> failed`
- `stopped -> stopped`

Orphan reconciliation:

- Detached sessions with dead PIDs are reconciled to terminal status.
- Stop marker presence reconciles to `stopped`; otherwise `failed`.

## Locking Model

Canonical workspace writes:

- In-process per-workspace queue for serialization.
- Cross-process workspace lock file at `.local/locks/workspace.write.lock`.
- Durable atomic write pattern: temp file -> fsync -> rename -> directory fsync.

Event appends:

- Per-events-file append queue.
- Durable append with fsync.
- Hash-chain computation occurs inside append serialization.

## Design Intent

- Filesystem remains source of truth.
- SQLite remains rebuildable cache/read model.
- Governance, budgets, and replay all flow through the same event backbone.
- Replay tiers are explicit:
  - `raw` (fast parse)
  - `verified` (hash-chain checks)
  - `deterministic` (verified + deterministic_ok signal)
  - `live` (verified persisted events plus live session metadata when available)
