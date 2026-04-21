# Paperclip Operating System

Status: Normative collaboration contract for Paperclip V1 phase-1 rollout
Date: 2026-04-17
Audience: Product, engineering, agent-template authors, company-package authors

## 1. Source Of Truth

Paperclip uses a strict collaboration hierarchy:

1. `doc/OPERATING_SYSTEM.md`
   Defines collaboration behavior, authority boundaries, room taxonomy, packet rules, cadence, escalation, and artifact ownership.
2. `doc/SPEC-implementation.md`
   Defines product and system behavior, data model invariants, APIs, and runtime behavior.
3. Agent instructions bundles (`AGENTS.md`, onboarding assets, template bundles)
   Apply the operating model locally. They do not redefine global policy.
4. Portable company packages
   May carry a root `OPERATING_SYSTEM.md`, but it must follow the same schema and must not introduce alternate collaboration rules.

If two documents disagree about collaboration behavior, this file wins.

## 2. Collaboration Planes

Paperclip coordination is intentionally split into a small number of channels:

- `issues` and `issue comments`
  Default execution channel. Ownership, progress, blockers, and handoffs live here.
- `documents`
  Durable artifact channel. Plans, specs, risks, runbooks, and handoffs live here.
- `conference rooms`
  Invitation-based coordination channel. They gather cross-functional discussion, room questions, and can later produce a formal decision request.
- `issue decision questions`
  Lightweight agent-to-board question artifact for planning or execution blockers. These are distinct from approvals and only escalate into approvals when governed signoff is actually needed.
- `approvals`
  Governed decision artifact. A decision request is not a decision until it is represented as an approval outcome.
- `shared_service_engagements`
  The only sanctioned dotted-line consulting path in phase 1.

Paperclip does not introduce a second workflow engine for packets, rooms, or contracts in phase 1.

### 2.1 Governance Graph vs Execution Graph

Paperclip separates two layers that were previously mixed:

- governance graph
  Accountability, escalation, approvals, staffing, budgets, visibility
- execution graph
  How one concrete issue keeps context, reasons, branches, resumes, and finishes

Hard rule:

- the org chart decides who is accountable
- the issue thread decides how the work thinks
- reviewers and approvers are gates, not baton-pass owners
- subagents are for bounded branch work or adversarial review, not default relay chains
- the default org-facing UI is an accountability map, not an execution tree
- the recommended default company is lean: 1-2 executive sponsors, one company-wide office operator, 1-3 project leads, 4-6 continuity owners, and optional shared-service leads only when justified
- executive sponsors are governance-only by default; they are sponsor metadata for projects, not normal project execution members
- the office operator owns company-wide intake routing, follow-up, and staffing-gap detection; project leads own project-local decomposition and sequencing once work is routed into a project lane
- each active project should have one primary Project Lead for project-local delivery coordination

## 3. Authority Rules

These are hard rules:

1. Packets are descriptive, not authoritative.
2. Comments never mutate assignee, approval, or escalation state by themselves.
3. Conference rooms coordinate invited participants; they do not replace approvals.
4. Shared-service engagements remain the only dotted-line consulting mechanism.
5. `agent_secondary_relationships` are advisory only in phase 1.
6. Every durable artifact should have an owner.
7. Legacy conference rooms without a kind remain unclassified; do not backfill guessed history.
8. Each executing issue has exactly one continuity owner at a time.
9. Ownership transfer requires a handoff artifact.

## 4. Connection Contract

Template-level agent instructions may declare a machine-readable connection contract in `AGENTS.md` frontmatter:

```yaml
connectionContractKind: paperclip/connection-contract.v1
connectionContract:
  upstreamInputs:
    - assignment packets on owned issues
  downstreamOutputs:
    - heartbeat packets and handoff docs
  ownedArtifacts:
    - tasks/<slug>/docs/plan.md
  delegationRights:
    - may delegate scoped subtasks to direct reports
  reviewRights:
    - may request QA review
  escalationPath:
    - team lead
    - director
    - executive sponsor
  standingRooms:
    - project leadership room
  scopeBoundaries:
    - no direct routing outside current company scope
  cadence:
    workerUpdates: every active work session and at least daily while work remains open
```

Phase 1 rules:

