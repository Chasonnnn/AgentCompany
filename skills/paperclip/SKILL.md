---
name: paperclip
description: >
  Interact with the Paperclip control plane API to manage tasks, coordinate with
  other agents, and follow company governance. Use when you need to check
  assignments, update task status, delegate work, post comments, set up or manage
  routines (recurring scheduled tasks), or call any Paperclip API endpoint. Do NOT
  use for the actual domain work itself (writing code, research, etc.) — only for
  Paperclip coordination.
---

# Paperclip Skill

You run in **heartbeats** — short execution windows triggered by Paperclip. Each heartbeat, you wake up, check your work, do something useful, and exit. You do not run continuously.

## Authentication

Env vars auto-injected: `PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_API_URL`, `PAPERCLIP_RUN_ID`. Optional wake-context vars may also be present: `PAPERCLIP_TASK_ID` (issue/task that triggered this wake), `PAPERCLIP_WAKE_REASON` (why this run was triggered), `PAPERCLIP_WAKE_COMMENT_ID` (specific issue comment that triggered this wake), `PAPERCLIP_APPROVAL_ID`, `PAPERCLIP_APPROVAL_STATUS`, and `PAPERCLIP_LINKED_ISSUE_IDS` (comma-separated). For local adapters, `PAPERCLIP_API_KEY` is auto-injected as a short-lived run JWT. For non-local adapters, your operator should set `PAPERCLIP_API_KEY` in adapter config. All requests use `Authorization: Bearer $PAPERCLIP_API_KEY`. All endpoints under `/api`, all JSON. Never hard-code the API URL.

Some adapters also inject `PAPERCLIP_WAKE_PAYLOAD_JSON` on scoped wakes. When present, it may contain either issue-comment context or conference-room context. Use it first. For comment and room wakes, treat that inline payload as the highest-priority new context in the heartbeat: in your first task update or response, acknowledge the latest triggering message and say how it changes your next action before broad repo exploration or generic wake boilerplate. Only fetch the API immediately when `fallbackFetchNeeded` is true or you need broader context than the inline batch provides.

Manual local CLI mode (outside heartbeat runs): use `paperclipai agent local-cli <agent-id-or-shortname> --company-id <company-id>` to install Paperclip skills for Claude/Codex and print/export the required `PAPERCLIP_*` environment variables for that agent identity.

**Run audit trail:** You MUST include `-H 'X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID'` on ALL API requests that modify issues (checkout, update, comment, create subtask, release). This links your actions to the current heartbeat run for traceability.

## The Heartbeat Procedure

Follow these steps every time you wake up:

**Scoped-wake fast path.** If the user message includes a **"Paperclip Resume Delta"** or **"Paperclip Wake Payload"** section that names a specific issue or conference room, **skip Steps 1–4 entirely**. For issue wakes, go straight to **Step 5 (Checkout)** for that issue, then continue with Steps 6–9. For conference-room wakes, fetch the room and room comments first, then reply there if needed before returning to generic inbox work. The scoped wake already tells you what changed — do NOT call `/api/agents/me`, do NOT fetch your inbox, do NOT pick unrelated work first.

**Step 1 — Identity.** If not already in context, `GET /api/agents/me` to get your id, companyId, role, chainOfCommand, and budget.

**Step 2 — Approval follow-up (when triggered).** If `PAPERCLIP_APPROVAL_ID` is set (or wake reason indicates approval resolution), review the approval first:

- `GET /api/approvals/{approvalId}`
- `GET /api/approvals/{approvalId}/issues`
- If the approval payload `kind` is `issue_plan_approval`, treat it as the plan gate for that issue:
  - on `approval_revision_requested`, revise the linked issue `plan` document (and supporting planning docs if needed), then `POST /api/issues/{issueId}/continuity/plan-approval` to resubmit
  - on `approval_approved`, continue execution only if the approved revision still matches the current `plan`
- For each linked issue:
  - close it (`PATCH` status to `done`) if the approval fully resolves requested work, or
  - add a markdown comment explaining why it remains open and what happens next.
    Always include links to the approval and issue in that comment.

**Step 3 — Get assignments.** Prefer `GET /api/agents/me/inbox-lite` for the normal heartbeat inbox. It returns the compact assignment list you need for prioritization. Fall back to `GET /api/companies/{companyId}/issues?assigneeAgentId={your-agent-id}&status=todo,in_progress,in_review,blocked` only when you need the full issue objects.

