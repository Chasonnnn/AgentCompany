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

Create a task and add a milestone:
```bash
TASK_ID=$(node dist/cli.js task:new /path/to/workspace --project "$PROJECT_ID" --title "Run Monitor v0")
node dist/cli.js task:add-milestone /path/to/workspace --project "$PROJECT_ID" --task "$TASK_ID" --title "List runs" --kind coding --status ready --accept "Shows recent runs with status"
```

Propose and approve a curated memory delta (project memory):
```bash
DELTA=$(node dist/cli.js memory:delta /path/to/workspace --project "$PROJECT_ID" --title "Decision: strict JSONL envelope" --under "## Decisions" --insert "- Events are strict-envelope JSONL and append-only." --by human)
ARTIFACT_ID=$(node -e "console.log(JSON.parse(process.argv[1]).artifact_id)" "$DELTA")
node dist/cli.js memory:approve /path/to/workspace --project "$PROJECT_ID" --artifact "$ARTIFACT_ID" --actor human --role manager --notes "LGTM"
```

Milestone report and approval:
```bash
REPORT=$(node dist/cli.js milestone:report:new /path/to/workspace --project "$PROJECT_ID" --task "$TASK_ID" --milestone <ms_id> --title "Milestone 1 report" --by <worker_agent_id> --run <run_id> --ctx <ctx_id> --evidence <patch_art_id> --tests <test_art_id>)
REPORT_ID=$(node -e "console.log(JSON.parse(process.argv[1]).artifact_id)" "$REPORT")
node dist/cli.js milestone:approve /path/to/workspace --project "$PROJECT_ID" --task "$TASK_ID" --milestone <ms_id> --report "$REPORT_ID" --actor human --role manager --notes "Approved"
```

Validate a Company Workspace folder:
```bash
node dist/cli.js workspace:validate /path/to/workspace
```

Run monitor helpers:
```bash
node dist/cli.js run:list /path/to/workspace --project "$PROJECT_ID"
node dist/cli.js run:replay /path/to/workspace --project "$PROJECT_ID" --run <run_id> --tail 50
```

Cross-team sharing:
```bash
node dist/cli.js sharepack:create /path/to/workspace --project "$PROJECT_ID" --by human
node dist/cli.js help:new /path/to/workspace --title "Need help reviewing this workplan" --requester human --target <manager_agent_id> --project "$PROJECT_ID" --visibility managers
```

Create and validate an artifact template:
```bash
node dist/cli.js artifact:new proposal /tmp/proposal.md --title "Payments Proposal" --visibility managers --by agent_mgr_payments --run run_123 --ctx ctx_123
node dist/cli.js artifact:validate /tmp/proposal.md
```

Debugging:
- Set `AC_DEBUG=1` to include stack traces on unexpected errors.
