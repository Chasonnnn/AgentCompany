# AGENTS.md - AgentCompany (Local macOS "Agent Org" PM Tool)

> Single source of truth for building this project. Every contributor (human or AI) follows these rules.

## 0) Documentation First (Non-Negotiable)

Before implementing or changing behavior that depends on external systems/frameworks (provider CLIs, Electron/Tauri, SQLite, filesystem semantics, PTY behavior, git worktree/branch workflows, JSONL parsing, etc.), read the official documentation or upstream release notes first.
- Prefer official domains/repos as sources of truth.
- If docs are missing/unclear, inspect upstream source or create a minimal reproduction; do not guess.
- For provider integrations, capture and version example outputs in tests/fixtures so parsing remains stable.

## 1) Production-Quality Standard (Non-Negotiable)

Build fully functional, polished features, not "toy scripts".

Required:
- Friendly error handling (actionable messages; no raw stack traces as UX)
- Validation and edge cases covered (schemas, ids, visibility rules, missing artifacts, empty inputs)
- Reproducible runs (append-only events + artifacts with provenance)
- UI loading/empty/error states (Run Monitor, Review Inbox, Setup flows)
- Drift resilience (unknown event types never break indexing or replay)

Forbidden:
- "Minimal" implementations that skip validation or governance
- Silent failure modes (e.g., missing evidence accepted as "done")
- "TODO: add X later" comments in production code
- Placeholder UX copy instead of real behavior
- Downgrading dependencies without explicit user approval

## 1.1) No Backward Compatibility (Early Project)

This project is under active development. Breaking changes are acceptable.
- Prioritize clean design over compatibility (schema formats, UI flows, driver internals can change).
- When breaking canonical formats, bump `schema_version` and add a migration note/test.

## 2) Git Rules

### Commit Prefix Rule
All commits must start with: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, or `chore:`.

### Commit Message Format
```text
feat: Add policy engine allow/deny audit trail
fix: Prevent cross-team artifact leakage via share pack
docs: Document context pack schema v1
refactor: Centralize run event envelope writing
test: Add replay timeline drift resilience coverage
chore: Add CI for lint and tests
```

## 3) TDD Rule

Write or update tests first.
- Start with a failing test capturing the behavior/bug.
- Implement until it passes.
- If behavior changes, update tests in the same PR.
- For provider drivers, prefer recorded fixtures and contract tests over brittle string matching.

## 4) Security / Privacy Boundaries (Zero Tolerance)

- Never commit secrets (tokens, keys). Use `.env` locally if needed and keep `.env.example` updated.
- Never log or persist sensitive repo contents outside the workspace artifacts that are explicitly governed by visibility.
- Never leak cross-team private artifacts (worker journals, raw logs) by accident:
  - enforce policy checks at read time and at index time
  - record `policy.denied` events on blocks
  - require explicit, auditable exceptions to attach private artifacts to help requests
- Treat any imported customer/company workspace as potentially sensitive:
  - do not print raw content to console logs
  - prefer counts, ids, hashes, and summaries in logs/reports

## 5) Centralized Core Logic (Zero Tolerance)

All business logic must live in reusable core modules (UI-agnostic).
- UI should be a thin layer over core modules.
- Provider drivers must implement a stable driver contract and emit strict-envelope events.
- Canonical store, schema validation, policy evaluation, and replay must not be duplicated across UI and CLI.

Recommended top-level module split (adjust if the chosen stack requires it):
- `src/core/` (domain model: projects/tasks/milestones/artifacts)
- `src/store/` (canonical filesystem store + migrations)
- `src/index/` (SQLite indexer/rebuilder)
- `src/policy/` (policy engine + visibility model)
- `src/runtime/` (runs, event recorder, replay)
- `src/drivers/` (provider integrations + capabilities)
- `src/ui/` (desktop UI)

## 6) Roles and Work Item Contract

### Director
Responsibilities:
- Decompose requests into concrete Work Items.
- Assign owner modules/files and required tests.
- Review evidence artifacts and accept/reject outcomes.
- Approve governed memory deltas.
- Ensure public interface changes update docs/contracts.

Constraints:
- Must not bypass policy enforcement or visibility rules for convenience.
- Must reject Work Items that lack required evidence or tests.

### Worker
Responsibilities:
- Execute one Work Item at a time in the assigned owner area.
- Run required tests and attach evidence artifacts.
- Keep changes scoped to the Work Item acceptance criteria.
- May propose memory deltas but may not approve them.

Constraints:
- Must not directly bypass governance workflows (reviews, policy, memory approval).
- Must not ship changes without matching tests/evidence.

### Required Work Item Format
Every implementation Work Item must include:
- `Area`
- `Owner files to edit first`
- `Paired docs/contracts`
- `Tests to run`
- `Acceptance criteria`
- `Evidence required`
- `Routing reference` (link to `/Users/chason/AgentCompany/docs/module-ownership-map.md`)

## 7) Fast Routing Rules

- If you change routing/contract behavior:
  - Update `src/server/router.ts` + `src/cli.ts` + `docs/protocol/v1.md`.
  - Add/update server/router tests.
- If you change runtime execution behavior:
  - Start in `src/runtime/`.
  - Verify read-model/index impact in `src/index/sqlite.ts`.
- If you change policy/visibility/security behavior:
  - Start in `src/policy/`.
  - Verify both read-time and index-time guard paths.
- If you change memory governance:
  - Use memory delta propose/approve paths only.
  - Ensure review and policy audit artifacts remain complete.

## 8) Definition of Done (Required)

- Required tests for the changed area pass.
- Evidence artifacts are attached and auditable.
- Public-surface docs/contracts are updated when interfaces change.
- No policy bypass introduced:
  - read paths enforce policy
  - index/read-model paths do not leak restricted data

## 9) Memory Governance v0

- Memory changes are written only via memory delta workflow:
  - `memory.propose_delta` / `memory:delta`
  - `memory.approve_delta` / `memory:approve`
- Approval authority for memory deltas is Director+/CEO/Human only.
- Workers may propose memory deltas but may not approve them.
- Sensitivity classification is required (`public|internal|restricted`) and separate from visibility ACL.
- Secret-like content is fail-closed (proposal/approval blocked until sanitized).
- `AGENTS.md` is curated memory; generated context index data is stored separately.

## 10) Module Ownership Map

- Use `/Users/chason/AgentCompany/docs/module-ownership-map.md` to route changes quickly to owner files, paired docs, and required tests.
