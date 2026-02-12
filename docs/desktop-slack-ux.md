# Desktop Slack-Like UX v1

This document defines the desktop-first Slack-like information architecture used by `desktop-ui`.

## Layout

The shell is split into four zones:

1. Project rail (far-left): workspace home, project switch, add-project, settings.
2. Context sidebar: Home, Channels, DMs, Activities, Resources.
3. Content pane: timeline/cards/composer.
4. Details pane: participant list and agent profile entry points.

## Scope Model

- Workspace scope:
  - Home conversation (`conv_workspace_home`)
  - Workspace DMs
  - Cross-project activities/resources
- Project scope:
  - Home conversation (`conv_<project>_home`)
  - `#executive-meeting`
  - One auto-generated department channel per team
  - Project DMs
  - Project activities/resources

## Default Assistants

- Global manager agent: `agent_global_manager`
- Per-project secretary: `agent_secretary_<project_id>`

Both are provisioned idempotently when defaults are reconciled.

## Conversation Storage

- Project conversation metadata:
  - `work/projects/<project_id>/conversations/<conversation_id>/conversation.yaml`
- Project messages:
  - `work/projects/<project_id>/conversations/<conversation_id>/messages.jsonl`
- Workspace home:
  - `inbox/workspace_home/conversation.yaml`
  - `inbox/workspace_home/messages.jsonl`

## Visibility Defaults

- Home / Executive meeting: `org`
- Department channels: `team`
- DMs: `private_agent`

## Context-Cycle Telemetry

Run-level `context_cycles` is populated from provider-aware signals.

- `provider_signal`: explicit/best-effort detected cycles
- `unavailable`: no reliable cycle signal observed

UI renders unknown values when cycle signals are unavailable.
