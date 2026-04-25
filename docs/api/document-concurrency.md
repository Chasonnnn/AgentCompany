# Document concurrency

Issue, project, and company documents are revisioned text artifacts. The `PUT /api/issues/:id/documents/:key` endpoint (and its project / company siblings) uses optimistic concurrency keyed on `baseRevisionId`. This page documents the contract so callers can write a correct retry loop and so future code changes preserve the invariants.

The example uses `paperclip/issue-progress.v1` (the `progress` document key) but the same rules apply to every document key handled by `documentService.upsertIssueDocument` / `upsertProjectDocument` / `upsertCompanyDocument`.

## Contract

- **Create:** omit `baseRevisionId`. The server creates the document at revision 1.
- **Update:** include the current `latestRevisionId` as `baseRevisionId`. The server compares it to the row-locked latest revision and rejects with `409` if they differ.

A missing `baseRevisionId` on a key that already exists is also a 409 — the server treats "didn't read first" the same as "read a stale revision."

## 409 response shape

A stale or missing `baseRevisionId` returns:

```json
{
  "error": "Document was updated by someone else",
  "details": { "currentRevisionId": "<uuid>" }
}
```

(or `"Document update requires baseRevisionId"` for the missing-base case — the `details.currentRevisionId` field is set in both branches.)

The `details.currentRevisionId` field is the value the next PUT must use as `baseRevisionId`. Callers can splice it directly into a retry without an extra `GET`.

## Recommended retry pattern

```ts
async function putWithRetry(issueId: string, key: string, body: string, baseRevisionId: string | null) {
  const attempt = (base: string | null) =>
    fetch(`/api/issues/${issueId}/documents/${key}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Paperclip-Run-Id": runId },
      body: JSON.stringify({ format: "markdown", body, ...(base ? { baseRevisionId: base } : {}) }),
    });

  let res = await attempt(baseRevisionId);
  if (res.status === 409) {
    const { details } = await res.json();
    res = await attempt(details.currentRevisionId); // single retry against the winner's revision
  }
  return res;
}
```

Two notes on the retry:

1. **Single retry is enough for honest writers.** The lock-and-compare is atomic (see "Mechanism" below), so the loser only has to re-read once.
2. **Don't re-PUT a stale body verbatim.** If the new revision changed something you care about, you may need to splice your delta into the new body. For YAML-frontmatter docs (`progress`, `handoff`, `branch-charter`, `review-findings`), the schema validators at `packages/shared/src/validators/operating-model.ts` will reject malformed bodies with a 422 before any concurrency check runs.

## One-writer-at-a-time invariant

Two layers prevent races in practice:

1. **Checkout gate (`checkoutRunId`).** Issue mutations require the active `checkoutRunId`, so two concurrent agents won't both be PUT-ing on the same issue's docs in the first place. See `assertAgentIssueMutationAllowed` in `server/src/routes/issues.ts`.
2. **`baseRevisionId` check.** Defense in depth for the cases the checkout gate doesn't cover: scaffold writes during issue creation, repeat heartbeats from the same agent racing themselves, board-actor writes alongside an active checkout, and project / company documents (no per-row checkout).

Treat the checkout as the primary guard and `baseRevisionId` as the safety net. The 409 path is not an "error" — it's a normal control-flow signal that another writer landed first.

## Mechanism

Inside `documentService.upsertIssueDocument` (`server/src/services/documents.ts:394-566`):

1. The whole upsert runs in a `db.transaction`.
2. If the document exists, the row is locked: `SELECT ... FOR UPDATE` on `documents.id` (`server/src/services/documents.ts:282-286`).
3. The locked row is re-fetched; `input.baseRevisionId` is compared to the locked `latestRevisionId` (`server/src/services/documents.ts:429-437`).
4. On match, a new `document_revisions` row is inserted (with `revisionNumber = latest + 1`) and `documents.latestRevisionId` / `latestRevisionNumber` are updated atomically.
5. On mismatch, the service throws `conflict(message, { currentRevisionId })` from `server/src/errors.ts:28-30`. The middleware at `server/src/middleware/error-handler.ts:52-56` renders it as the JSON body shown above.

The `(documentId, revisionNumber)` unique index on `document_revisions` (see `packages/db/src/schema/document_revisions.ts`) is the secondary integrity gate: even if the row lock were bypassed, two concurrent inserts at the same revision number would fail at the index.

The route handler is at `server/src/routes/issues.ts:2269` and dispatches into the service after key parsing, kind-specific validation (e.g., `parseIssueProgressMarkdown` for `progress`), and the continuity-owner gate.

## Test coverage

`server/src/__tests__/documents-service.test.ts` exercises the concurrent-write path for issue, project, and company documents. The shared helper `expectSingleWinnerOnConcurrentUpdate` holds an external `FOR UPDATE` lock on the row, fires two concurrent updates with the same `baseRevisionId`, releases the lock, and asserts:

- exactly one update fulfills, exactly one rejects with `status: 409, message: "Document was updated by someone else"`
- `details.currentRevisionId` on the rejection equals the winning update's new revision id (the value a retry would PUT as its next `baseRevisionId`)
- the document ends with exactly two revisions (initial + winner)

This is the canonical test for the contract documented here. If you change the locking shape, the response body, or the retry hint, update both this doc and the helper.
