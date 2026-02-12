# Desktop v3 UX: Native-Feel PM Workspace

This document defines the v3 desktop IA and visual direction for the React/Tauri app (`desktop-react`) while preserving existing backend governance/runtime behavior.

## Visual Direction

- Clarity-first and restrained.
- Native-feel shell over decorative effects.
- High legibility and compact but readable density.
- Apple/OpenAI-like hierarchy (clear spacing, explicit focus states, low visual noise).

## Native Shell Behavior

- Native macOS framed title bar for reliable platform drag/resize behavior (`tauri.conf.json`).
- UI retains restrained styling and compact hierarchy without depending on overlay title-bar tricks.
- Explicit drag region in top header; all interactive controls marked non-drag.

## Layout IA

Shell is four-pane:

1. Project rail:
   - Workspace Home
   - one-click project switching
   - quick switch (`Cmd/Ctrl+K`)
   - add project
   - settings
2. Context sidebar:
   - Home
   - Channels
   - DMs
   - Activities
   - Resources
3. Content pane:
   - PM home dashboards
   - conversation/activity/resources views
4. Details pane:
   - participants
   - per-agent profile card
   - quick DM

## Scope Behavior

- Workspace scope:
  - portfolio PM Home
  - workspace conversations + DMs
  - cross-project activities/resources
- Project scope:
  - project PM Home (task board + Gantt + allocation controls)
  - project channels and DMs
  - project activities/resources

## PM Home UX

Workspace Home:
- KPI row (projects, progress, token usage, operational alerts)
- project portfolio table with risk flags and quick-open actions

Project Home:
- KPI row (task volume, progress, blocked tasks, project usage)
- CPM/Gantt visualization via native SVG
- dependency-cycle warning state (non-fatal)
- allocation recommendation table with per-task apply and bulk apply

## Conversation UX

- Timeline + composer in content pane.
- Modal-only creation flows for:
  - project
  - channel
  - DM
- No `prompt()`-based creation in v3 path.
- CEO-centric DM initiation remains default.

## Activities and Resources

Activities:
- pending approvals
- recent decisions
- run activity rows
- virtualized list rendering

Resources:
- token/cost/worker KPIs
- provider usage split
- model distribution
- unknown-safe context-cycle counters

## Performance and Interaction Rules

- Virtualize high-volume lists (project rail, DM picker, activity feed, message timeline).
- Avoid heavy synchronous transformations on render path.
- Polling intervals are view-aware:
  - conversation: fast
  - activities: medium
  - home/resources: slower
  - paused when window/document is not visible

## Data and Contracts

- v3 frontend consumes additive `desktop.bootstrap.snapshot` RPC for coherent initial load and view refresh.
- Canonical files remain source of truth.
- SQLite remains rebuildable projection layer.
- Existing RPC contracts remain source-compatible.

## SwiftUI Track Policy

`macos-native` remains compile-green and reference-only.

- no feature parity commitments during v3 rollout
- no shared business logic migration to SwiftUI in this pass
