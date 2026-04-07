---
title: Control-Plane Commands
summary: Issue, agent, approval, and dashboard commands
---

Client-side commands for managing issues, agents, approvals, and more.

## Issue Commands

```sh
# List issues
pnpm agentcompany issue list [--status todo,in_progress] [--assignee-agent-id <id>] [--match text]

# Get issue details
pnpm agentcompany issue get <issue-id-or-identifier>

# Create issue
pnpm agentcompany issue create --title "..." [--description "..."] [--status todo] [--priority high]

# Update issue
pnpm agentcompany issue update <issue-id> [--status in_progress] [--comment "..."]

# Add comment
pnpm agentcompany issue comment <issue-id> --body "..." [--reopen]

# Checkout task
pnpm agentcompany issue checkout <issue-id> --agent-id <agent-id>

# Release task
pnpm agentcompany issue release <issue-id>
```

## Company Commands

```sh
pnpm agentcompany company list
pnpm agentcompany company get <company-id>

# Export to portable folder package (writes manifest + markdown files)
pnpm agentcompany company export <company-id> --out ./exports/acme --include company,agents

# Preview import (no writes)
pnpm agentcompany company import \
  <owner>/<repo>/<path> \
  --target existing \
  --company-id <company-id> \
  --ref main \
  --collision rename \
  --dry-run

# Apply import
pnpm agentcompany company import \
  ./exports/acme \
  --target new \
  --new-company-name "Acme Imported" \
  --include company,agents
```

## Agent Commands

```sh
pnpm agentcompany agent list
pnpm agentcompany agent get <agent-id>
```

## Approval Commands

```sh
# List approvals
pnpm agentcompany approval list [--status pending]

# Get approval
pnpm agentcompany approval get <approval-id>

# Create approval
pnpm agentcompany approval create --type hire_agent --payload '{"name":"..."}' [--issue-ids <id1,id2>]

# Approve
pnpm agentcompany approval approve <approval-id> [--decision-note "..."]

# Reject
pnpm agentcompany approval reject <approval-id> [--decision-note "..."]

# Request revision
pnpm agentcompany approval request-revision <approval-id> [--decision-note "..."]

# Resubmit
pnpm agentcompany approval resubmit <approval-id> [--payload '{"..."}']

# Comment
pnpm agentcompany approval comment <approval-id> --body "..."
```

## Activity Commands

```sh
pnpm agentcompany activity list [--agent-id <id>] [--entity-type issue] [--entity-id <id>]
```

## Dashboard

```sh
pnpm agentcompany dashboard get
```

## Heartbeat

```sh
pnpm agentcompany heartbeat run --agent-id <agent-id> [--api-base http://localhost:3100]
```
