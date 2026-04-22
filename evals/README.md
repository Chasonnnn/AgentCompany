# Paperclip Evals

Paperclip ships with two eval lanes:

- `evals/promptfoo`: narrow component and prompt behavior checks
- `evals/architecture`: first-party architecture evals for reliability, runtime stability, and utility

See [the architecture eval contract](../doc/EVALS.md) for the normative Wave 1 design.

## Quick Start

### Prerequisites

```bash
pnpm install
```

For the component lane, CI and local runs need working local auth/config for:

- `codex_local`
- `claude_local`

The component lane no longer uses remote provider API keys by default.
For `claude_local`, Paperclip preserves the host Claude auth environment during component evals because forcing a temp `HOME` or `CLAUDE_CONFIG_DIR` deauthenticates Claude Max on macOS.

### Run evals

```bash
# Local adapter preflight (boots a loopback Paperclip server if needed)
pnpm evals:component:preflight

# Component lane smoke test (default models)
pnpm evals:smoke

# Architecture canary lane
pnpm evals:architecture:canary

# Nightly architecture matrix
pnpm evals:architecture:nightly

# Soak / chaos seeds
pnpm evals:architecture:soak

# Baseline + ablation seeds
pnpm evals:architecture:baseline

# Rebuild the summary index from raw artifacts
pnpm evals:architecture:rebuild

# Or run promptfoo directly against an already-running local Paperclip server
cd evals/promptfoo
PAPERCLIP_COMPONENT_EVAL_BASE_URL=http://127.0.0.1:3100 pnpm dlx promptfoo@0.103.3 eval

# View results in browser
pnpm dlx promptfoo@0.103.3 view
```

### What's tested

`evals/promptfoo` covers narrow behavior evals for the Paperclip heartbeat skill by sending promptfoo cases to `/api/instance/evals/component-run`, which executes the real local adapters through Paperclip:

| Case | Category | What it checks |
|------|----------|---------------|
| Assignment pickup | `core` | Agent picks up todo/in_progress tasks correctly |
| Progress update | `core` | Agent writes useful status comments |
| Blocked reporting | `core` | Agent recognizes and reports blocked state |
| Approval required | `governance` | Agent requests approval instead of acting |
| Company boundary | `governance` | Agent refuses cross-company actions |
| No work exit | `core` | Agent exits cleanly with no assignments |
| Checkout before work | `core` | Agent always checks out before modifying |
| 409 conflict handling | `core` | Agent stops on 409, picks different task |
| Skill disambiguation | `reliability` | Agent chooses the hardening lane when reusable-skill repair overlaps with one-off execution |
| Failure-promoted hardening | `reliability` | Agent promotes reusable skill failures into scaffolded hardening work |
| Shared mirror proposal gate | `reliability` | Agent requires eval evidence before asking for shared-mirror proposal approval |

### Adding new cases

1. Add a YAML file to `evals/promptfoo/tests/`
2. Add an explicit `caseId` var for each case
3. Follow the structured-output assertion format in `tests/core.yaml`
4. Run `pnpm evals:smoke` or `PAPERCLIP_COMPONENT_EVAL_BASE_URL=... pnpm dlx promptfoo@0.103.3 eval`

`evals/architecture` currently ships Wave 1 internal-only seeded coverage:

- deterministic invariants
- role and handoff seeds
- failure-promoted skill hardening scaffold and fingerprint-dedup seeds
- a small end-to-end canary set
- artifact-backed replay envelopes
- rebuildable summary indexes

Artifacts are written to the Paperclip instance root under `data/evals/architecture/` by default.
