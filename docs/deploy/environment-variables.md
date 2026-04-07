---
title: Environment Variables
summary: Full environment variable reference
---

All environment variables that AgentCompany uses for server configuration.

## Server Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3100` | Server port |
| `HOST` | `127.0.0.1` | Server host binding |
| `DATABASE_URL` | (embedded) | PostgreSQL connection string |
| `AGENTCOMPANY_HOME` | `~/.agentcompany` | Base directory for all AgentCompany data |
| `AGENTCOMPANY_INSTANCE_ID` | `default` | Instance identifier (for multiple local instances) |
| `AGENTCOMPANY_DEPLOYMENT_MODE` | `local_trusted` | Runtime mode override |

## Secrets

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENTCOMPANY_SECRETS_MASTER_KEY` | (from file) | 32-byte encryption key (base64/hex/raw) |
| `AGENTCOMPANY_SECRETS_MASTER_KEY_FILE` | `~/.agentcompany/.../secrets/master.key` | Path to key file |
| `AGENTCOMPANY_SECRETS_STRICT_MODE` | `false` | Require secret refs for sensitive env vars |

## Agent Runtime (Injected into agent processes)

These are set automatically by the server when invoking agents:

| Variable | Description |
|----------|-------------|
| `AGENTCOMPANY_AGENT_ID` | Agent's unique ID |
| `AGENTCOMPANY_COMPANY_ID` | Company ID |
| `AGENTCOMPANY_API_URL` | AgentCompany API base URL |
| `AGENTCOMPANY_API_KEY` | Short-lived JWT for API auth |
| `AGENTCOMPANY_RUN_ID` | Current heartbeat run ID |
| `AGENTCOMPANY_TASK_ID` | Issue that triggered this wake |
| `AGENTCOMPANY_WAKE_REASON` | Wake trigger reason |
| `AGENTCOMPANY_WAKE_COMMENT_ID` | Comment that triggered this wake |
| `AGENTCOMPANY_APPROVAL_ID` | Resolved approval ID |
| `AGENTCOMPANY_APPROVAL_STATUS` | Approval decision |
| `AGENTCOMPANY_LINKED_ISSUE_IDS` | Comma-separated linked issue IDs |

## LLM Provider Keys (for adapters)

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key (for Claude Local adapter) |
| `OPENAI_API_KEY` | OpenAI API key (for Codex Local adapter) |
