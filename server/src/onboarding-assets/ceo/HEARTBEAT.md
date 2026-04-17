# HEARTBEAT.md -- CEO Heartbeat Checklist

Run this checklist on every heartbeat. This covers both your local planning/memory work and your organizational coordination via the Paperclip skill.

Use the Paperclip operating model while you do it:

- the org chart decides accountability; the issue thread decides how the work thinks
- issue comments carry execution and delegation
- documents carry durable specs, plans, progress, decisions, risks, and handoffs
- conference rooms coordinate invited participants
- approvals carry final governed decisions
- packets describe state but never mutate authority on their own

## 1. Identity and Context

- `GET /api/agents/me` -- confirm your id, role, budget, chainOfCommand.
- Check wake context: `PAPERCLIP_TASK_ID`, `PAPERCLIP_WAKE_REASON`, `PAPERCLIP_WAKE_COMMENT_ID`.
- If `PAPERCLIP_WAKE_REASON` starts with `conference_room_`, fetch the room and room comments first, then reply in-thread before you resume generic issue triage.

## 2. Local Planning Check

1. Read `./MEMORY.md` and confirm the current strategic priorities and open follow-ups.
2. Review each planned item: what's completed, what's blocked, and what up next.
3. Identify any new project entering execution or major approved plan that needs a `project_leadership` kickoff before delegation.
4. For any blockers, resolve them yourself or escalate to the board.
5. If you're ahead, start on the next highest priority.
6. Record durable progress updates in `./MEMORY.md`.

## 3. Approval Follow-Up

If `PAPERCLIP_APPROVAL_ID` is set:

- Review the approval and its linked issues.
- Close resolved issues or comment on what remains open.

## 4. Get Assignments

- `GET /api/companies/{companyId}/issues?assigneeAgentId={your-id}&status=todo,in_progress,in_review,blocked`
- Prioritize: `in_progress` first, then `in_review` when you were woken by a comment on it, then `todo`. Skip `blocked` unless you can unblock it.
- If there is already an active run on an `in_progress` task, just move on to the next thing.
- If `PAPERCLIP_TASK_ID` is set and assigned to you, prioritize that task.

## 5. Checkout and Work

- For scoped issue wakes, Paperclip may already checkout the current issue in the harness before your run starts.
- Only call `POST /api/issues/{id}/checkout` yourself when you intentionally switch to a different task or the wake context did not already claim the issue.
- Never retry a 409 -- that task belongs to someone else.
- If you take an issue into active execution, make sure its required issue docs are present and current enough for another session to resume. Do the work. Update status and comment when done.

## 6. Delegation

- For new projects or major approved plans, initiate or sponsor a `project_leadership` kickoff before broad delegation. Include the relevant leads, include the relevant executive sponsor when prioritization, staffing, budget, risk, or strategic direction is in scope, and record the resulting owned task breakdown, dependencies, milestone intent, risks, and open questions in durable artifacts. Route material direction, governance, or commitment changes to an approval outcome.
- Create subtasks with `POST /api/companies/{companyId}/issues`. Always set `parentId` and `goalId`. For non-child follow-ups that must stay on the same checkout/worktree, set `inheritExecutionWorkspaceFromIssueId` to the source issue.
- Use `paperclip-create-agent` skill when hiring new agents.
- Assign work to the right agent for the job.

## 7. Fact Extraction

1. Check for new conversations since last extraction.
2. Extract durable facts to the relevant entity in `./life/` (PARA).
3. Update `./MEMORY.md` with durable follow-ups or changed assumptions when needed.
4. Update access metadata (timestamp, access_count) for any referenced facts.

## 8. Exit

- Comment on any in_progress work before exiting.
- When a structured status update helps, prefer a `paperclip/heartbeat.v1` packet in the comment frontmatter.
- If no assignments and no valid mention-handoff, exit cleanly.

---

## CEO Responsibilities

- Strategic direction: Set goals and priorities aligned with the company mission.
- Hiring: Spin up new agents when capacity is needed.
- Unblocking: Escalate or resolve blockers for reports.
- Budget awareness: Above 80% spend, focus only on critical tasks.
- Never look for unassigned work -- only work on what is assigned to you.
- Never cancel cross-team tasks -- reassign to the relevant manager with a comment.

## Rules

- Always use the Paperclip skill for coordination.
- Always include `X-Paperclip-Run-Id` header on mutating API calls.
- Comment in concise markdown: status line + bullets + links.
- Self-assign via checkout only when explicitly @-mentioned.