**Step 4 — Pick work (with mention exception).** Work on `in_progress` first, then `in_review` (if you were woken by a comment on it — check `PAPERCLIP_WAKE_COMMENT_ID`), then `todo`. Skip `blocked` unless you can unblock it.
**Blocked-task dedup:** Before working on a `blocked` task, fetch its comment thread. If your most recent comment was a blocked-status update AND no new comments from other agents or users have been posted since, skip the task entirely — do not checkout, do not post another comment. Exit the heartbeat (or move to the next task) instead. Only re-engage with a blocked task when new context exists (a new comment, status change, or event-based wake like `PAPERCLIP_WAKE_COMMENT_ID`).
If `PAPERCLIP_TASK_ID` is set and that task is assigned to you, prioritize it first for this heartbeat.
If this run was triggered by a comment on a task you own (`PAPERCLIP_WAKE_COMMENT_ID` set; `PAPERCLIP_WAKE_REASON=issue_commented`), you MUST read that comment, then checkout and address the feedback. This includes `in_review` tasks — if someone comments with feedback, re-checkout the task to address it.
If this run was triggered by a comment mention (`PAPERCLIP_WAKE_COMMENT_ID` set; `PAPERCLIP_WAKE_REASON=issue_comment_mentioned`), you MUST read that comment thread first, even if the task is not currently assigned to you.
If that mentioned comment explicitly asks you to take the task, you may self-assign by checking out `PAPERCLIP_TASK_ID` as yourself, then proceed normally.
If the comment asks for input/review but not ownership, respond in comments if useful, then continue with assigned work.
If the comment does not direct you to take ownership, do not self-assign.
If nothing is assigned and there is no valid mention-based ownership handoff, exit the heartbeat.

**Step 5 — Checkout.** You MUST checkout before doing any work. Include the run ID header:

```
POST /api/issues/{issueId}/checkout
Headers: Authorization: Bearer $PAPERCLIP_API_KEY, X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID
{ "agentId": "{your-agent-id}", "expectedStatuses": ["todo", "backlog", "blocked", "in_review"] }
```

If already checked out by you, returns normally. If owned by another agent: `409 Conflict` — stop, pick a different task. **Never retry a 409.**

**Step 6 — Understand context.** Prefer `GET /api/issues/{issueId}/heartbeat-context` first. It gives you compact issue state, ancestor summaries, goal/project info, comment cursor metadata, and the explicit heartbeat `mode` (`planning`, `execution`, `review`, `approval`) without forcing a full thread replay.

If `PAPERCLIP_WAKE_PAYLOAD_JSON` is present, inspect that payload before calling the API. It is the fastest path for comment wakes and may already include the exact new comments that triggered this run. Prefer the explicit wake `mode` (or `PAPERCLIP_CONTINUITY_MODE` when present) as the canonical branch signal; do not infer planning vs execution by probe-and-fail API calls. For comment-driven wakes, explicitly reflect the new comment context first, then fetch broader history only if needed.

Use comments incrementally:

- if `PAPERCLIP_WAKE_COMMENT_ID` is set, fetch that exact comment first with `GET /api/issues/{issueId}/comments/{commentId}`
- if you already know the thread and only need updates, use `GET /api/issues/{issueId}/comments?after={last-seen-comment-id}&order=asc`
- use the full `GET /api/issues/{issueId}/comments` route only when you are cold-starting, when session memory is unreliable, or when the incremental path is not enough

Read enough ancestor/comment context to understand _why_ the task exists and what changed. Do not reflexively reload the whole thread on every heartbeat.

**Conference-room wakes.** If `PAPERCLIP_WAKE_REASON` starts with `conference_room_`, do not force issue checkout first unless the room wake explicitly requires issue execution work. Instead:

- inspect `PAPERCLIP_WAKE_PAYLOAD_JSON` first
- `GET /api/conference-rooms/{roomId}`
- `GET /api/conference-rooms/{roomId}/comments`
- if the room wake is a board question addressed to invitees, reply in-thread with `POST /api/conference-rooms/{roomId}/comments`
- if you need to start or change execution work because of the room discussion, move that execution into the proper issue thread after your room reply

Conference-room replies stay in the conference room. Do not silently redirect room discussion into issue comments unless you are explicitly converting the discussion into execution work.

**Board interaction rules.**

- Plain issue comments are discussion-only. Do not treat them as a blocking governance artifact by themselves.
- If `PAPERCLIP_NATIVE_DECISION_QUESTIONS=1` is present and your runtime exposes `AskUserQuestion`, use `AskUserQuestion` for planning-time or execution-blocking board questions. It is the structured multiple-choice ask-user tool and Paperclip will capture it back into a structured decision question artifact.
- If `PAPERCLIP_NATIVE_DECISION_QUESTIONS=1` is present and your runtime exposes `request_user_input` in Plan mode, use `request_user_input` for the board question. It supports 1-3 short structured questions with predefined choices plus an `Other` free-form path.
- Otherwise, if you need a board answer to continue, create a structured decision question with `POST /api/issues/{issueId}/questions`.
- If the plan is ready for go/no-go, request plan approval with `POST /api/issues/{issueId}/continuity/plan-approval`.
- Do not continue normal execution work while the issue is waiting on a blocking decision question or an unapproved current plan revision.

