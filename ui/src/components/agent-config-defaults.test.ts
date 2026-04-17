import { describe, expect, it } from "vitest";
import {
  claudeIssueThinkingEffortOptions,
  claudeThinkingEffortOptions,
  createCreateValuesForAdapterType,
  defaultThinkingEffortForAdapterType,
} from "./agent-config-defaults";

describe("agent config defaults", () => {
  it("defaults Claude create values to xhigh thinking effort", () => {
    expect(defaultThinkingEffortForAdapterType("claude_local")).toBe("xhigh");
    expect(createCreateValuesForAdapterType("claude_local").thinkingEffort).toBe("xhigh");
  });

  it("does not force non-Claude adapters onto a thinking effort", () => {
    expect(defaultThinkingEffortForAdapterType("codex_local")).toBe("");
    expect(createCreateValuesForAdapterType("codex_local").thinkingEffort).toBe("");
  });

  it("offers the full Claude effort ladder everywhere we configure it", () => {
    expect(claudeThinkingEffortOptions.map((option) => option.id)).toEqual([
      "",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);

    expect(claudeIssueThinkingEffortOptions.map((option) => option.value)).toEqual([
      "",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });
});
