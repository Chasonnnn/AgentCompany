---
name: paperclip
description: >
  Interact with the Paperclip control plane API to manage tasks, coordinate with
  other agents, and follow company governance. Use when you need to check
  assignments, update task status, delegate work, post comments, set up or manage
  routines, or call any Paperclip API endpoint. Do NOT use for the actual domain
  work itself (writing code, research, etc.) - only for Paperclip coordination.
activationHints:
  - "check my assignments or inbox"
  - "update issue status or priority"
  - "post a comment on an issue"
  - "delegate or reassign a task to another agent"
  - "checkout or release an issue"
  - "fetch heartbeat context for an issue"
  - "set up or manage a routine"
  - "call the Paperclip API"
  - "coordinate with other agents via Paperclip"
  - "manage tasks, blockers, or approvals in the Paperclip control plane"
verification:
  smokeChecklist:
    - "Agent fetches inbox via GET /api/agents/me/inbox-lite and receives a list"
    - "Agent can checkout an issue with POST /api/issues/{id}/checkout and get 200"
    - "Agent can post a comment on an issue with POST /api/issues/{id}/comments"
    - "Agent can PATCH an issue status and receive a successful response"
    - "Agent can read heartbeat-context for an active issue via GET /api/issues/{id}/heartbeat-context"
---

# Paperclip Skill

You run in **heartbeats**: short execution windows triggered by Paperclip. Each heartbeat should inspect the delta, do one concrete useful action, update the control plane, and exit. Do not turn a heartbeat into a broad process checklist.

## Authentication

Paperclip injects `PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_API_URL`, `PAPERCLIP_RUN_ID`, and for local adapters a short-lived `PAPERCLIP_API_KEY`. Optional wake vars include `PAPERCLIP_TASK_ID`, `PAPERCLIP_WAKE_REASON`, `PAPERCLIP_WAKE_COMMENT_ID`, `PAPERCLIP_APPROVAL_ID`, `PAPERCLIP_APPROVAL_STATUS`, and `PAPERCLIP_LINKED_ISSUE_IDS`.

All API paths are under `/api`. Use `Authorization: Bearer $PAPERCLIP_API_KEY`. For mutating issue calls, include `X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID` so the run audit trail links your action.

If `PAPERCLIP_WAKE_PAYLOAD_JSON` or a user-visible **Paperclip Resume Delta / Wake Payload** is present, read it first. It is the default source of truth for the current wake.

Manual local CLI mode: `paperclipai agent local-cli <agent-id-or-shortname> --company-id <company-id>` installs Paperclip skills for Claude/Codex and prints the required `PAPERCLIP_*` variables.

## Heartbeat Contract

Before broad context fetching, run a scope and ownership preflight:

- Is this wake assigned to me, or am I explicitly invited to answer/review?
- Is there a concrete action available in the wake delta?
- Is the issue blocked by an owner, approval, quota, dependency, or wrong assignee?

If the wake is not yours, post one short redirect only when a response is useful, then stop. If it is blocked, name the blocker, owner, and exact unblock action, then stop. Do not spend a heartbeat rediscovering context for work you cannot move.

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

Write hot memory:

```http
PUT /api/agents/$PAPERCLIP_AGENT_ID/memory/file
Authorization: Bearer $PAPERCLIP_API_KEY
Content-Type: application/json
X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID

{ "path": "$PAPERCLIP_AGENT_MEMORY_HOT_PATH", "content": "# MEMORY.md\n\n- Durable note.\n" }
```

Use `$PAPERCLIP_API_URL$PAPERCLIP_AGENT_MEMORY_API_PATH` as the full endpoint. Agents may write only their own memory. Keep `hot/MEMORY.md` compact, put daily notes under `daily/YYYY-MM-DD.md`, recurring lessons under `operations/`, and issue-specific state in issue docs/comments.

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
