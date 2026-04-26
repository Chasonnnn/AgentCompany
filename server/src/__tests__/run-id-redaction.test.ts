import { describe, it, expect } from "vitest";
import { hashRunId, redactRunId } from "../run-id-redaction.js";

describe("run-id-redaction", () => {
  describe("hashRunId", () => {
    it("returns null for empty values", () => {
      expect(hashRunId(null)).toBeNull();
      expect(hashRunId(undefined)).toBeNull();
      expect(hashRunId("")).toBeNull();
    });

    it("is deterministic for the same input", () => {
      const runId = "00000000-0000-4000-8000-000000000001";
      expect(hashRunId(runId)).toBe(hashRunId(runId));
    });

    it("produces different hashes for different inputs", () => {
      expect(hashRunId("run-a")).not.toBe(hashRunId("run-b"));
    });

    it("does not leak the raw runId in the hash output", () => {
      const runId = "11111111-2222-3333-4444-555555555555";
      const hash = hashRunId(runId);
      expect(hash).not.toContain(runId);
      expect(hash).toMatch(/^run-hash:[0-9a-f]+$/);
    });
  });

  describe("redactRunId", () => {
    it("returns the raw value when caller is privileged", () => {
      expect(redactRunId("run-abc", true)).toBe("run-abc");
    });

    it("returns the hash when caller is not privileged", () => {
      expect(redactRunId("run-abc", false)).toBe(hashRunId("run-abc"));
    });

    it("returns null for empty values regardless of privilege", () => {
      expect(redactRunId(null, true)).toBeNull();
      expect(redactRunId(null, false)).toBeNull();
    });
  });
});
