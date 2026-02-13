import { describe, expect, test } from "vitest";
import { buildManagerDigest } from "../src/runtime/manager_digest.js";
import { ResultSpec } from "../src/schemas/result.js";

describe("manager digest", () => {
  test("enforces compact caps and pointer-only artifacts", () => {
    const longSummary = "x".repeat(2000);
    const result = ResultSpec.parse({
      schema_version: 1,
      type: "result",
      job_id: "job_1",
      attempt_run_id: "run_1",
      status: "succeeded",
      summary: longSummary,
      files_changed: Array.from({ length: 30 }, (_, i) => ({
        path: `src/file_${i}.ts`,
        change_type: "modified" as const,
        summary: `changed ${i}`
      })),
      commands_run: Array.from({ length: 30 }, (_, i) => ({
        command: `echo ${i}`,
        exit_code: 0,
        summary: `cmd ${i}`
      })),
      artifacts: [
        {
          relpath: "runs/run_1/outputs/stdout.txt",
          kind: "log",
          sha256: "abc"
        }
      ],
      next_actions: [{ action: "ship it" }],
      errors: []
    });

    const digest = buildManagerDigest({
      result,
      signals: { confidence: "high" }
    });
    expect(digest.summary.length).toBeLessThanOrEqual(1200);
    expect(digest.files_changed.length).toBe(20);
    expect(digest.commands_run.length).toBe(20);
    expect(digest.artifacts[0]).toEqual({
      relpath: "runs/run_1/outputs/stdout.txt",
      artifact_id: undefined,
      kind: "log",
      sha256: "abc"
    });
  });
});

