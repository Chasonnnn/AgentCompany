# AgentCompany Port Plan on Current Paperclip

Baseline:

- Upstream Paperclip snapshot: `upstream/master` at commit `26ebe3b0`
- Preserved pre-sync AgentCompany spike: branch `codex/preserve-agentcompany-room-spike`
- Local repo path: `/Users/chason/AgentCompany`

Goal:

Build on current upstream Paperclip instead of the retired `src/` + `desktop-react/` stack, while porting the AgentCompany differentiators into the active `server/` + `ui/` architecture.

Port targets:

1. Conference rooms and structured deliberation
2. Human-in-the-loop governed decisions
3. Repo-aware workspace and local operator flows

Current upstream surfaces to extend:

- Issue discussion and chat substrate:
  - `server/src/routes/issues.ts`
  - `server/src/services/issues.ts`
  - `ui/src/pages/IssueDetail.tsx`
- Human approval and board review:
  - `server/src/services/approvals.ts`
  - `ui/src/pages/Approvals.tsx`
  - `ui/src/pages/ApprovalDetail.tsx`
- Repo and worktree execution model:
  - `server/src/services/workspace-runtime.ts`
  - `server/src/services/execution-workspaces.ts`
  - `ui/src/pages/ProjectWorkspaceDetail.tsx`
  - `ui/src/pages/ExecutionWorkspaceDetail.tsx`
- Inbox and dashboard entry points:
  - `ui/src/pages/Inbox.tsx`
  - `ui/src/pages/Dashboard.tsx`

Recommended port sequence:

1. Recreate fork attribution and repo-local project conventions on top of upstream.
2. Port governed decision semantics first by expressing AgentCompany review and board decisions through the existing approval model.
3. Add conference-room metadata and structured decision records on top of issue threads, instead of reviving the deleted legacy conversation system.
4. Extend project and execution workspace surfaces with AgentCompany repo summaries and local operator affordances.
5. Add inbox and dashboard summaries for pending board-style decisions and room activity.

Non-goals for the first port pass:

- Reintroducing the old `desktop-react` shell
- Reintroducing the retired JSON-RPC `src/server/router.ts` contract
- Forking away from upstream UI patterns before the new features land

Migration note:

The preserved branch contains useful logic and tests, but it was built against a different application structure. Treat it as a donor branch for concepts and code snippets, not as something to merge directly.
