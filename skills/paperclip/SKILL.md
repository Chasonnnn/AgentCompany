---
name: paperclip
description: >
  Interact with the Paperclip control plane API to manage tasks, coordinate with
  other agents, and follow company governance. Use when you need to check
  assignments, update task status, delegate work, post comments, set up or manage
  routines, or call any Paperclip API endpoint. Do NOT use for the actual domain
  work itself (writing code, research, etc.) - only for Paperclip coordination.
---

# Paperclip Skill

You run in **heartbeats**: short execution windows triggered by Paperclip. Each heartbeat should inspect the delta, do one concrete useful action, update the control plane, and exit. Do not turn a heartbeat into a broad process checklist.

## Authentication

Paperclip injects `PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_API_URL`, `PAPERCLIP_RUN_ID`, and for local adapters a short-lived `PAPERCLIP_API_KEY`. Optional wake vars include `PAPERCLIP_TASK_ID`, `PAPERCLIP_WAKE_REASON`, `PAPERCLIP_WAKE_COMMENT_ID`, `PAPERCLIP_APPROVAL_ID`, `PAPERCLIP_APPROVAL_STATUS`, and `PAPERCLIP_LINKED_ISSUE_IDS`.

All API paths are under `/api`. Use `Authorization: Bearer $PAPERCLIP_API_KEY`. For mutating issue calls, include `X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID` so the run audit trail links your action.

If `PAPERCLIP_WAKE_PAYLOAD_JSON` or a user-visible **Paperclip Resume Delta / Wake Payload** is present, read it first. It is the default source of truth for the current wake.

Manual local CLI mode: `paperclipai agent local-cli <agent-id-or-shortname> --company-id <company-id>` installs Paperclip skills for Claude/Codex and prints the required `PAPERCLIP_*` variables.

## Heartbeat Contract

Default loop:

1. **Use the wake delta first.** If a resume/wake payload names a specific issue or room, do not fetch `/api/agents/me`, do not fetch the full inbox, and do not replay the full thread unless the payload says `fallbackFetchNeeded` or the small delta is insufficient.
2. **Resolve the target.** For issue wakes, use the named issue. For room wakes, fetch the room/thread and answer there if needed. For generic wakes, use `GET /api/agents/me/inbox-lite`.
3. **Checkout before issue work.** `POST /api/issues/{issueId}/checkout` with `agentId` and expected statuses. If checkout returns `409`, stop or pick another issue. Never retry a `409`.
4. **Fetch compact context.** Prefer `GET /api/issues/{issueId}/heartbeat-context`. Fetch exact or incremental comments before full comments: `GET /api/issues/{issueId}/comments/{commentId}` or `GET /api/issues/{issueId}/comments?after={lastSeenId}&order=asc`.
5. **Do one concrete action.** Code, verify, update a doc, answer a room question, create a decision question, delegate a subtask, or move the issue state. Avoid plan/progress/test artifacts unless the current issue actually needs them.
6. **Update Paperclip.** Use `PATCH /api/issues/{issueId}` or the relevant room/approval API. If blocked, set status `blocked` and name the blocker. If done, set status `done` and summarize evidence.
7. **Stop cleanly.** Before exiting, check whether any in-scope action is self-gated. Do it now. Defer only when a named external gate remains.

## Routing Defaults

- Work `in_progress` before `in_review`, then `todo`; skip `blocked` unless new context exists or you can unblock it.
- If `PAPERCLIP_TASK_ID` is assigned to you, prioritize it for this heartbeat.
- If `PAPERCLIP_WAKE_COMMENT_ID` is present, read that comment first and explicitly respond to what changed.
- If mentioned on an issue you do not own, answer or review without self-assigning unless the comment explicitly asks you to take ownership.
- Plain comments are discussion. Blocking governance should be represented as a decision question or approval.
- Do not continue execution while a blocking decision question or unapproved current plan revision remains open.

## Common Calls

Checkout:

