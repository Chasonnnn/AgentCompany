import { describe, expect, test } from "vitest";
import { parseMemoryDeltaMarkdown } from "../src/memory/memory_delta.js";

describe("memory delta normalization", () => {
  test("normalizes schema v1 artifacts with source_schema_version metadata", () => {
    const markdown = `---
schema_version: 1
type: memory_delta
id: art_v1_memory
created_at: "2026-02-13T00:00:00.000Z"
title: Legacy memory entry
visibility: managers
produced_by: agent_mgr
run_id: run_legacy
context_pack_id: ctx_legacy
project_id: proj_legacy
target_file: work/projects/proj_legacy/memory.md
patch_file: work/projects/proj_legacy/artifacts/art_v1_memory.patch
---

# Legacy memory
`;

    const parsed = parseMemoryDeltaMarkdown(markdown);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.frontmatter.schema_version).toBe(1);
    expect(parsed.frontmatter.source_schema_version).toBe(1);
    expect(parsed.frontmatter.scope_kind).toBe("project_memory");
    expect(parsed.frontmatter.scope_ref).toBe("proj_legacy");
    expect(parsed.frontmatter.sensitivity).toBe("internal");
    expect(parsed.frontmatter.evidence).toEqual([]);
    expect(parsed.frontmatter.rationale).toMatch(/Legacy memory delta/);
  });

  test("parses schema v2 artifacts without losing governance metadata", () => {
    const markdown = `---
schema_version: 2
type: memory_delta
id: art_v2_memory
created_at: "2026-02-13T00:00:00.000Z"
title: Agent guidance update
visibility: managers
produced_by: agent_dir
run_id: run_v2
context_pack_id: ctx_v2
project_id: proj_v2
target_file: org/agents/agent_worker/AGENTS.md
patch_file: work/projects/proj_v2/artifacts/art_v2_memory.patch
scope_kind: agent_guidance
scope_ref: agent_worker
sensitivity: restricted
rationale: Keep governance metadata explicit.
evidence:
  - art_evidence_1
---

# Memory delta v2
`;

    const parsed = parseMemoryDeltaMarkdown(markdown);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.frontmatter.schema_version).toBe(2);
    expect(parsed.frontmatter.source_schema_version).toBe(2);
    expect(parsed.frontmatter.scope_kind).toBe("agent_guidance");
    expect(parsed.frontmatter.scope_ref).toBe("agent_worker");
    expect(parsed.frontmatter.sensitivity).toBe("restricted");
    expect(parsed.frontmatter.rationale).toBe("Keep governance metadata explicit.");
    expect(parsed.frontmatter.evidence).toEqual(["art_evidence_1"]);
  });

  test("fails closed on unknown frontmatter fields", () => {
    const markdown = `---
schema_version: 2
type: memory_delta
id: art_v2_invalid
created_at: "2026-02-13T00:00:00.000Z"
title: Bad delta
visibility: managers
produced_by: agent_dir
run_id: run_v2
context_pack_id: ctx_v2
project_id: proj_v2
target_file: work/projects/proj_v2/memory.md
patch_file: work/projects/proj_v2/artifacts/art_v2_invalid.patch
scope_kind: project_memory
scope_ref: proj_v2
sensitivity: internal
rationale: Should fail.
evidence:
  - art_evidence
extra_field: should_fail
---

# Invalid
`;

    const parsed = parseMemoryDeltaMarkdown(markdown);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toMatch(/unrecognized|unknown/i);
  });

  test("normalization is stable across repeated parse calls", () => {
    const markdown = `---
schema_version: 1
type: memory_delta
id: art_v1_repeat
created_at: "2026-02-13T00:00:00.000Z"
title: Repeat parse
visibility: team
produced_by: agent_mgr
run_id: run_legacy
context_pack_id: ctx_legacy
project_id: proj_repeat
target_file: org/agents/agent_worker/AGENTS.md
patch_file: work/projects/proj_repeat/artifacts/art_v1_repeat.patch
---

# Repeat
`;

    const first = parseMemoryDeltaMarkdown(markdown);
    const second = parseMemoryDeltaMarkdown(markdown);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.frontmatter).toEqual(second.frontmatter);
    expect(first.frontmatter.scope_kind).toBe("agent_guidance");
    expect(first.frontmatter.scope_ref).toBe("agent_worker");
  });
});
