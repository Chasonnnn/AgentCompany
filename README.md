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

Create org structure:
```bash
TEAM_ID=$(node dist/cli.js team:new /path/to/workspace --name "Payments")
node dist/cli.js agent:new /path/to/workspace --name "Payments Manager" --role manager --provider codex --team "$TEAM_ID"
PROJECT_ID=$(node dist/cli.js project:new /path/to/workspace --name "Project X")
```

Create a run (run.yaml + events.jsonl + context pack skeleton):
```bash
node dist/cli.js run:new /path/to/workspace --project "$PROJECT_ID" --agent <agent_id> --provider codex
```

Execute a run command (writes `provider.raw` events and updates `run.yaml` status):
```bash
node dist/cli.js run:execute /path/to/workspace --project "$PROJECT_ID" --run <run_id> --argv node -e "console.log('hello')"
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