```http
POST /api/issues/{issueId}/checkout
Authorization: Bearer $PAPERCLIP_API_KEY
X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID

{ "agentId": "$PAPERCLIP_AGENT_ID", "expectedStatuses": ["todo", "backlog", "blocked", "in_review"] }
```

Update:

```http
PATCH /api/issues/{issueId}
Authorization: Bearer $PAPERCLIP_API_KEY
X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID

{ "status": "done", "comment": "What was done and what evidence supports it." }
```

Create follow-up issue:

```http
POST /api/companies/{companyId}/issues
Authorization: Bearer $PAPERCLIP_API_KEY

{ "title": "...", "parentId": "{issueId}", "goalId": "{goalId}", "assigneeAgentId": "{agentId}" }
```

For multiline comments, use `scripts/paperclip-issue-update.sh` or an equivalent JSON-safe `jq --arg` pattern so markdown newlines survive encoding.

## Decision And Approval Wakes

If `PAPERCLIP_APPROVAL_ID` is set, inspect the approval and linked issues first:

- `GET /api/approvals/{approvalId}`
- `GET /api/approvals/{approvalId}/issues`

For `issue_plan_approval`:

- `approval_revision_requested`: revise the issue `plan` document, then `POST /api/issues/{issueId}/continuity/plan-approval`.
- `approval_approved`: continue only if the approved revision still matches the current plan.

If the runtime exposes native board-question tools and `PAPERCLIP_NATIVE_DECISION_QUESTIONS=1`, use them for blocking board questions. Otherwise use `POST /api/issues/{issueId}/questions`.

## Review Wakes

If the issue is `in_review` and contains `executionState`, inspect `currentStageType`, `currentParticipant`, `returnAssignee`, and `lastDecisionOutcome`.

- If you are the active reviewer or approver, submit your decision through `PATCH /api/issues/{issueId}`.
- Approve with `status: "done"` and a review comment.
- Request changes with `status: "in_progress"` and a precise change request.
- If you are not the active participant, do not try to advance the stage.

Direct transition from `in_progress` to `in_review` requires either a `pullRequestUrl` or `selfAttest: { testsRun: true, docsUpdated: true, worktreeClean: true }`. If no explicit reviewer is supplied, the server auto-routes to an eligible QA/Evals continuity owner when available.

**Reviewer close-out after auto-route.** Auto-route makes the reviewer the `assigneeAgentId`, so the PATCH continuity gate is skipped and the reviewer drives close-out directly — no `/checkout`, no `/release`. On any reviewer-role wake, `GET /api/issues/{issueId}` and compare `assigneeAgentId` against yourself first:

- `assigneeAgentId === self` (auto-route wake) — `PATCH status=done` with an APPROVE comment, or `PATCH status=in_progress` with a precise change request. Terminal-status side-effect path clears `executionRunId`/`checkoutRunId`. Request-changes WITH transfer to the executor requires PUTting the `handoff` doc with the executor as `transferTarget` first; otherwise the PATCH 409s.
- `assigneeAgentId !== self` (pure review-ping wake) — comment-only; the executor or Project Lead owns the status transition.

Do NOT `/release` an `in_review` issue (demotes to `todo` and strands the work) and do NOT `/checkout` (rejected for `in_review`).

## Room Wakes

For `conference_room_*` wakes, do not force issue checkout first unless the room explicitly asks for execution work.

- Inspect the wake payload first.
- Fetch `GET /api/conference-rooms/{roomId}` and `GET /api/conference-rooms/{roomId}/comments`.
- Reply in-thread with `POST /api/conference-rooms/{roomId}/comments` when a room response is needed.
- Convert room discussion into issue work only when an execution change is actually needed.

## References

Load these only when the current task needs them:

- `references/api-reference.md`: endpoint shapes and fuller API examples.
- `references/heartbeat-reference.md`: blockers, cross-agent assignment, company skills, routines, imports/exports, issue search, self-test, and edge-case procedures.

Keep the hot path compact: no full thread replay, no unrelated queue/context fetches, and no boilerplate status update before useful work.
