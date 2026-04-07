# Plugin Authoring Smoke Example

A AgentCompany plugin

## Development

```bash
pnpm install
pnpm dev            # watch builds
pnpm dev:ui         # local dev server with hot-reload events
pnpm test
```

## Install Into AgentCompany

```bash
pnpm agentcompany plugin install ./
```

## Build Options

- `pnpm build` uses esbuild presets from `/plugin-sdk/bundlers`.
- `pnpm build:rollup` uses rollup presets from the same SDK.