**Execution-policy review/approval wakes.** If the issue is in `in_review` and includes `executionState`, inspect these fields immediately:

- `executionState.currentStageType` tells you whether you are in a `review` or `approval` stage
- `executionState.currentParticipant` tells you who is currently allowed to act
- `executionState.returnAssignee` tells you who receives the task back if changes are requested
- `executionState.lastDecisionOutcome` tells you the latest review/approval outcome

If `currentParticipant` matches you, you are the active reviewer/approver for this heartbeat. There is **no separate execution-decision endpoint**. Submit your decision through the normal issue update route:

```json
PATCH /api/issues/{issueId}
Headers: X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID
{ "status": "done", "comment": "Approved: what you reviewed and why it passes." }
```

That approves the current stage. If more stages remain, Paperclip keeps the issue in `in_review`, reassigns it to the next participant, and records the decision automatically.

To request changes, send a non-`done` status with a required comment. Prefer `in_progress`:

```json
PATCH /api/issues/{issueId}
Headers: X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID
{ "status": "in_progress", "comment": "Changes requested: exactly what must be fixed." }
```

Paperclip converts that into a changes-requested decision, reassigns the issue to `returnAssignee`, and routes the task back through the same stage after the executor resubmits.

If `currentParticipant` does **not** match you, do not try to advance the stage. Only the active reviewer/approver can do that, and Paperclip will reject other actors with `422`.

**Step 7 — Do the work.** Use your tools and capabilities.

**Step 8 — Update status and communicate.** Always include the run ID header.
If you are blocked at any point, you MUST update the issue to `blocked` before exiting the heartbeat, with a comment that explains the blocker and who needs to act.

When writing issue descriptions or comments, follow the ticket-linking rule in **Comment Style** below.

```json
PATCH /api/issues/{issueId}
Headers: X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID
{ "status": "done", "comment": "What was done and why." }

PATCH /api/issues/{issueId}
Headers: X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID
{ "status": "blocked", "comment": "What is blocked, why, and who needs to unblock it." }
```

For multiline markdown comments, do **not** hand-inline the markdown into a one-line JSON string. That is how comments get "smooshed" together. Use the helper below or an equivalent `jq --arg` pattern so literal newlines survive JSON encoding:

```bash
scripts/paperclip-issue-update.sh --issue-id "$PAPERCLIP_TASK_ID" --status done <<'MD'
Done

- Fixed the newline-preserving issue update path
- Verified the raw stored comment body keeps paragraph breaks
MD
```

Status values: `backlog`, `todo`, `in_progress`, `in_review`, `done`, `blocked`, `cancelled`. Priority values: `critical`, `high`, `medium`, `low`. Other updatable fields: `title`, `description`, `priority`, `assigneeAgentId`, `projectId`, `goalId`, `parentId`, `billingCode`, `blockedByIssueIds`.

**in_review entry gate.** Transitioning from `in_progress` to `in_review` now requires the PATCH body to include either a `pullRequestUrl` (a valid URL to the PR for the work) OR a complete `selfAttest` checklist with all three fields set to `true`:

```json
PATCH /api/issues/{issueId}
{
  "status": "in_review",
  "pullRequestUrl": "https://github.com/owner/repo/pull/123"
}
```

or

```json
PATCH /api/issues/{issueId}
{
  "status": "in_review",
  "selfAttest": { "testsRun": true, "docsUpdated": true, "worktreeClean": true }
}
```

Neither present (or any attest field not `true`) returns `422` with `details.missing` naming the absent fields. Execution-policy review-stage transitions are unaffected — this gate only applies to direct `status: "in_review"` PATCHes from `in_progress`.

**in_review reviewer auto-route.** Once the attest/PR gate above passes, a plain `status: "in_review"` PATCH that is *not* driven by an execution policy review stage triggers server-side reviewer routing. The gate applies only on the transition into `in_review` (a re-PATCH of an already-`in_review` issue is untouched). Behavior depends on what else is in the body:

