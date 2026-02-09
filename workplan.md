---
schema_version: 1
type: workplan
id: workplan_v0
created_at: 2026-02-09
title: "AgentCompany v0 (Local macOS Agent Org PM Tool)"
status: draft
---

# AgentCompany v0 Workplan

## Goal
Ship a local-first "agent org" PM system that feels like a real company. Planning and execution are governed the same way: tasks and milestones produce validated artifacts, runs are replayable from append-only events, and curated memory changes require manager approval with evidence.

## v0 Demo Bar (Success Criteria)
- CEO can create a Company with at least 2 departments, each with 1 manager agent and 1 worker agent.
- CEO can run a full "Project Intake -> Workplan" cycle via Director -> Managers -> Director and receive a single synthesized `workplan.md` artifact.
- Managers can assign 2 execution tasks; workers run via provider CLIs; each task reaches at least 1 milestone "done" with required artifacts.
- All runs produce replayable event logs; all milestone completion is artifact-backed (report plus evidence).
- Memory is split into agent journal vs curated team/project memory; manager approval required for curated updates.
- Multi-provider works for at least 2 CLIs across at least 2 repos (Codex plus Claude Code, or a second equivalent CLI).

## Product Wedge (What Must Feel "Serious")
- Org semantics with enforced visibility boundaries (not conventions).
- Governed memory: delta + approval + evidence.
- Reproducible context packs for every run.
- Artifact-backed milestone contracts and append-only audit trails.

## Locked Defaults (v0)
- Local-first storage: canonical filesystem store plus rebuildable SQLite index.
- Single human user; future collaboration via exporting/syncing the workspace folder (git recommended).
- Human-in-the-loop approvals are first-class, not "optional UI".
- Mixed milestone strictness:
  - Coding milestones: require evidence (patch/commit + tests) and a `milestone_report.md`.
  - Research/planning milestones: require structured artifacts, no code evidence.
- Default work isolation for coding tasks: per-task worktree/branch (ON by default, opt-out per task).

## Canonical Workspace Format (Decision-Complete)
Canonical truth lives in a portable "Company Workspace" folder. No absolute machine paths are stored in canonical files; machine-local paths live in a `.local/` overlay.

### Workspace Layout v1 (canonical)
- `company/company.yaml`
- `company/policy.yaml`
- `org/teams/<team_id>/team.yaml`
- `org/teams/<team_id>/memory.md` (curated)
- `org/agents/<agent_id>/agent.yaml`
- `org/agents/<agent_id>/journal.md` (append-only)
- `work/projects/<project_id>/project.yaml`
- `work/projects/<project_id>/memory.md` (curated)
- `work/projects/<project_id>/tasks/<task_id>.md` (contract + milestones)
- `work/projects/<project_id>/artifacts/<artifact_id>.(md|yaml|json|patch|txt)`
- `work/projects/<project_id>/context_packs/<context_pack_id>/manifest.yaml`
- `work/projects/<project_id>/context_packs/<context_pack_id>/policy_snapshot.yaml`
- `work/projects/<project_id>/runs/<run_id>/run.yaml`
- `work/projects/<project_id>/runs/<run_id>/events.jsonl`
- `work/projects/<project_id>/runs/<run_id>/outputs/`
- `work/projects/<project_id>/share_packs/<share_pack_id>/manifest.yaml`
- `inbox/reviews/<review_id>.yaml` (append-only decisions)
- `inbox/help_requests/<help_request_id>.md`

### Machine-local overlay (non-portable)
- `.local/machine.yaml` (repo_id -> absolute repo path; provider CLI paths; secrets pointers)

### IDs and naming
- ID type: ULIDs preferred (time-sortable). Prefixes: `cmp_`, `team_`, `agent_`, `proj_`, `task_`, `ms_`, `run_`, `art_`, `ctx_`, `share_`, `rev_`, `help_`.
- Filenames use ids; titles live in file metadata.

## Governance First-Class (Policy + Provenance)

### Visibility levels (v1)
- `private_agent`
- `team`
- `managers`
- `org`

Default visibility:
- Worker journals: `private_agent`
- Worker milestone artifacts: `team`
- Manager proposals: `managers`
- Director workplan: `org`

### Policy engine (minimal, enforceable)
Implement a tiny rule engine that answers:
- Can actor X read artifact Y?
- Can actor X approve delta Z?
- Can Team A see Team B worker logs?

Rules:
- Policy decisions are recorded in audit artifacts (review records) and as events.
- Every denied action emits a `policy.denied` event with a reason code.

### Provenance fields everywhere
Every artifact links back to:
- `run_id`
- `context_pack_id`
- producing `agent_id` and role
- repo snapshot pointer: `repo_id`, `head_sha`, and either `dirty=false` or a patch artifact id

## Run/Event Backbone (Replayable, Drift-Resilient)

### Event log format (JSONL strict envelope)
Every line includes:
- `schema_version`
- `ts_wallclock` and `ts_monotonic` (best effort)
- `run_id`
- `session_ref`
- `actor` (human | system | agent_id)
- `visibility`
- `type`
- `payload`

Constraints:
- Preserve raw provider output separately from interpreted events:
  - `provider.raw` stores stdout/stderr/protocol chunks.
  - `assistant.message` and other interpreted events are generated in parallel.
- Unknown event types are preserved, indexed, and shown as raw JSON in the UI (driver drift resilience).

### Run folder conventions
Each run stores:
- `run.yaml` (spec + provenance pointers)
- `events.jsonl` (append-only)
- `outputs/` (artifacts, captured logs, patches, test outputs)

### Replay UX (v0 demo feature)
Select a run -> timeline replay -> see artifacts appear and approvals occur.

## Provider Drivers (Multi-CLI, Negotiated Capabilities)

