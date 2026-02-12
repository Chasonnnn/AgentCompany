# Desktop Release Strategy (Tauri)

This document defines the baseline release strategy for AgentCompany desktop builds.

## Channels

Channel endpoints are tracked in:

- `src-tauri/release-channels.json`

Required channels:

- `alpha`
- `beta`
- `stable`

Each channel must define an `endpoint` URL for updater manifests.

## Tauri Config Baseline

`src-tauri/tauri.conf.json` should include:

- `identifier` (stable app id)
- release-like `version` (not `0.0.0`)
- `bundle.active: true` for package builds
- `plugins.updater` with:
  - `active: true`
  - `pubkey`
  - `endpoints`

## Signing and Notarization

Updater signing key:

- `TAURI_SIGNING_PRIVATE_KEY`
- optional: `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

macOS release signing/notarization:

- `APPLE_SIGNING_IDENTITY`
- `APPLE_TEAM_ID`

## Readiness Check

Run:

```bash
node dist/cli.js desktop:release-doctor
```

This command validates updater/channel/signing strategy and reports pass/warn/fail checks.