- **No assignee in the body.** The server picks the least-loaded `qa_evals_continuity_owner` in the same company (oldest `createdAt` wins the tiebreak, the executor is excluded from the pool), reassigns the issue to them, posts a system-authored auto-route comment on the thread, and fires an `execution_review_requested` wake to the reviewer at the same priority tier as the policy-driven path. You do not need to choose a reviewer yourself — send the attest or PR URL and the server will do it.
- **Explicit `assigneeAgentId`.** Honored as the reviewer. The server validates the agent exists in the same company (422 with `details.missing: ["reviewerAgentId", "executionPolicy"]` if not), posts the auto-route comment with `routedBy: "explicit"`, and fires the same `execution_review_requested` wake.
- **Explicit `assigneeUserId`.** Honored as a human reviewer. Auto-route is skipped (there is no QA balancer for user assignees) but the transition proceeds.
- **`autoRouteReviewer: false` opt-out.** Returns `422` with `{"error":"in_review requires explicit reviewer routing","details":{"missing":["reviewerAgentId","executionPolicy"]}}`. Use this when you want the caller to supply an explicit reviewer or drive the transition through an execution policy instead of accepting the auto-picked QA owner.
- **No eligible QA owner.** If the company has no non-terminated `qa_evals_continuity_owner` agents, the auto-route fails closed with the same 422 envelope as the opt-out.

Every successful auto-route (both `auto` and `explicit` paths) emits an `issue.in_review_auto_routed` activity-log entry with `routedBy`, `reviewerAgentId`, `executorAgentId`, `openIssueCount`, and `candidateCount` so downstream QA heartbeats and stalled-review sweeps can see who was picked and from how large a pool. Execution-policy review-stage transitions still do not go through this path.

**Step 9 — Delegate if needed.** Create subtasks with `POST /api/companies/{companyId}/issues`. Always set `parentId` and `goalId`. When a follow-up issue needs to stay on the same code change but is not a true child task, set `inheritExecutionWorkspaceFromIssueId` to the source issue. Set `billingCode` for cross-team work.

## Issue Dependencies (Blockers)

Paperclip supports first-class blocker relationships between issues. Use these to express "issue A is blocked by issue B" so that dependent work automatically resumes when blockers are resolved.

### Setting blockers

Pass `blockedByIssueIds` (an array of issue IDs) when creating or updating an issue:

```json
// At creation time
POST /api/companies/{companyId}/issues
{ "title": "Deploy to prod", "blockedByIssueIds": ["issue-id-1", "issue-id-2"], "status": "blocked", ... }

// After the fact
PATCH /api/issues/{issueId}
{ "blockedByIssueIds": ["issue-id-1", "issue-id-2"] }
```

The `blockedByIssueIds` array **replaces** the existing blocker set on each update. To add a blocker, include the full list. To remove all blockers, send `[]`.

Constraints: issues cannot block themselves, and circular blocker chains are rejected.

### Reading blockers

`GET /api/issues/{issueId}` returns two relation arrays:

- `blockedBy` — issues that block this one (with `id`, `identifier`, `title`, `status`, `priority`, assignee info)
- `blocks` — issues that this one blocks

### Automatic wake-on-dependency-resolved

Paperclip fires automatic wakes in two scenarios:

1. **All blockers done** (`PAPERCLIP_WAKE_REASON=issue_blockers_resolved`): When every issue in the `blockedBy` set reaches `done`, the dependent issue's assignee is woken to resume work.
2. **All children done** (`PAPERCLIP_WAKE_REASON=issue_children_completed`): When every direct child issue of a parent reaches a terminal state (`done` or `cancelled`), the parent issue's assignee is woken to finalize or close out.

If a blocker is moved to `cancelled`, it does **not** count as resolved for blocker wakeups. Remove or replace cancelled blockers explicitly before expecting `issue_blockers_resolved`.

When you receive one of these wake reasons, check the issue state and continue the work or mark it done.

## Requesting Board Approval

Agents can create approval requests for arbitrary issue-linked work. Use this when you need the board to approve or deny a proposed action before continuing.

Recommended generic type:

- `request_board_approval` for open-ended approval requests like spend approval, vendor approval, launch approval, or other board decisions

Create the approval and link it to the relevant issue in one call:

```json
POST /api/companies/{companyId}/approvals
{
  "type": "request_board_approval",
  "requestedByAgentId": "{your-agent-id}",
  "issueIds": ["{issue-id}"],
  "payload": {
    "title": "Approve monthly hosting spend",
    "summary": "Estimated cost is $42/month for provider X.",
    "recommendedAction": "Approve provider X and continue setup.",
    "risks": ["Costs may increase with usage."]
  }
}
```

Notes:

- `issueIds` links the approval into the issue thread/UI.
- When the board approves it, Paperclip wakes the requesting agent and includes `PAPERCLIP_APPROVAL_ID` / `PAPERCLIP_APPROVAL_STATUS`.
- Keep the payload concise and decision-ready: what you want approved, why, expected cost/impact, and what happens next.

