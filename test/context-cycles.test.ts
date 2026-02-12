import { describe, expect, test } from "vitest";
import {
  detectContextCyclesFromJsonLine,
  detectContextCyclesFromProtocolNotification,
  summarizeContextCycleSignals
} from "../src/runtime/context_cycles.js";

describe("context cycle signal detection", () => {
  test("extracts cycle signals from provider JSON lines", () => {
    const line = JSON.stringify({
      type: "turn.completed",
      telemetry: {
        compaction_count: 2,
        context_window_compacted: true
      }
    });
    const out = detectContextCyclesFromJsonLine(line);
    const summary = summarizeContextCycleSignals(out);
    expect(summary.count).toBeGreaterThanOrEqual(3);
    expect(summary.signal_types.some((s) => s.includes("compaction_count"))).toBe(true);
  });

  test("falls back to method-level signal for protocol notifications", () => {
    const out = detectContextCyclesFromProtocolNotification("thread/contextWindow/compacted", {
      threadId: "thr_1"
    });
    const summary = summarizeContextCycleSignals(out);
    expect(summary.count).toBeGreaterThanOrEqual(1);
  });
});
