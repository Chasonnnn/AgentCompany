# Paperclip Evals

Paperclip ships with two eval lanes:

- `evals/promptfoo`: narrow component and prompt behavior checks
- `evals/architecture`: first-party architecture evals for reliability, runtime stability, and utility

See [the architecture eval contract](../doc/EVALS.md) for the normative Wave 1 design.

## Quick Start

### Prerequisites

```bash
pnpm add -g promptfoo
```

You need an API key for at least one provider. Set one of:

```bash
export OPENROUTER_API_KEY=sk-or-...    # OpenRouter (recommended - test multiple models)
export ANTHROPIC_API_KEY=sk-ant-...     # Anthropic direct
export OPENAI_API_KEY=sk-...            # OpenAI direct
```

### Run evals

```bash
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

# Or run promptfoo directly
cd evals/promptfoo
promptfoo eval

# View results in browser
promptfoo view
```

### What's tested

`evals/promptfoo` covers narrow behavior evals for the Paperclip heartbeat skill:

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

### Adding new cases

1. Add a YAML file to `evals/promptfoo/cases/`
2. Follow the existing case format (see `core-assignment-pickup.yaml` for reference)
3. Run `promptfoo eval` to test

`evals/architecture` currently ships Wave 1 internal-only seeded coverage:

- deterministic invariants
- role and handoff seeds
- a small end-to-end canary set
- artifact-backed replay envelopes
- rebuildable summary indexes

Artifacts are written to the Paperclip instance root under `data/evals/architecture/` by default.
