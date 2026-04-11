import { describe, expect, it } from "vitest";
import {
  claudeCostUsd,
  codexCostUsd,
  estimateApiEquivalentCostCents,
  normalizeClaudeModel,
  normalizeCodexModel,
} from "../services/api-equivalent-pricing.ts";

describe("api-equivalent pricing", () => {
  it("normalizes codex model variants from CodexBar rules", () => {
    expect(normalizeCodexModel("openai/gpt-5-codex")).toBe("gpt-5-codex");
    expect(normalizeCodexModel("gpt-5.4-pro-2026-03-05")).toBe("gpt-5.4-pro");
    expect(normalizeCodexModel("gpt-5.4-mini-2026-03-17")).toBe("gpt-5.4-mini");
    expect(normalizeCodexModel("openai.gpt-5.3-codex-xhigh")).toBe("gpt-5.3");
    expect(normalizeCodexModel("gpt-5.3-codex-spark")).toBe("gpt-5.3-codex-spark");
  });

  it("prices codex cached input separately", () => {
    expect(
      codexCostUsd({
        model: "gpt-5.4",
        inputTokens: 1_000,
        cachedInputTokens: 200,
        outputTokens: 100,
      }),
    ).toBeCloseTo(0.00355, 8);
  });

  it("returns zero cents for codex research preview pricing", () => {
    expect(
      estimateApiEquivalentCostCents({
        model: "gpt-5.3-codex-spark",
        inputTokens: 100_000,
        cachedInputTokens: 20_000,
        outputTokens: 5_000,
      }),
    ).toBe(0);
  });

  it("normalizes claude aliases and reordered variants", () => {
    expect(normalizeClaudeModel("claude-opus-4-1-20250805")).toBe("claude-opus-4-1");
    expect(normalizeClaudeModel("anthropic.claude-4.6-opus-thinking")).toBe("claude-opus-4-6");
    expect(normalizeClaudeModel("bedrock.anthropic.claude-4.5-sonnet-preview")).toBe("claude-sonnet-4-5");
  });

  it("prices claude cache read and cache creation tokens", () => {
    expect(
      claudeCostUsd({
        model: "anthropic.claude-4.6-opus-thinking",
        inputTokens: 1_000,
        cachedInputTokens: 100,
        cacheCreationInputTokens: 50,
        outputTokens: 40,
      }),
    ).toBeCloseTo(0.0063625, 8);
  });

  it("applies claude tiered pricing above the threshold", () => {
    expect(
      claudeCostUsd({
        model: "claude-sonnet-4-6",
        inputTokens: 250_000,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
        outputTokens: 0,
      }),
    ).toBeCloseTo(0.9, 8);
  });

  it("returns null for unsupported models", () => {
    expect(
      estimateApiEquivalentCostCents({
        model: "glm-4.6",
        inputTokens: 10_000,
        cachedInputTokens: 500,
        cacheCreationInputTokens: 0,
        outputTokens: 100,
      }),
    ).toBeNull();
  });
});