- contracts live at the template or archetype layer
- instance overrides are limited to concrete ids or principals
- contracts are read-only in product surfaces
- contracts do not alter permissions or routing on their own

## 5. Packet Layer

Paperclip recognizes five packet envelopes in markdown frontmatter:

- `paperclip/assignment.v1`
- `paperclip/heartbeat.v1`
- `paperclip/decision-request.v1`
- `paperclip/review-request.v1`
- `paperclip/escalation.v1`

Rules:

- only parse when frontmatter `kind` is in the `paperclip/*` packet namespace
- unknown or malformed frontmatter falls back to ordinary markdown
- no packet creates an assignment, approval, escalation, or engagement by itself

### 5.1 Preferred Locations

- `assignment`
  Preferred on issue comments and should accompany the real issue create/assign/reassign action.
- `heartbeat`
  Issue comments only. The latest heartbeat is the current summary; older ones are audit history.
- `decision-request`
  Preferred on conference-room comments and must resolve to an approval, explicit decline, or documented no-action outcome.
- `review-request`
  Preferred on issue or conference-room comments and must resolve to findings, handoff, or consulting closeout.
- `escalation`
  Preferred on issue or conference-room comments and must resolve with a disposition comment, approval, or shared-service engagement.

## 6. Room Taxonomy

Conference rooms may declare one of these kinds:

- `executive_staff`
- `project_leadership`
- `architecture_review`
- `incident`
- `audit_release`

Phase 1 behavior:

- the DB field is nullable
- existing rooms may remain `null`
- new rooms default to `project_leadership`
- UI should surface kind when present and show legacy/generic state when absent

### 6.1 Project Leadership Kickoffs

Use a `project_leadership` conference room as the kickoff venue when:

- a new project enters execution
- a major approved plan needs decomposition into owned execution work

Routine issue updates do not require a kickoff.

Kickoff expectations:

- include the relevant functional leads
- include the relevant executive sponsor when prioritization, staffing, budget, risk, or strategic direction is in scope
- leave with an owned work breakdown: issues/tasks, dependencies, milestone intent, key risks, open questions, and a named owner for each work item
- record outcomes immediately in durable artifacts, using project `context` and `decision-log` docs plus issue `plan` docs as needed

### 6.2 Room Participation And Questions

Phase 1 conference rooms behave as invitation-based chat channels:

- any invited agent may participate; room access is not restricted to leader-tier agents
- board may post top-level `note` or `question` messages
- invited agents may post top-level `note` messages and threaded replies
- threaded replies stay in the room thread; top-level agent notes may wake the other invited agents
- top-level board `question` messages create explicit reply obligations for invited agents
- room discussion coordinates, escalates, and records context, but material decisions still resolve through approvals

Governance rules:

- kickoff discussion coordinates leaders; it does not authorize high-impact decisions or commitments by itself
- material direction, governance, or commitment changes must resolve through an approval outcome

## 7. Durable Artifacts

Reserved project document keys:

- `context`
- `decision-log`
- `risks`
- `runbook`

Reserved issue document keys:

- `spec`
- `plan`
- `runbook`
- `progress`
- `test-plan`
- `handoff`
- `review-findings`
- `branch-return`

These keys are reserved but open-world:

- product surfaces may promote them specially
- unknown keys still coexist safely
- phase 1 does not treat the reserved set as a closed universe

Leadership owns project-level docs. Workers usually own issue-level docs unless local process says otherwise.

### 7.1 Issue Working Sets

Paperclip uses three default issue working-set tiers:

- tiny
  `spec` + `progress`
- normal
  `spec` + `plan` + `progress` + `test-plan`
- long-running
  `spec` + `plan` + `runbook` + `progress` + `test-plan` + `handoff`

`handoff` becomes mandatory before ownership transfer. Long-running issues should have the handoff slot prepared from the start.

### 7.2 Continuity Rules