### Driver contract (stable)
- `capabilities() -> manifest`
- `launch(run_spec) -> session_ref`
- `poll(session_ref) -> status`
- `collect(session_ref, cursor) -> events + produced artifacts + next_cursor`
- `stop(session_ref)`

### Capabilities negotiation (required)
Capabilities fields (minimum):
- `supports_streaming_events`
- `supports_resumable_session`
- `supports_structured_output` (formats)
- `supports_token_usage`
- `supports_patch_export`
- `supports_interactive_approval_callbacks`
- `supports_worktree_isolation` (required/recommended/unsupported)

Orchestrator rules:
- If a driver cannot resume sessions, approvals gate by splitting work into follow-up runs (never rely on in-process interactivity).
- Drivers must produce either required structured artifacts or a `failure_report.md` explaining why.

## Context Pack (Reproducibility Primitive)
Treat Context Pack as a first-class artifact created for every run:
- `manifest.yaml` includes:
  - repo snapshot pointer (repo_id, root mapping, head_sha)
  - included docs list (paths + hashes + visibility)
  - task contract summary (scope, deliverables, acceptance criteria)
  - resolved tool allowlist
- `policy_snapshot.yaml` records resolved visibility and policy decisions for the run.

## Share Pack (Safe Cross-Team Sharing)
Cross-team digests/help must read only from a Share Pack by default:
- includes only manager/org-visible artifacts and approved memory deltas
- excludes worker journals and raw logs unless explicitly attached as an exception
- exceptions are logged as policy decision events and stored as review records

## Memory System (Delta + Approval + Evidence)
Curated memory cannot be edited directly by agents.
- Workers/managers propose `memory_delta.md` with:
  - target scope and target file
  - evidence artifact ids
  - summary
- Include a machine-applyable patch:
  - unified diff (`.patch`) preferred
- Manager approval results in:
  - append-only `review.yaml`
  - patch applied to curated memory
  - `approval.decided` and `artifact.approved` events

## Milestone Plan

### M0 (1-2 weeks): Contract + Formats + Governance Spec
Deliverables:
- PRD-lite and end-to-end flow specs (planning and execution expressed as tasks/milestones).
- Workspace format v1 with schema_versioning and canonical templates.
- Policy engine spec (read/write/approve) and audit requirements.
- Event envelope spec and event type registry v1.
- Memory delta spec (`memory_delta.md` + patch).
- Context Pack and Share Pack specs.

Acceptance:
- A new workspace can be created and validated.
- All canonical artifacts validate required front matter and sections.

### M1 (2-3 weeks): Storage + Index + Minimal UI (Setup, Inbox, Runs)
Deliverables:
- Canonical store reader/writer for entities and artifacts.
- SQLite indexer rebuildable from filesystem truth.
- UI skeleton focused on:
  - company setup
  - teams/agents
  - projects/tasks (simple list + detail)
  - review inbox
  - run monitor

Acceptance:
- Deleting SQLite and reindexing reconstructs the UI state losslessly.

### M2 (1-2 weeks): Run Recorder + Replay Timeline
Deliverables:
- Run recorder emits strict-envelope events to JSONL.
- Replay UI timeline (first-class demo feature).
- Unknown event types render safely.

Acceptance:
- Any run can be replayed and traced to produced artifacts.

### M3 (2-4 weeks): Drivers v0 + Capabilities + Validation
Deliverables:
- Codex driver v0.
- Claude Code (or equivalent) driver v0.
- Concurrent runs across repos supported.
- Structured output validation and failure artifacts.
- Worktree isolation for coding tasks.

Acceptance:
- Start two runs concurrently in different repos with different providers; both appear in Run Monitor and produce artifacts.

### M4 (2-3 weeks): Planning Pipeline (as Tasks/Milestones)
Deliverables:
- Project Intake wizard creates `intake_brief.md`.
- Director clarifications loop stored as `clarifications_qa.md`.
- Manager proposal tasks produce validated `proposal.md`.
- Director synthesis produces `workplan.md` (this artifact type inside the workspace) with:
  - breakdown, dependencies
  - optional Mermaid Gantt
  - resource estimates (time + optional token/cost) with confidence and method

Acceptance:
- End-to-end intake -> proposals -> synthesized workplan across at least 2 managers.

### M5 (2-4 weeks): Execution Governance (Milestones, Reviews, Memory)
Deliverables:
- Task contracts and milestone rules enforced.
- Review inbox supports approve/deny, request changes, approve memory deltas.
- Coding milestone evidence: patch/commit + tests output artifact + report.
- Append-only review records; never mutate history.

Acceptance:
- Worker completes a coding milestone, manager approves, curated memory updates via approved delta.

### M6 (1-2 weeks): Cross-Team Help Requests + Digests via Share Packs
Deliverables:
- Help request object.
- Share pack generation and manager digests with redaction by default.
- Explicit attachment exceptions are auditable.

Acceptance:
- Help request resolved without exposing worker journals/logs by default.

### M7 (1-2 weeks): Packaging + Portability
Deliverables:
- Workspace export suitable for git/cloud sync.
- Reindex on a new Mac with different repo paths using `.local/` mapping.
- Test harness for:
  - policy enforcement
  - portability
  - driver drift resilience

Acceptance:
- Workspace moves to a new machine and reindexes successfully.

## End-to-End Acceptance Scenarios (Hard-Parts Focus)
- Policy enforcement: Team A worker attempts to access Team B worker log artifact -> denied + `policy.denied` logged + UI suggests help request.
- Portability: workspace moved to new Mac with different repo paths -> reindex succeeds; canonical files remain portable.
- Driver drift: driver emits unknown event types -> UI shows raw event; indexing and replay still work.

