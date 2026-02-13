import { describe, expect, test } from "vitest";
import {
  SensitiveTextError,
  assertNoSensitiveText,
  redactSensitiveText
} from "../src/core/redaction.js";

describe("core redaction invariants", () => {
  test("redaction is deterministic and idempotent", () => {
    const input = [
      "token=sk-1234567890abcdefghijklmnopqrs",
      "ghp_1234567890abcdefghijklmnopqrstuv",
      "Bearer abcdefghijklmnopqrstuvwxyz012345"
    ].join("\n");

    const first = redactSensitiveText(input);
    const second = redactSensitiveText(input);
    const third = redactSensitiveText(first.text);

    expect(second).toEqual(first);
    expect(third.text).toBe(first.text);
    expect(third.redaction_count).toBe(0);
    expect(first.redaction_count).toBeGreaterThan(0);
  });

  test("assertNoSensitiveText throws structured SECRET_DETECTED metadata", () => {
    const input = "api_key=sk-1234567890abcdefghijklmnopqrs";

    let thrown: unknown;
    try {
      assertNoSensitiveText(input, "review.notes");
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(SensitiveTextError);
    const err = thrown as SensitiveTextError;
    expect(err.reason_code).toBe("SECRET_DETECTED");
    expect(err.context_label).toBe("review.notes");
    expect(err.total_matches).toBeGreaterThan(0);
    expect(typeof err.matches_by_kind).toBe("object");
    expect(Object.values(err.matches_by_kind).some((count) => count > 0)).toBe(true);
  });
});
