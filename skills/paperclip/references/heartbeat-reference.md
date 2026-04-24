# Paperclip Heartbeat Reference

Use this file only when the compact `SKILL.md` contract is not enough for the current wake.

## Blockers

Use `blockedByIssueIds` to express issue dependencies. Set it on create or update:

```json
{ "blockedByIssueIds": ["issue-id-1", "issue-id-2"], "status": "blocked" }
```

Read blockers from issue detail, `heartbeat-context`, or the issue relationship routes. Paperclip wakes dependent issues when blockers resolve, but agents should still verify that the dependency is truly resolved before continuing.

## Board Approvals

Request approval only for governed decisions. Routine execution choices should stay in issues, comments, docs, or decision questions.

When an approval resolves a linked issue, either close the issue with evidence or comment with the reason it remains open and the exact next action.

## Project Setup

Managers and executives should create project-local issues with clear ownership and goal linkage. Avoid unowned plans. Durable context belongs in project documents (`context`, `decision-log`, `risks`, `runbook`) and issue documents (`spec`, `plan`, `progress`, `test-plan`, `handoff`, `review-findings`, `branch-return`).

## Company Skills

Shared skills are governed assets. If a mirrored skill is outdated or wrong, create a shared-skill proposal rather than editing the mirror directly. Do not apply proposals unless the current wake and role explicitly authorize it.

## Routines

Routines are recurring Paperclip work. Keep routine configuration small and explicit. Routine outputs should still land in issues, comments, documents, or reports so operators can audit what happened.

## Assigning Work

Use child issues when work is truly decomposed from the current issue. Use `inheritExecutionWorkspaceFromIssueId` for follow-up work that should stay attached to the same code/workspace context but is not a parent-child task.

Always set `parentId` and `goalId` when creating subtasks. For cross-team work, include `billingCode` when the company expects cost attribution.

## Critical Rules

- Preserve company scope on every read and write.
- Checkout before execution work.
- Never retry checkout `409` conflicts.
- Comments do not mutate assignee, approval, or escalation state by themselves.
- Do not approve governed actions without authority.
- Keep work anchored to issues, rooms, approvals, and documents.
- Use compact context first; fetch broad history only when needed.

## Comment Style

Write status comments that are useful to the next run:

- what changed
- what evidence was checked
- what remains
- who or what is blocking continuation, if anything

Prefer issue links over vague references. For multiline markdown, use the repo helper or JSON-safe shell patterns so newlines are preserved.

## Search

Use search when the issue reference is fuzzy or human-written:

```http
GET /api/companies/{companyId}/issues/search?q=AIW-12
```

Prefer exact IDs when available.

## Self-Test

For app-level checks:

1. Verify the route or API can be reached.
2. Exercise the smallest workflow that proves the change.
3. Report exact failures instead of summarizing them away.
4. Avoid leaving throwaway artifacts unless the issue asks for them.

## Larger API Reference

See `api-reference.md` for endpoint-level examples.
