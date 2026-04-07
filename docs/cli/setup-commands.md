---
title: Setup Commands
summary: Onboard, run, doctor, and configure
---

Instance setup and diagnostics commands.

## `agentcompany run`

One-command bootstrap and start:

```sh
pnpm agentcompany run
```

Does:

1. Auto-onboards if config is missing
2. Runs `agentcompany doctor` with repair enabled
3. Starts the server when checks pass

Choose a specific instance:

```sh
pnpm agentcompany run --instance dev
```

## `agentcompany onboard`

Interactive first-time setup:

```sh
pnpm agentcompany onboard
```

If AgentCompany is already configured, rerunning `onboard` keeps the existing config in place. Use `agentcompany configure` to change settings on an existing install.

First prompt:

1. `Quickstart` (recommended): local defaults (embedded database, no LLM provider, local disk storage, default secrets)
2. `Advanced setup`: full interactive configuration

Start immediately after onboarding:

```sh
pnpm agentcompany onboard --run
```

Non-interactive defaults + immediate start (opens browser on server listen):

```sh
pnpm agentcompany onboard --yes
```

On an existing install, `--yes` now preserves the current config and just starts AgentCompany with that setup.

## `agentcompany doctor`

Health checks with optional auto-repair:

```sh
pnpm agentcompany doctor
pnpm agentcompany doctor --repair
```

Validates:

- Server configuration
- Database connectivity
- Secrets adapter configuration
- Storage configuration
- Missing key files

## `agentcompany configure`

Update configuration sections:

```sh
pnpm agentcompany configure --section server
pnpm agentcompany configure --section secrets
pnpm agentcompany configure --section storage
```

## `agentcompany env`

Show resolved environment configuration:

```sh
pnpm agentcompany env
```

## `agentcompany allowed-hostname`

Allow a private hostname for authenticated/private mode:

```sh
pnpm agentcompany allowed-hostname my-tailscale-host
```

## Local Storage Paths

| Data | Default Path |
|------|-------------|
| Config | `~/.agentcompany/instances/default/config.json` |
| Database | `~/.agentcompany/instances/default/db` |
| Logs | `~/.agentcompany/instances/default/logs` |
| Storage | `~/.agentcompany/instances/default/data/storage` |
| Secrets key | `~/.agentcompany/instances/default/secrets/master.key` |

Override with:

```sh
AGENTCOMPANY_HOME=/custom/home AGENTCOMPANY_INSTANCE_ID=dev pnpm agentcompany run
```

Or pass `--data-dir` directly on any command:

```sh
pnpm agentcompany run --data-dir ./tmp/paperclip-dev
pnpm agentcompany doctor --data-dir ./tmp/paperclip-dev
```
