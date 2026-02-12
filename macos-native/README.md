# AgentCompany Native (SwiftUI)

Native macOS UI rewrite (SwiftUI) that uses the existing AgentCompany backend contracts through `dist/cli.js rpc:call`.

## What is implemented

- Project rail (workspace + project switching + add project)
- Scope-aware sidebar (Home, Channels, DMs, Activities, Resources)
- Modal creation flows (Project / Channel / DM / Settings)
- Workspace Home (portfolio KPIs + project health)
- Project Home (PM KPIs + Gantt + allocation recommendation apply)
- Conversation timeline + composer
- Participant detail pane with quick DM

## Run from Terminal

From repo root:

```bash
swift run --package-path macos-native AgentCompanyNative
```

## Open in Xcode

1. Open `/Users/chason/AgentCompany/macos-native/Package.swift` in Xcode.
2. Select the `AgentCompanyNative` executable target.
3. Run.

## First launch settings

Open `Settings` in the app toolbar and set:

- Workspace directory: `/Users/chason/AgentCompany/work`
- CLI path: `/Users/chason/AgentCompany/dist/cli.js`
- Node binary: `node`
- CEO actor id: `human_ceo`

## Build checks

```bash
swift test --package-path macos-native
swift build --package-path macos-native --product AgentCompanyNative
```