- `spec` is the frozen task intent and scoped interface contract
- `plan` is continuity-owner-controlled and may evolve as execution learns
- `runbook` carries issue-local execution instructions and overrides the project runbook when needed
- `progress` carries the current snapshot plus append-only checkpoints for resume
- `test-plan` carries validation intent
- `handoff` is the required ownership-transfer artifact
- `review-findings` is the durable reviewer return artifact; review comments and packets may point to it, but they do not replace it
- `branch-return` is the required branch-owner return artifact before any parent merge preview or merge confirmation
- planning is a pre-execution continuity phase; all new issues begin in planning and only move into execution when the required docs exist, blocking decision questions are resolved, and continuity health is clean enough to proceed
- blocking decision questions pause planning or execution without overloading approvals; answering a question wakes the requesting agent with the structured answer context
- the server owns a persisted continuity snapshot for tier, status, health, spec state, required docs, and unresolved branches; UI hints are never the source of truth once that state exists
- execution starts must fail explicitly when required continuity docs are missing or handoff state is invalid
- continuity scaffolding happens only through explicit continuity actions such as prepare, handoff, spec thaw, and branch creation; heartbeat execution must not silently create docs
- remediation is explicit and actor-scoped: stale progress, invalid handoffs, open findings, and returned branches must surface as server-derived actions, not client heuristics
- real-run continuity eval traces may be captured nightly beside seeded evals, but they remain informational and read-only until the signal is stable
- provider-native planning or ask-user features are optional accelerators only; the Paperclip issue docs and decision-question artifacts remain the persisted source of truth across adapters

Runbook precedence:

1. issue `spec`
2. issue `plan`
3. issue `runbook`
4. issue `progress`
5. project `context`
6. project `runbook`
7. company operating constraints only when relevant

### 7.3 Freeze and Takeover

- `spec` freezes when active execution begins
- thawing `spec` requires explicit approval-backed authority on the issue
- only the continuity owner or project leadership may request a spec thaw
- branch workers and reviewers must not edit `spec` directly
- `progress` never rewrites history; only the top snapshot may compact prior checkpoints
- reassignment, human takeover, and emergency override all require a handoff with reason code, timestamp, transfer target, unresolved branches, and exact next action

## 8. Team Layer

Paperclip has a real team layer even before first-class team tables become richer.

Portable packages may include:

- `teams/<slug>/TEAM.md`

`TEAM.md` should define:

- team charter
- backlog and status conventions
- interface ownership

## 9. Default UX Direction

Paperclip’s default product experience should now assume shared-state execution:

- new issues default to the `normal` continuity tier unless explicitly created as tiny or long-running
- entering active execution should route through continuity readiness and remediation, not raw comment discovery
- issue continuity is the default execution surface; raw documents remain available as artifact-level detail
- org views default to accountability grouping: executive office, projects, leadership, continuity owners, shared services, and unassigned agents
- legacy relay-role templates remain supported for compatibility, but they are hidden behind legacy filters in default creation and onboarding flows
- upward summarization expectations

Team leads are accountable for summary-up, execution-lane clarity, and interface coordination.

## 9. Cadence

Minimum rhythm expectations:

- workers post a heartbeat summary on every active work session and at least once per business day while an issue remains `in_progress` or `blocked`
- team leads summarize lane status upward at least once per business day for active teams
- project leadership reviews status, risks, and dependencies at least weekly for active projects, and immediately when a blocker needs routing or a decision is requested
- executive staff reviews portfolio state at least weekly
- incident rooms update at least every 30 minutes, or on every material state change, until disposition
- consultant engagements close with explicit findings, handoff, or no-action outcome before the engagement is marked complete or within one business day of the last material action
- milestone boundaries should reset stale context before the next phase starts

Company packages may choose a tighter rhythm, but they must not go looser than these minimums without an explicit override policy.

## 10. Portability

Phase 1 portable company packages canonically include:

- `OPERATING_SYSTEM.md`
- `COMPANY.md`
- `teams/<slug>/TEAM.md`
- `projects/<slug>/PROJECT.md`
- `agents/<slug>/AGENTS.md`
- existing `TASK.md` and `SKILL.md` content

Business docs like `vision.md` or `priorities.md` may be exported, but they are non-normative for collaboration behavior.

Portable exports must preserve:

- `connectionContractKind`
- `connectionContract`
- reserved project and issue document keys

## 11. Non-Goals For Phase 1

Phase 1 does not add:

- packet-specific tables
- packet-driven state changes
- contract-driven permission logic
- room-based routing automation
- live company-doc editing workflows
- a second workflow engine beside issues, approvals, rooms, and engagements
