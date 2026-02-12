import crypto from "node:crypto";

export type ReplayVerificationIssue = {
  seq: number;
  code: string;
  message: string;
};

const REQUIRED_EVENT_KEYS = [
  "schema_version",
  "event_id",
  "correlation_id",
  "causation_id",
  "ts_wallclock",
  "ts_monotonic_ms",
  "run_id",
  "session_ref",
  "actor",
  "visibility",
  "type",
  "payload",
  "prev_event_hash",
  "event_hash"
] as const;

function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function verifyReplayEvents(events: unknown[]): ReplayVerificationIssue[] {
  const issues: ReplayVerificationIssue[] = [];
  let prevEventHash: string | null = null;

  for (let i = 0; i < events.length; i += 1) {
    const seq = i + 1;
    const ev = events[i];
    if (!ev || typeof ev !== "object" || Array.isArray(ev)) {
      issues.push({
        seq,
        code: "invalid_shape",
        message: "Event is not an object."
      });
      continue;
    }

    for (const key of REQUIRED_EVENT_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(ev, key)) {
        issues.push({
          seq,
          code: "missing_key",
          message: `Missing required key: ${key}`
        });
      }
    }

    const schemaVersion = (ev as Record<string, unknown>).schema_version;
    if (
      typeof schemaVersion !== "number" ||
      !Number.isInteger(schemaVersion) ||
      schemaVersion <= 0
    ) {
      issues.push({
        seq,
        code: "invalid_schema_version",
        message: "schema_version must be a positive integer."
      });
    }

    const rawPrevHash = (ev as Record<string, unknown>).prev_event_hash;
    if (rawPrevHash !== null && typeof rawPrevHash !== "string") {
      issues.push({
        seq,
        code: "invalid_prev_hash_type",
        message: "prev_event_hash must be string|null."
      });
    }
    const prevHash = rawPrevHash === null || typeof rawPrevHash === "string" ? rawPrevHash : null;

    const rawEventHash = (ev as Record<string, unknown>).event_hash;
    if (typeof rawEventHash !== "string" || rawEventHash.length === 0) {
      issues.push({
        seq,
        code: "invalid_event_hash",
        message: "event_hash must be a non-empty string."
      });
    } else {
      const canonical = JSON.stringify({
        ...(ev as Record<string, unknown>),
        event_hash: undefined
      });
      const expected = sha256Hex(canonical);
      if (rawEventHash !== expected) {
        issues.push({
          seq,
          code: "event_hash_mismatch",
          message: "event_hash does not match the canonical event payload."
        });
      }
    }

    if (seq === 1) {
      if (prevHash !== null) {
        issues.push({
          seq,
          code: "first_prev_hash_non_null",
          message: "First event must have prev_event_hash = null."
        });
      }
    } else if (prevHash !== prevEventHash) {
      issues.push({
        seq,
        code: "prev_hash_chain_mismatch",
        message: "prev_event_hash does not match the previous event_hash."
      });
    }

    prevEventHash = typeof rawEventHash === "string" && rawEventHash.length > 0 ? rawEventHash : null;
  }

  return issues;
}
