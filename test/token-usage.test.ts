import { describe, expect, test } from "vitest";
import {
  extractUsageFromJsonLine,
  estimateUsageFromChars,
  selectPreferredUsage,
  splitCompleteLines
} from "../src/runtime/token_usage.js";

describe("token usage extraction", () => {
  test("extracts tokenUsage object from JSON line", () => {
    const line = JSON.stringify({
      type: "turn.completed",
      tokenUsage: {
        cached_input_tokens: 3,
        input_tokens: 20,
        output_tokens: 4,
        reasoning_output_tokens: 2,
        total_tokens: 29
      }
    });
    const out = extractUsageFromJsonLine(line, "codex");
    expect(out.length).toBe(1);
    expect(out[0].source).toBe("provider_reported");
    expect(out[0].confidence).toBe("high");
    expect(out[0].total_tokens).toBe(29);
    expect(out[0].input_tokens).toBe(20);
    expect(out[0].output_tokens).toBe(4);
    expect(out[0].provider).toBe("codex");
  });

  test("supports OpenAI-style usage keys", () => {
    const line = JSON.stringify({
      usage: {
        prompt_tokens: 12,
        completion_tokens: 8,
        total_tokens: 20
      }
    });
    const out = extractUsageFromJsonLine(line, "claude");
    expect(out.length).toBe(1);
    expect(out[0].input_tokens).toBe(12);
    expect(out[0].output_tokens).toBe(8);
    expect(out[0].total_tokens).toBe(20);
  });

  test("splitCompleteLines preserves partial tail", () => {
    const parsed = splitCompleteLines('{"a":1}\n{"b":2}\n{"c":');
    expect(parsed.lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(parsed.rest).toBe('{"c":');
  });

  test("estimated usage is deterministic", () => {
    const est = estimateUsageFromChars({
      provider: "claude",
      stdin_chars: 80,
      stdout_chars: 40,
      stderr_chars: 0
    });
    expect(est.source).toBe("estimated_chars");
    expect(est.input_tokens).toBe(20);
    expect(est.output_tokens).toBe(10);
    expect(est.total_tokens).toBe(30);
  });

  test("selectPreferredUsage picks the highest total", () => {
    const picked = selectPreferredUsage([
      { source: "provider_reported", confidence: "high", total_tokens: 12 },
      { source: "provider_reported", confidence: "high", total_tokens: 20 },
      { source: "provider_reported", confidence: "high", total_tokens: 19 }
    ]);
    expect(picked?.total_tokens).toBe(20);
  });
});