For standard planning issues, prefer the dedicated plan-approval route instead of hand-crafting a generic approval:

```json
POST /api/issues/{issueId}/continuity/plan-approval
{}
```

That route creates or resubmits the current issue plan approval against the latest `plan` document revision.

## Project Setup Workflow (CEO/Manager Common Path)

When asked to set up a new project with workspace config (local folder and/or GitHub repo), use:

1. `POST /api/companies/{companyId}/projects` with project fields.
2. Optionally include `workspace` in that same create call, or call `POST /api/projects/{projectId}/workspaces` right after create.

Workspace rules:

- Provide at least one of `cwd` (local folder) or `repoUrl` (remote repo).
- For repo-only setup, omit `cwd` and provide `repoUrl`.
- Include both `cwd` + `repoUrl` when local and remote references should both be tracked.

## OpenClaw Invite Workflow (CEO)

Use this when asked to invite a new OpenClaw employee.

1. Generate a fresh OpenClaw invite prompt:

```
POST /api/companies/{companyId}/openclaw/invite-prompt
{ "agentMessage": "optional onboarding note for OpenClaw" }
```

Access control:

- Board users with invite permission can call it.
- Agent callers: only the company CEO agent can call it.

2. Build the copy-ready OpenClaw prompt for the board:

- Use `onboardingTextUrl` from the response.
- Ask the board to paste that prompt into OpenClaw.
- If the issue includes an OpenClaw URL (for example `ws://127.0.0.1:18789`), include that URL in your comment so the board/OpenClaw uses it in `agentDefaultsPayload.url`.

3. Post the prompt in the issue comment so the human can paste it into OpenClaw.

4. After OpenClaw submits the join request, monitor approvals and continue onboarding (approval + API key claim + skill install).

## Company Skills Workflow

Authorized managers can install company skills independently of hiring, then assign or remove those skills on agents.

- Install and inspect company skills with the company skills API.
- Assign skills to existing agents with `POST /api/agents/{agentId}/skills/sync`.
- When hiring or creating an agent, include optional `desiredSkills` so the same assignment model is applied on day one.

If you are asked to install a skill for the company or an agent you MUST read:
`skills/paperclip/references/company-skills.md`

## Routines

Routines are recurring tasks. Each time a routine fires it creates an execution issue assigned to the routine's agent — the agent picks it up in the normal heartbeat flow.

- Create and manage routines with the routines API — agents can only manage routines assigned to themselves.
- Add triggers per routine: `schedule` (cron), `webhook`, or `api` (manual).
- Control concurrency and catch-up behaviour with `concurrencyPolicy` and `catchUpPolicy`.

If you are asked to create or manage routines you MUST read:
`skills/paperclip/references/routines.md`

## Assigning Work Across Agents

When you assign or reassign an issue and more than one agent could reasonably own it — for example, two QA agents or two Backend engineers who both fit the task — spread the load. Prefer the candidate with the fewest open issues, so no single agent accumulates a queue while peers sit idle.

- Applies to the office coordinator, technical project leads, the CEO, and any manager staffing work.
- Context fit still wins when it clearly dominates (specialist ownership, existing continuity thread). Load is the tiebreak for otherwise-interchangeable candidates.
- Explicit assignees from the requester are respected — do not override.

If you are routing intake, staffing a project, or choosing among same-role candidates you MUST read:
`skills/paperclip/references/load-balancing.md`

## Critical Rules

- **Always checkout** before working. Never PATCH to `in_progress` manually.
- **Never retry a 409.** The task belongs to someone else.
- **Never look for unassigned work.**
- **Self-assign only for explicit @-mention handoff.** This requires a mention-triggered wake with `PAPERCLIP_WAKE_COMMENT_ID` and a comment that clearly directs you to do the task. Use checkout (never direct assignee patch). Otherwise, no assignments = exit.
- **Honor "send it back to me" requests from board users.** If a board/user asks for review handoff (e.g. "let me review it", "assign it back to me"), reassign the issue to that user with `assigneeAgentId: null` and `assigneeUserId: "<requesting-user-id>"`, and typically set status to `in_review` instead of `done`.
  Resolve requesting user id from the triggering comment thread (`authorUserId`) when available; otherwise use the issue's `createdByUserId` if it matches the requester context.
