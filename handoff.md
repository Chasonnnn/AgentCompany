# Handoff Snapshot

Last updated: 2026-04-08

This file is a point-in-time snapshot of the repo state when the migration work was being handed off on 2026-04-08. Treat any "current local state" notes below as historical context for that handoff, not as a guarantee about the branch after later commits.

## Active Repo

- Path: `/Users/chason/paperclip`
- Branch: `main`
- Current HEAD: `fc50a131`
- Upstream Paperclip HEAD checked locally: `642188f9`
- Upstream status: already current as of this handoff; there were no newer maintainer commits to merge when this was prepared.

## Goal

Use this repo as the primary Paperclip fork and build new AgentCompany-style features directly on top of the existing `server/` + `ui/` stack.

Do not resume the retired `src/` + `desktop-react/` architecture from the old AgentCompany experiment.

## Snapshot State At Capture

There are uncommitted local changes in this repo. They fall into two groups:

### 1. CLI / adapter auth fixes

These were migrated from the parallel `/Users/chason/AgentCompany` workspace:

- `cli/package.json`
- `cli/src/__tests__/package-deps.test.ts`
- `packages/adapters/codex-local/src/server/test.ts`
- `packages/adapters/claude-local/src/server/test.ts`
- `server/src/__tests__/codex-local-adapter-environment.test.ts`
- `server/src/__tests__/claude-local-adapter-environment.test.ts`
- `pnpm-lock.yaml`

Purpose:

- fix local source-checkout CLI packaging gaps
- harden Codex / Claude auth detection using native CLI auth status

### 2. Conference room migration slice

These are the first product-level changes on top of the Paperclip fork:

- `packages/shared/src/types/approval.ts`
- `packages/shared/src/validators/approval.ts`
- `packages/shared/src/board-approval.test.ts`
- `ui/src/lib/board-room.ts`
- `ui/src/lib/board-room.test.ts`
- `ui/src/components/ApprovalPayload.tsx`
- `ui/src/components/ApprovalPayload.test.tsx`
- `ui/src/components/BoardRoomPanel.tsx`
- `ui/src/components/BoardRoomPanel.test.tsx`
- `ui/src/pages/IssueDetail.tsx`
- `server/src/__tests__/plugin-host-services-board-room.test.ts`

Purpose:

- keep Paperclip’s existing `request_board_approval` approval model
- evolve the user-facing board room into an issue-scoped conference room
- add conference metadata:
  - `roomTitle`
  - `agenda`
  - `participantAgentIds`
- keep the existing agent host method `issues.requestBoardApproval`, but normalize the richer payload through the shared validator

## What Is Already Built Here

### Conference room on top of Paperclip approvals

This is implemented locally but not committed yet.

Current behavior:

- issue detail now uses **Conference Room** wording instead of only **Board Room**
- the issue action button opens the conference-room composer
- the structured request supports:
  - title
  - summary
  - conference title
  - agenda
  - recommended action
  - next action on approval
  - risks
  - proposed comment
  - invited participant agents
- approvals still use `request_board_approval`
- inline discussion is still approval-comment-backed
- agent-created board requests continue to work through the existing SDK/host path

This is intentionally not a brand-new room subsystem yet. It is the first migration step that stays aligned with current Paperclip architecture.

## What Is Not Yet Migrated

These were part of the earlier AgentCompany spike and are still not ported into this Paperclip fork:

### 1. Standalone room / conversation system

Not ported.

The old experimental implementation lived in `/Users/chason/AgentCompany` on branch `codex/preserve-agentcompany-room-spike` at commit `c15336a7`.

That branch had:

- `room` conversations
- seeded default rooms
- structured `decisions.jsonl`
- room decision resolution flows
- old router/read-model support

Those ideas should be treated as a donor branch, not merged directly.

### 2. Repo snapshot / repo workspace model

Not ported.

The old spike had a repo read model with:

- branch
- dirty state
- changed files
- active worktrees
- linked projects

That old implementation was in:

- `/Users/chason/AgentCompany/src/runtime/repo_snapshot.ts`
- `/Users/chason/AgentCompany/src/schemas/repo_snapshot.ts`

### 3. Richer governance tiers

Not ported.

We do **not** yet have the broader `auto | review | board` tiering from the old AgentCompany direction. Right now the fork only has the approval-backed board / conference path.

## Recommended Next Step

The next sensible feature is:

1. keep building on the current approval-backed conference room
2. add repo-aware context into the issue-level conference room
3. surface linked workspace / worktree / changed-file context in the conference request and discussion UI

That is a better next step than reviving the old standalone room system.

## Donor Branch / Reference Material

If you need to inspect the pre-reroot AgentCompany spike for ideas:

- Repo: `/Users/chason/AgentCompany`
- Branch: `codex/preserve-agentcompany-room-spike`
- Commit: `c15336a7`

Useful old files there:

- `/Users/chason/AgentCompany/src/schemas/conversation.ts`
- `/Users/chason/AgentCompany/src/schemas/room_decision.ts`
- `/Users/chason/AgentCompany/src/conversations/room_decisions.ts`
- `/Users/chason/AgentCompany/src/runtime/repo_snapshot.ts`
- `/Users/chason/AgentCompany/src/index/sqlite.ts`

Do not port the old shell wholesale. Port concepts only.

## Commands To Resume

From `/Users/chason/paperclip`:

### Install

```bash
pnpm install --no-frozen-lockfile
```

### Run targeted tests for the current local work

```bash
pnpm vitest run \
  packages/shared/src/board-approval.test.ts \
  ui/src/lib/board-room.test.ts \
  ui/src/components/ApprovalPayload.test.tsx \
  ui/src/components/BoardRoomPanel.test.tsx \
  server/src/__tests__/plugin-host-services-board-room.test.ts \
  cli/src/__tests__/package-deps.test.ts \
  server/src/__tests__/codex-local-adapter-environment.test.ts \
  server/src/__tests__/claude-local-adapter-environment.test.ts
```

### Build

```bash
pnpm build
```

### Source-checkout onboarding

Use this instead of calling `node ./cli/dist/index.js onboard` directly:

```bash
pnpm --filter paperclipai dev onboard --yes
```

Optional isolated data dir:

```bash
pnpm --filter paperclipai dev onboard --yes -d "$HOME/.paperclip"
```

## Validation Status

Verified before this handoff:

- `pnpm vitest run packages/shared/src/board-approval.test.ts ui/src/lib/board-room.test.ts ui/src/components/ApprovalPayload.test.tsx ui/src/components/BoardRoomPanel.test.tsx server/src/__tests__/plugin-host-services-board-room.test.ts`
- `pnpm build`

Also previously verified in this repo:

- `pnpm vitest run cli/src/__tests__/package-deps.test.ts server/src/__tests__/codex-local-adapter-environment.test.ts server/src/__tests__/claude-local-adapter-environment.test.ts`

Not rerun in this handoff:

- full `pnpm test:run`

## Git Notes

- `origin/main` currently matches committed `main` at `fc50a131`
- the local changes described above are **not committed**
- if you want to checkpoint cleanly, it would be reasonable to commit in two groups:
  - auth / CLI fixes
  - conference room migration slice

## Short Resume Summary

If you are resuming cold:

- work in `/Users/chason/paperclip`
- ignore `/Users/chason/AgentCompany` except as a donor branch for old ideas
- keep building on current Paperclip UI/UX
- preserve the approval-backed conference-room approach
- next likely feature is repo-aware context inside the issue conference room
