import { describe, expect, test } from "vitest";
import { JobSpec } from "../src/schemas/job.js";
import { ResultSpec } from "../src/schemas/result.js";

describe("JobSpec / ResultSpec schemas", () => {
  test("accepts a valid JobSpec", () => {
    const parsed = JobSpec.parse({
      schema_version: 1,
      type: "job",
      job_id: "job_123",
      worker_kind: "codex",
      workspace_dir: "/tmp/ws",
      project_id: "proj_123",
      goal: "Implement scheduler cooldown support",
      constraints: ["No destructive git commands", "Return strict JSON result"],
      deliverables: ["Code changes", "Tests"],
      permission_level: "patch",
      context_refs: [
        { kind: "file", value: "src/runtime/launch_lane.ts" },
        { kind: "command", value: "pnpm test", description: "Run targeted tests" }
      ]
    });
    expect(parsed.worker_kind).toBe("codex");
    expect(parsed.context_refs.length).toBe(2);
  });

  test("rejects JobSpec when required fields are missing", () => {
    expect(() =>
      JobSpec.parse({
        schema_version: 1,
        type: "job",
        job_id: "job_123",
        worker_kind: "codex",
        workspace_dir: "/tmp/ws",
        project_id: "proj_123",
        goal: "x",
        constraints: [],
        permission_level: "patch",
        context_refs: []
      })
    ).toThrow();
  });

  test("accepts all ResultSpec statuses and rejects invalid ones", () => {
    const base = {
      schema_version: 1,
      type: "result",
      job_id: "job_123",
      attempt_run_id: "run_123",
      summary: "ok",
      files_changed: [],
      commands_run: [],
      artifacts: [],
      next_actions: [],
      errors: []
    } as const;

    for (const status of ["succeeded", "needs_input", "blocked", "failed", "canceled"] as const) {
      const parsed = ResultSpec.parse({ ...base, status });
      expect(parsed.status).toBe(status);
    }

    expect(() => ResultSpec.parse({ ...base, status: "done" })).toThrow();
  });
});

