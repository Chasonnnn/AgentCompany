# ADR: Desktop UI Platform v3 (React/Tauri over Full SwiftUI Rewrite)

## Status

Accepted (2026-02-12)

## Context

AgentCompany required a full desktop UI/UX rewrite with:

- Slack-like workspace navigation
- PM-first workspace/project home screens
- CPM/Gantt and allocation control flows
- stronger native-feel desktop behavior

Two implementation paths were considered:

1. full SwiftUI rewrite
2. Tauri shell + React/TypeScript frontend rewrite

The backend governance/runtime logic is already implemented in reusable TypeScript core modules and exposed through JSON-RPC contracts.

## Decision

Use **Tauri + React + TypeScript** as the v3 production desktop path.

- Keep `src` and `src-tauri` as canonical backend/runtime layers.
- Build new UI in `desktop-react/`.
- Keep existing `desktop-ui/` as rollback path during phased migration.
- Keep `macos-native/` compile-green and reference-only (feature-frozen).

## Rationale

- fastest path to native-feel improvements while preserving existing backend contracts
- avoids dual ownership of business logic across TypeScript and Swift
- enables modular design-system primitives and virtualization patterns
- supports phased rollout with rollback profile

## Consequences

Positive:

- higher iteration speed
- lower migration risk
- better consistency with existing test/runtime stack

Negative:

- still a webview UI (requires discipline for native feel)
- requires ongoing shell/config tuning and design-system enforcement

## Follow-up Rules

- no prompt-based creation UX in v3 path
- modal-first flows only
- provider/context-cycle unknowns must render as unknown (no fabricated values)
- no canonical storage migration; filesystem remains source of truth
