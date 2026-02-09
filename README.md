# AgentCompany

Local-first macOS "agent org" PM tool.

## Repo Quickstart

Prereqs:
- Node.js 24+
- `pnpm`

Install:
```bash
pnpm install
```

Build:
```bash
pnpm build
```

Run the CLI:
```bash
node dist/cli.js --help
```

Initialize a Company Workspace folder:
```bash
node dist/cli.js workspace:init /path/to/workspace --name "Acme"
```

Validate a Company Workspace folder:
```bash
node dist/cli.js workspace:validate /path/to/workspace
```

Create and validate an artifact template:
```bash
node dist/cli.js artifact:new proposal /tmp/proposal.md --title "Payments Proposal" --visibility managers --by agent_mgr_payments --run run_123 --ctx ctx_123
node dist/cli.js artifact:validate /tmp/proposal.md
```

Debugging:
- Set `AC_DEBUG=1` to include stack traces on unexpected errors.