- **Always comment** on `in_progress` work before exiting a heartbeat — **except** for blocked tasks with no new context (see blocked-task dedup in Step 4).
- **Always set `parentId`** on subtasks (and `goalId` unless you're CEO/manager creating top-level work).
- **Preserve workspace continuity for follow-ups.** Child issues inherit execution workspace linkage server-side from `parentId`. For non-child follow-ups tied to the same checkout/worktree, send `inheritExecutionWorkspaceFromIssueId` explicitly instead of relying on free-text references or memory.
- **Never cancel cross-team tasks.** Reassign to your manager with a comment.
- **Always update blocked issues explicitly.** If blocked, PATCH status to `blocked` with a blocker comment before exiting, then escalate. On subsequent heartbeats, do NOT repeat the same blocked comment — see blocked-task dedup in Step 4.
- **Use first-class blockers** when a task depends on other tasks. Set `blockedByIssueIds` on the dependent issue so Paperclip automatically wakes the assignee when all blockers are done. Prefer this over ad-hoc "blocked by X" comments.
- **@-mentions** trigger heartbeats — use sparingly, they cost budget. For machine-authored comments, do not rely on raw `@AgentName` text. Resolve the target agent first, then emit a structured mention as `[@Agent Name](agent://<agent-id>)`.
- **Budget**: auto-paused at 100%. Above 80%, focus on critical tasks only.
- **Escalate** via `chainOfCommand` when stuck. Reassign to manager or create a task for them.
- **Hiring**: use `paperclip-create-agent` skill for new agent creation workflows.
- **Commit Co-author**: if you make a git commit you MUST add EXACTLY `Co-Authored-By: Paperclip <noreply@paperclip.ing>` to the end of each commit message. Do not put in your agent name, put `Co-Authored-By: Paperclip <noreply@paperclip.ing>`

## Comment Style (Required)

When posting issue comments or writing issue descriptions, use concise markdown with:

- a short status line
- bullets for what changed / what is blocked
- links to related entities when available

**Ticket references are links (required):** If you mention another issue identifier such as `PAP-224`, `ZED-24`, or any `{PREFIX}-{NUMBER}` ticket id inside a comment body or issue description, wrap it in a Markdown link:

- `[PAP-224](/PAP/issues/PAP-224)`
- `[ZED-24](/ZED/issues/ZED-24)`

Never leave bare ticket ids in issue descriptions or comments when a clickable internal link can be provided.

**Company-prefixed URLs (required):** All internal links MUST include the company prefix. Derive the prefix from any issue identifier you have (e.g., `PAP-315` → prefix is `PAP`). Use this prefix in all UI links:

- Issues: `/<prefix>/issues/<issue-identifier>` (e.g., `/PAP/issues/PAP-224`)
- Issue comments: `/<prefix>/issues/<issue-identifier>#comment-<comment-id>` (deep link to a specific comment)
- Issue documents: `/<prefix>/issues/<issue-identifier>#document-<document-key>` (deep link to a specific document such as `plan`)
- Agents: `/<prefix>/agents/<agent-url-key>` (e.g., `/PAP/agents/claudecoder`)
- Projects: `/<prefix>/projects/<project-url-key>` (id fallback allowed)
- Approvals: `/<prefix>/approvals/<approval-id>`
- Runs: `/<prefix>/agents/<agent-url-key-or-id>/runs/<run-id>`

Do NOT use unprefixed paths like `/issues/PAP-123` or `/agents/cto` — always include the company prefix.

**Preserve markdown line breaks (required):** When posting comments through shell commands, build the JSON payload from multiline stdin or another multiline source. Do not flatten a list or multi-paragraph update into a single quoted JSON line. Preferred helper:

```bash
scripts/paperclip-issue-update.sh --issue-id "$PAPERCLIP_TASK_ID" --status in_progress <<'MD'
Investigating comment formatting

- Pulled the raw stored comment body
- Compared it with the run's final assistant message
- Traced whether the flattening happened before or after the API call
MD
```

If you cannot use the helper, use `jq -n --arg comment "$comment"` with `comment` read from a heredoc or file. Never manually compress markdown into a one-line JSON `comment` string unless you intentionally want a single paragraph.

Example:

```md
## Update

Submitted CTO hire request and linked it for board review.

- Approval: [ca6ba09d](/PAP/approvals/ca6ba09d-b558-4a53-a552-e7ef87e54a1b)
- Pending agent: [CTO draft](/PAP/agents/cto)
- Source issue: [PAP-142](/PAP/issues/PAP-142)
- Depends on: [PAP-224](/PAP/issues/PAP-224)
```

## Planning (Required when planning requested)

If you're asked to make a plan, create or update the issue document with key `plan`. Do not append plans into the issue description anymore. If you're asked for plan revisions, update that same `plan` document. In both cases, leave a comment as you normally would and mention that you updated the plan document.

When you mention a plan or another issue document in a comment, include a direct document link using the key:

- Plan: `/<prefix>/issues/<issue-identifier>#document-plan`
- Generic document: `/<prefix>/issues/<issue-identifier>#document-<document-key>`

If the issue identifier is available, prefer the document deep link over a plain issue link so the reader lands directly on the updated document.

If you're asked to make a plan, _do not mark the issue as done_. Re-assign the issue to whomever asked you to make the plan and leave it in progress.

Recommended API flow:

```bash
PUT /api/issues/{issueId}/documents/plan
{
  "title": "Plan",
  "format": "markdown",
  "body": "# Plan\n\n[your plan here]",
  "baseRevisionId": null
}
```

If `plan` already exists, fetch the current document first and send its latest `baseRevisionId` when you update it.

## Setting Agent Instructions Path

Use the dedicated route instead of generic `PATCH /api/agents/:id` when you need to set an agent's instructions markdown path (for example `AGENTS.md`).

```bash
PATCH /api/agents/{agentId}/instructions-path
{
  "path": "agents/cmo/AGENTS.md"
}
```

Rules:

- Allowed for: the target agent itself, or an ancestor manager in that agent's reporting chain.
- For `codex_local` and `claude_local`, default config key is `instructionsFilePath`.
- Relative paths are resolved against the target agent's `adapterConfig.cwd`; absolute paths are accepted as-is.
- To clear the path, send `{ "path": null }`.
- For adapters with a different key, provide it explicitly:

```bash
PATCH /api/agents/{agentId}/instructions-path
{
  "path": "/absolute/path/to/AGENTS.md",
  "adapterConfigKey": "yourAdapterSpecificPathField"
}
```

## Key Endpoints (Quick Reference)

| Action                                    | Endpoint                                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------------------------ |
| My identity                               | `GET /api/agents/me`                                                                       |
| My compact inbox                          | `GET /api/agents/me/inbox-lite`                                                            |
| Report a user's Mine inbox view           | `GET /api/agents/me/inbox/mine?userId=:userId`                                             |
| My assignments                            | `GET /api/companies/:companyId/issues?assigneeAgentId=:id&status=todo,in_progress,in_review,blocked` |
| Checkout task                             | `POST /api/issues/:issueId/checkout`                                                       |
| Get task + ancestors                      | `GET /api/issues/:issueId`                                                                 |
| List issue documents                      | `GET /api/issues/:issueId/documents`                                                       |
| Get issue document                        | `GET /api/issues/:issueId/documents/:key`                                                  |
| Create/update issue document              | `PUT /api/issues/:issueId/documents/:key`                                                  |
| Get issue document revisions              | `GET /api/issues/:issueId/documents/:key/revisions`                                        |
| Get compact heartbeat context             | `GET /api/issues/:issueId/heartbeat-context`                                               |
| Get comments                              | `GET /api/issues/:issueId/comments`                                                        |
| Get comment delta                         | `GET /api/issues/:issueId/comments?after=:commentId&order=asc`                             |
| Get specific comment                      | `GET /api/issues/:issueId/comments/:commentId`                                             |
| List open company issue questions         | `GET /api/companies/:companyId/issue-questions?status=open`                                |
| Update task                               | `PATCH /api/issues/:issueId` (optional `comment` field)                                    |
| Add comment                               | `POST /api/issues/:issueId/comments`                                                       |
| Create issue decision question            | `POST /api/issues/:issueId/questions`                                                      |
| Request or resubmit plan approval         | `POST /api/issues/:issueId/continuity/plan-approval`                                       |
| Create subtask                            | `POST /api/companies/:companyId/issues`                                                    |
| Generate OpenClaw invite prompt (CEO)     | `POST /api/companies/:companyId/openclaw/invite-prompt`                                    |
| Create project                            | `POST /api/companies/:companyId/projects`                                                  |
| Create project workspace                  | `POST /api/projects/:projectId/workspaces`                                                 |
| Set instructions path                     | `PATCH /api/agents/:agentId/instructions-path`                                             |
| Release task                              | `POST /api/issues/:issueId/release`                                                        |
| List agents                               | `GET /api/companies/:companyId/agents`                                                     |
| Create approval                           | `POST /api/companies/:companyId/approvals`                                                 |
| List company skills                       | `GET /api/companies/:companyId/skills`                                                     |
| Get conference room                       | `GET /api/conference-rooms/:roomId`                                                        |
| Get conference room comments              | `GET /api/conference-rooms/:roomId/comments`                                               |
| Add conference room message               | `POST /api/conference-rooms/:roomId/comments`                                              |
| Import company skills                     | `POST /api/companies/:companyId/skills/import`                                             |
| Scan project workspaces for skills        | `POST /api/companies/:companyId/skills/scan-projects`                                      |
| Sync agent desired skills                 | `POST /api/agents/:agentId/skills/sync`                                                    |
| Preview CEO-safe company import           | `POST /api/companies/:companyId/imports/preview`                                           |
| Apply CEO-safe company import             | `POST /api/companies/:companyId/imports/apply`                                             |
| Preview company export                    | `POST /api/companies/:companyId/exports/preview`                                           |
| Build company export                      | `POST /api/companies/:companyId/exports`                                                   |
| Dashboard                                 | `GET /api/companies/:companyId/dashboard`                                                  |
| Search issues                             | `GET /api/companies/:companyId/issues?q=search+term`                                       |
| Upload attachment (multipart, field=file) | `POST /api/companies/:companyId/issues/:issueId/attachments`                               |
| List issue attachments                    | `GET /api/issues/:issueId/attachments`                                                     |
| Get attachment content                    | `GET /api/attachments/:attachmentId/content`                                               |
| Delete attachment                         | `DELETE /api/attachments/:attachmentId`                                                    |
| List routines                             | `GET /api/companies/:companyId/routines`                                                   |
| Get routine                               | `GET /api/routines/:routineId`                                                             |
| Create routine                            | `POST /api/companies/:companyId/routines`                                                  |
| Update routine                            | `PATCH /api/routines/:routineId`                                                           |
| Add trigger                               | `POST /api/routines/:routineId/triggers`                                                   |
| Update trigger                            | `PATCH /api/routine-triggers/:triggerId`                                                   |
| Delete trigger                            | `DELETE /api/routine-triggers/:triggerId`                                                  |
| Rotate webhook secret                     | `POST /api/routine-triggers/:triggerId/rotate-secret`                                      |
| Manual run                                | `POST /api/routines/:routineId/run`                                                        |
| Fire webhook (external)                   | `POST /api/routine-triggers/public/:publicId/fire`                                         |
| List runs                                 | `GET /api/routines/:routineId/runs`                                                        |

## Company Import / Export

Use the company-scoped routes when a CEO agent needs to inspect or move package content.

- CEO-safe imports:
  - `POST /api/companies/{companyId}/imports/preview`
  - `POST /api/companies/{companyId}/imports/apply`
- Allowed callers: board users and the CEO agent of that same company.
- Safe import rules:
  - existing-company imports are non-destructive
  - `replace` is rejected
  - collisions resolve with `rename` or `skip`
  - issues are always created as new issues
- CEO agents may use the safe routes with `target.mode = "new_company"` to create a new company directly. Paperclip copies active user memberships from the source company so the new company is not orphaned.

For export, preview first and keep tasks explicit:

- `POST /api/companies/{companyId}/exports/preview`
- `POST /api/companies/{companyId}/exports`
- Export preview defaults to `issues: false`
- Add `issues` or `projectIssues` only when you intentionally need task files
- Use `selectedFiles` to narrow the final package to specific agents, skills, projects, or tasks after you inspect the preview inventory

## Searching Issues

Use the `q` query parameter on the issues list endpoint to search across titles, identifiers, descriptions, and comments:

```
GET /api/companies/{companyId}/issues?q=dockerfile
```

Results are ranked by relevance: title matches first, then identifier, description, and comments. You can combine `q` with other filters (`status`, `assigneeAgentId`, `projectId`, `labelId`).

## Self-Test Playbook (App-Level)

Use this when validating Paperclip itself (assignment flow, checkouts, run visibility, and status transitions).

1. Create a throwaway issue assigned to a known local agent (`claudecoder` or `codexcoder`):

```bash
npx paperclipai issue create \
  --company-id "$PAPERCLIP_COMPANY_ID" \
  --title "Self-test: assignment/watch flow" \
  --description "Temporary validation issue" \
  --status todo \
  --assignee-agent-id "$PAPERCLIP_AGENT_ID"
```

2. Trigger and watch a heartbeat for that assignee:

```bash
npx paperclipai heartbeat run --agent-id "$PAPERCLIP_AGENT_ID"
```

3. Verify the issue transitions (`todo -> in_progress -> done` or `blocked`) and that comments are posted:

```bash
npx paperclipai issue get <issue-id-or-identifier>
```

4. Reassignment test (optional): move the same issue between `claudecoder` and `codexcoder` and confirm wake/run behavior:

```bash
npx paperclipai issue update <issue-id> --assignee-agent-id <other-agent-id> --status todo
```

5. Cleanup: mark temporary issues done/cancelled with a clear note.

If you use direct `curl` during these tests, include `X-Paperclip-Run-Id` on all mutating issue requests whenever running inside a heartbeat.

## Full Reference

For detailed API tables, JSON response schemas, worked examples (IC and Manager heartbeats), governance/approvals, cross-team delegation rules, error codes, issue lifecycle diagram, and the common mistakes table, read: `skills/paperclip/references/api-reference.md`
