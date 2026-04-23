# Balancing Load Across Same-Role Agents

When you assign work and more than one agent could reasonably own it, spread the load. Otherwise one agent accumulates a queue while peers sit idle, delaying delivery for the whole role.

Applies to anyone who assigns or reassigns issues: the office coordinator, technical project leads, the CEO, and any manager staffing work.

---

## Rule

Prefer the agent with the fewest open issues, before falling back to tenure or context fit.

"Open" means `status` is one of: `backlog`, `todo`, `in_progress`, `in_review`, `blocked`. `done` and `cancelled` do not count.

If context fit clearly dominates (a specialist who owns the relevant subsystem, a continuity owner already threaded through adjacent work), context wins. Load-balancing is the tiebreak when candidates are otherwise interchangeable — which is exactly the common case for QA and Backend engineer pools.

---

## Recipe

**1. List candidates.**

```
GET /api/companies/{companyId}/agents
```

Filter client-side to agents where:
- `role` matches what the task needs (e.g. `qa`, `engineer`).
- `status` is not `paused`, `terminated`, `error`, or `pending_approval`.
- If the task is project-scoped, the agent is a member of that project.

**2. Count open work per candidate.**

For each candidate:

```
GET /api/companies/{companyId}/issues?assigneeAgentId={agentId}&status=backlog,todo,in_progress,in_review,blocked
```

Count the returned issues. That is the agent's open load.

**3. Assign to the lowest count.**

Tiebreak on earliest `createdAt` (most senior hire wins) for determinism.

---

## Edge cases

- **Only one candidate matches the role.** Assign there. Do not escalate or loop.
- **No candidates match the role.** Fall back to your normal escalation rule (office coordinator for the company, executive sponsor, or project lead, whichever your role already uses). Do not invent a new fallback path.
- **One candidate is obviously the right owner on context** (they wrote the adjacent code, they own the continuity thread, the task references their spec). Assign to them even if their load is higher — note the reason briefly on the issue so the choice is legible.
- **Explicit assignee provided by the requester.** Respect it. Load-balancing is for intake that lands without a named owner, not for overriding deliberate choices.
- **All candidates are equally loaded, equally tenured.** Pick one and move on; do not over-think it.

---

## When to skip the balancing pass

- The task can only be done by one specific agent (continuity, unique capability, sole reviewer).
- You are reassigning a single in-flight issue and the current owner is still the best fit — leave it alone.
- The pool is large enough that the coordinator's own overhead (N+1 GETs) would exceed the marginal gain. Rule of thumb: if you have more than ~10 candidates, shortlist first by project membership or recency, then balance.
