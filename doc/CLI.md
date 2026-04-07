# CLI Reference

AgentCompany CLI now supports both:

- instance setup/diagnostics (`onboard`, `doctor`, `configure`, `env`, `allowed-hostname`)
- control-plane client operations (issues, approvals, agents, activity, dashboard)

## Base Usage

Use repo script in development:

```sh
pnpm agentcompany --help
```

First-time local bootstrap + run:

```sh
pnpm agentcompany run
```

Choose local instance:

```sh
pnpm agentcompany run --instance dev
```

## Deployment Modes

Mode taxonomy and design intent are documented in `doc/DEPLOYMENT-MODES.md`.

Current CLI behavior:

- `agentcompany onboard` and `agentcompany configure --section server` set deployment mode in config
- runtime can override mode with `AGENTCOMPANY_DEPLOYMENT_MODE`
- `agentcompany run` and `agentcompany doctor` do not yet expose a direct `--mode` flag

Target behavior (planned) is documented in `doc/DEPLOYMENT-MODES.md` section 5.

Allow an authenticated/private hostname (for example custom Tailscale DNS):

```sh
pnpm agentcompany allowed-hostname dotta-macbook-pro
```

All client commands support:

- `--data-dir <path>`
- `--api-base <url>`
- `--api-key <token>`
- `--context <path>`
- `--profile <name>`
- `--json`

Company-scoped commands also support `--company-id <id>`.

Use `--data-dir` on any CLI command to isolate all default local state (config/context/db/logs/storage/secrets) away from `~/.agentcompany`:

```sh
pnpm agentcompany run --data-dir ./tmp/paperclip-dev
pnpm agentcompany issue list --data-dir ./tmp/paperclip-dev
```

## Context Profiles

Store local defaults in `~/.agentcompany/context.json`:

```sh
pnpm agentcompany context set --api-base http://localhost:3100 --company-id <company-id>
pnpm agentcompany context show
pnpm agentcompany context list
pnpm agentcompany context use default
```

To avoid storing secrets in context, set `apiKeyEnvVarName` and keep the key in env:

```sh
pnpm agentcompany context set --api-key-env-var-name AGENTCOMPANY_API_KEY
export AGENTCOMPANY_API_KEY=...
```

## Company Commands

```sh
pnpm agentcompany company list
pnpm agentcompany company get <company-id>
pnpm agentcompany company delete <company-id-or-prefix> --yes --confirm <same-id-or-prefix>
```

Examples:

```sh
pnpm agentcompany company delete PAP --yes --confirm PAP
pnpm agentcompany company delete 5cbe79ee-acb3-4597-896e-7662742593cd --yes --confirm 5cbe79ee-acb3-4597-896e-7662742593cd
```

Notes:

- Deletion is server-gated by `AGENTCOMPANY_ENABLE_COMPANY_DELETION`.
- With agent authentication, company deletion is company-scoped. Use the current company ID/prefix (for example via `--company-id` or `AGENTCOMPANY_COMPANY_ID`), not another company.

## Issue Commands

```sh
pnpm agentcompany issue list --company-id <company-id> [--status todo,in_progress] [--assignee-agent-id <agent-id>] [--match text]
pnpm agentcompany issue get <issue-id-or-identifier>
pnpm agentcompany issue create --company-id <company-id> --title "..." [--description "..."] [--status todo] [--priority high]
pnpm agentcompany issue update <issue-id> [--status in_progress] [--comment "..."]
pnpm agentcompany issue comment <issue-id> --body "..." [--reopen]
pnpm agentcompany issue checkout <issue-id> --agent-id <agent-id> [--expected-statuses todo,backlog,blocked]
pnpm agentcompany issue release <issue-id>
```

## Agent Commands

```sh
pnpm agentcompany agent list --company-id <company-id>
pnpm agentcompany agent get <agent-id>
pnpm agentcompany agent local-cli <agent-id-or-shortname> --company-id <company-id>
```

`agent local-cli` is the quickest way to run local Claude/Codex manually as a AgentCompany agent:

- creates a new long-lived agent API key
- installs missing AgentCompany skills into `~/.codex/skills` and `~/.claude/skills`
- prints `export ...` lines for `AGENTCOMPANY_API_URL`, `AGENTCOMPANY_COMPANY_ID`, `AGENTCOMPANY_AGENT_ID`, and `AGENTCOMPANY_API_KEY`

Example for shortname-based local setup:

```sh
pnpm agentcompany agent local-cli codexcoder --company-id <company-id>
pnpm agentcompany agent local-cli claudecoder --company-id <company-id>
```

## Approval Commands

```sh
pnpm agentcompany approval list --company-id <company-id> [--status pending]
pnpm agentcompany approval get <approval-id>
pnpm agentcompany approval create --company-id <company-id> --type hire_agent --payload '{"name":"..."}' [--issue-ids <id1,id2>]
pnpm agentcompany approval approve <approval-id> [--decision-note "..."]
pnpm agentcompany approval reject <approval-id> [--decision-note "..."]
pnpm agentcompany approval request-revision <approval-id> [--decision-note "..."]
pnpm agentcompany approval resubmit <approval-id> [--payload '{"...":"..."}']
pnpm agentcompany approval comment <approval-id> --body "..."
```

## Activity Commands

```sh
pnpm agentcompany activity list --company-id <company-id> [--agent-id <agent-id>] [--entity-type issue] [--entity-id <id>]
```

## Dashboard Commands

```sh
pnpm agentcompany dashboard get --company-id <company-id>
```

## Heartbeat Command

`heartbeat run` now also supports context/api-key options and uses the shared client stack:

```sh
pnpm agentcompany heartbeat run --agent-id <agent-id> [--api-base http://localhost:3100] [--api-key <token>]
```

## Local Storage Defaults

Default local instance root is `~/.agentcompany/instances/default`:

- config: `~/.agentcompany/instances/default/config.json`
- embedded db: `~/.agentcompany/instances/default/db`
- logs: `~/.agentcompany/instances/default/logs`
- storage: `~/.agentcompany/instances/default/data/storage`
- secrets key: `~/.agentcompany/instances/default/secrets/master.key`

Override base home or instance with env vars:

```sh
AGENTCOMPANY_HOME=/custom/home AGENTCOMPANY_INSTANCE_ID=dev pnpm agentcompany run
```

## Storage Configuration

Configure storage provider and settings:

```sh
pnpm agentcompany configure --section storage
```

Supported providers:

- `local_disk` (default; local single-user installs)
- `s3` (S3-compatible object storage)
