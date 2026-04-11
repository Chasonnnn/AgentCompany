type CodexPricing = {
  inputCostPerToken: number;
  outputCostPerToken: number;
  cacheReadInputCostPerToken: number | null;
};

type ClaudePricing = {
  inputCostPerToken: number;
  outputCostPerToken: number;
  cacheCreationInputCostPerToken: number;
  cacheReadInputCostPerToken: number;
  thresholdTokens: number | null;
  inputCostPerTokenAboveThreshold: number | null;
  outputCostPerTokenAboveThreshold: number | null;
  cacheCreationInputCostPerTokenAboveThreshold: number | null;
  cacheReadInputCostPerTokenAboveThreshold: number | null;
};

type ApiEquivalentUsage = {
  model: string;
  inputTokens?: number | null;
  cachedInputTokens?: number | null;
  cacheCreationInputTokens?: number | null;
  outputTokens?: number | null;
};

const codexPricing: Record<string, CodexPricing> = {
  "gpt-5": { inputCostPerToken: 1.25e-6, outputCostPerToken: 1e-5, cacheReadInputCostPerToken: 1.25e-7 },
  "gpt-5-codex": { inputCostPerToken: 1.25e-6, outputCostPerToken: 1e-5, cacheReadInputCostPerToken: 1.25e-7 },
  "gpt-5-mini": { inputCostPerToken: 2.5e-7, outputCostPerToken: 2e-6, cacheReadInputCostPerToken: 2.5e-8 },
  "gpt-5-nano": { inputCostPerToken: 5e-8, outputCostPerToken: 4e-7, cacheReadInputCostPerToken: 5e-9 },
  "gpt-5-pro": { inputCostPerToken: 1.5e-5, outputCostPerToken: 1.2e-4, cacheReadInputCostPerToken: null },
  "gpt-5.1": { inputCostPerToken: 1.25e-6, outputCostPerToken: 1e-5, cacheReadInputCostPerToken: 1.25e-7 },
  "gpt-5.1-codex": { inputCostPerToken: 1.25e-6, outputCostPerToken: 1e-5, cacheReadInputCostPerToken: 1.25e-7 },
  "gpt-5.1-codex-max": { inputCostPerToken: 1.25e-6, outputCostPerToken: 1e-5, cacheReadInputCostPerToken: 1.25e-7 },
  "gpt-5.1-codex-mini": { inputCostPerToken: 2.5e-7, outputCostPerToken: 2e-6, cacheReadInputCostPerToken: 2.5e-8 },
  "gpt-5.2": { inputCostPerToken: 1.75e-6, outputCostPerToken: 1.4e-5, cacheReadInputCostPerToken: 1.75e-7 },
  "gpt-5.2-codex": { inputCostPerToken: 1.75e-6, outputCostPerToken: 1.4e-5, cacheReadInputCostPerToken: 1.75e-7 },
  "gpt-5.2-pro": { inputCostPerToken: 2.1e-5, outputCostPerToken: 1.68e-4, cacheReadInputCostPerToken: null },
  "gpt-5.3": { inputCostPerToken: 1.75e-6, outputCostPerToken: 1.4e-5, cacheReadInputCostPerToken: 1.75e-7 },
  "gpt-5.3-codex": { inputCostPerToken: 1.75e-6, outputCostPerToken: 1.4e-5, cacheReadInputCostPerToken: 1.75e-7 },
  "gpt-5.3-codex-spark": { inputCostPerToken: 0, outputCostPerToken: 0, cacheReadInputCostPerToken: 0 },
  "gpt-5.4": { inputCostPerToken: 2.5e-6, outputCostPerToken: 1.5e-5, cacheReadInputCostPerToken: 2.5e-7 },
  "gpt-5.4-mini": { inputCostPerToken: 7.5e-7, outputCostPerToken: 4.5e-6, cacheReadInputCostPerToken: 7.5e-8 },
  "gpt-5.4-nano": { inputCostPerToken: 2e-7, outputCostPerToken: 1.25e-6, cacheReadInputCostPerToken: 2e-8 },
  "gpt-5.4-pro": { inputCostPerToken: 3e-5, outputCostPerToken: 1.8e-4, cacheReadInputCostPerToken: null },
};

const claudePricing: Record<string, ClaudePricing> = {
  "claude-haiku-4-5-20251001": {
    inputCostPerToken: 1e-6,
    outputCostPerToken: 5e-6,
    cacheCreationInputCostPerToken: 1.25e-6,
    cacheReadInputCostPerToken: 1e-7,
    thresholdTokens: null,
    inputCostPerTokenAboveThreshold: null,
    outputCostPerTokenAboveThreshold: null,
    cacheCreationInputCostPerTokenAboveThreshold: null,
    cacheReadInputCostPerTokenAboveThreshold: null,
  },
  "claude-haiku-4-5": {
    inputCostPerToken: 1e-6,
    outputCostPerToken: 5e-6,
    cacheCreationInputCostPerToken: 1.25e-6,
    cacheReadInputCostPerToken: 1e-7,
    thresholdTokens: null,
    inputCostPerTokenAboveThreshold: null,
    outputCostPerTokenAboveThreshold: null,
    cacheCreationInputCostPerTokenAboveThreshold: null,
    cacheReadInputCostPerTokenAboveThreshold: null,
  },
  "claude-opus-4-5-20251101": {
    inputCostPerToken: 5e-6,
    outputCostPerToken: 2.5e-5,
    cacheCreationInputCostPerToken: 6.25e-6,
    cacheReadInputCostPerToken: 5e-7,
    thresholdTokens: null,
    inputCostPerTokenAboveThreshold: null,
    outputCostPerTokenAboveThreshold: null,
    cacheCreationInputCostPerTokenAboveThreshold: null,
    cacheReadInputCostPerTokenAboveThreshold: null,
  },
  "claude-opus-4-5": {
    inputCostPerToken: 5e-6,
    outputCostPerToken: 2.5e-5,
    cacheCreationInputCostPerToken: 6.25e-6,
    cacheReadInputCostPerToken: 5e-7,
    thresholdTokens: null,
    inputCostPerTokenAboveThreshold: null,
    outputCostPerTokenAboveThreshold: null,
    cacheCreationInputCostPerTokenAboveThreshold: null,
    cacheReadInputCostPerTokenAboveThreshold: null,
  },
  "claude-opus-4-6-20260205": {
    inputCostPerToken: 5e-6,
    outputCostPerToken: 2.5e-5,
    cacheCreationInputCostPerToken: 6.25e-6,
    cacheReadInputCostPerToken: 5e-7,
    thresholdTokens: null,
    inputCostPerTokenAboveThreshold: null,
    outputCostPerTokenAboveThreshold: null,
    cacheCreationInputCostPerTokenAboveThreshold: null,
    cacheReadInputCostPerTokenAboveThreshold: null,
  },
  "claude-opus-4-6": {
    inputCostPerToken: 5e-6,
    outputCostPerToken: 2.5e-5,
    cacheCreationInputCostPerToken: 6.25e-6,
    cacheReadInputCostPerToken: 5e-7,
    thresholdTokens: null,
    inputCostPerTokenAboveThreshold: null,
    outputCostPerTokenAboveThreshold: null,
    cacheCreationInputCostPerTokenAboveThreshold: null,
    cacheReadInputCostPerTokenAboveThreshold: null,
  },
  "claude-sonnet-4-5": {
    inputCostPerToken: 3e-6,
    outputCostPerToken: 1.5e-5,
    cacheCreationInputCostPerToken: 3.75e-6,
    cacheReadInputCostPerToken: 3e-7,
    thresholdTokens: 200_000,
    inputCostPerTokenAboveThreshold: 6e-6,
    outputCostPerTokenAboveThreshold: 2.25e-5,
    cacheCreationInputCostPerTokenAboveThreshold: 7.5e-6,
    cacheReadInputCostPerTokenAboveThreshold: 6e-7,
  },
  "claude-sonnet-4-6": {
    inputCostPerToken: 3e-6,
    outputCostPerToken: 1.5e-5,
    cacheCreationInputCostPerToken: 3.75e-6,
    cacheReadInputCostPerToken: 3e-7,
    thresholdTokens: 200_000,
    inputCostPerTokenAboveThreshold: 6e-6,
    outputCostPerTokenAboveThreshold: 2.25e-5,
    cacheCreationInputCostPerTokenAboveThreshold: 7.5e-6,
    cacheReadInputCostPerTokenAboveThreshold: 6e-7,
  },
  "claude-sonnet-4-5-20250929": {
    inputCostPerToken: 3e-6,
    outputCostPerToken: 1.5e-5,
    cacheCreationInputCostPerToken: 3.75e-6,
    cacheReadInputCostPerToken: 3e-7,
    thresholdTokens: 200_000,
    inputCostPerTokenAboveThreshold: 6e-6,
    outputCostPerTokenAboveThreshold: 2.25e-5,
    cacheCreationInputCostPerTokenAboveThreshold: 7.5e-6,
    cacheReadInputCostPerTokenAboveThreshold: 6e-7,
  },
  "claude-opus-4-20250514": {
    inputCostPerToken: 1.5e-5,
    outputCostPerToken: 7.5e-5,
    cacheCreationInputCostPerToken: 1.875e-5,
    cacheReadInputCostPerToken: 1.5e-6,
    thresholdTokens: null,
    inputCostPerTokenAboveThreshold: null,
    outputCostPerTokenAboveThreshold: null,
    cacheCreationInputCostPerTokenAboveThreshold: null,
    cacheReadInputCostPerTokenAboveThreshold: null,
  },
  "claude-opus-4-1": {
    inputCostPerToken: 1.5e-5,
    outputCostPerToken: 7.5e-5,
    cacheCreationInputCostPerToken: 1.875e-5,
    cacheReadInputCostPerToken: 1.5e-6,
    thresholdTokens: null,
    inputCostPerTokenAboveThreshold: null,
    outputCostPerTokenAboveThreshold: null,
    cacheCreationInputCostPerTokenAboveThreshold: null,
    cacheReadInputCostPerTokenAboveThreshold: null,
  },
  "claude-sonnet-4-20250514": {
    inputCostPerToken: 3e-6,
    outputCostPerToken: 1.5e-5,
    cacheCreationInputCostPerToken: 3.75e-6,
    cacheReadInputCostPerToken: 3e-7,
    thresholdTokens: 200_000,
    inputCostPerTokenAboveThreshold: 6e-6,
    outputCostPerTokenAboveThreshold: 2.25e-5,
    cacheCreationInputCostPerTokenAboveThreshold: 7.5e-6,
    cacheReadInputCostPerTokenAboveThreshold: 6e-7,
  },
};

const openCodeReasoningSuffixes = ["-xhigh", "-high", "-medium", "-low", "-thinking"] as const;

function asNonNegativeInteger(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function tieredCost(tokens: number, base: number, above: number | null, threshold: number | null): number {
  if (threshold == null || above == null) return tokens * base;
  const below = Math.min(tokens, threshold);
  const over = Math.max(tokens - threshold, 0);
  return below * base + over * above;
}

function reorderClaudeModel(raw: string): string | null {
  const match = raw.match(/^claude-(\d+)\.(\d+)-(opus|sonnet|haiku)(?:-[A-Za-z0-9._-]+)?$/);
  if (!match) return null;
  const [, major, minor, family] = match;
  return `claude-${family}-${major}-${minor}`;
}

export function normalizeCodexModel(raw: string): string {
  let trimmed = raw.trim();
  if (trimmed.startsWith("openai.")) trimmed = trimmed.slice("openai.".length);
  if (trimmed.startsWith("openai/")) trimmed = trimmed.slice("openai/".length);

  let strippedOpenCodeSuffix = false;
  for (const suffix of openCodeReasoningSuffixes) {
    if (!trimmed.endsWith(suffix)) continue;
    const candidate = trimmed.slice(0, -suffix.length);
    if (codexPricing[candidate]) {
      trimmed = candidate;
      strippedOpenCodeSuffix = true;
      break;
    }
  }

  if (codexPricing[trimmed]) {
    if (strippedOpenCodeSuffix) {
      const codexIndex = trimmed.indexOf("-codex");
      if (codexIndex >= 0) {
        const base = trimmed.slice(0, codexIndex);
        if (codexPricing[base]) return base;
      }
    }
    return trimmed;
  }

  const datedSuffix = trimmed.match(/-\d{4}-\d{2}-\d{2}$/);
  if (datedSuffix) {
    const base = trimmed.slice(0, -datedSuffix[0].length);
    if (codexPricing[base]) return base;
  }

  return trimmed;
}

export function normalizeClaudeModel(raw: string): string {
  let trimmed = raw.trim();
  if (trimmed.startsWith("anthropic.")) trimmed = trimmed.slice("anthropic.".length);
  const claudeIndex = trimmed.indexOf("claude-");
  if (claudeIndex > 0) trimmed = trimmed.slice(claudeIndex);

  const lastDotIndex = trimmed.lastIndexOf(".");
  if (lastDotIndex >= 0 && trimmed.includes("claude-")) {
    const tail = trimmed.slice(lastDotIndex + 1);
    if (tail.startsWith("claude-")) trimmed = tail;
  }

  trimmed = trimmed.replace(/-v\d+:\d+$/, "");

  const reordered = reorderClaudeModel(trimmed);
  if (reordered) trimmed = reordered;

  for (const suffix of ["-thinking", "-preview"] as const) {
    if (!trimmed.endsWith(suffix)) continue;
    const candidate = trimmed.slice(0, -suffix.length);
    if (claudePricing[candidate]) {
      trimmed = candidate;
      break;
    }
  }

  const datedSuffix = trimmed.match(/-\d{8}$/);
  if (datedSuffix) {
    const base = trimmed.slice(0, -datedSuffix[0].length);
    if (claudePricing[base]) return base;
  }

  return trimmed;
}

export function codexCostUsd(input: ApiEquivalentUsage): number | null {
  const key = normalizeCodexModel(input.model);
  const pricing = codexPricing[key];
  if (!pricing) return null;

  const inputTokens = asNonNegativeInteger(input.inputTokens);
  const cachedInputTokens = Math.min(
    asNonNegativeInteger(input.cachedInputTokens),
    inputTokens,
  );
  const outputTokens = asNonNegativeInteger(input.outputTokens);
  const nonCachedInputTokens = Math.max(0, inputTokens - cachedInputTokens);
  const cachedRate = pricing.cacheReadInputCostPerToken ?? pricing.inputCostPerToken;

  return nonCachedInputTokens * pricing.inputCostPerToken
    + cachedInputTokens * cachedRate
    + outputTokens * pricing.outputCostPerToken;
}

export function claudeCostUsd(input: ApiEquivalentUsage): number | null {
  const key = normalizeClaudeModel(input.model);
  const pricing = claudePricing[key];
  if (!pricing) return null;

  const inputTokens = asNonNegativeInteger(input.inputTokens);
  const cachedInputTokens = asNonNegativeInteger(input.cachedInputTokens);
  const cacheCreationInputTokens = asNonNegativeInteger(input.cacheCreationInputTokens);
  const outputTokens = asNonNegativeInteger(input.outputTokens);

  return tieredCost(
    inputTokens,
    pricing.inputCostPerToken,
    pricing.inputCostPerTokenAboveThreshold,
    pricing.thresholdTokens,
  )
    + tieredCost(
      cachedInputTokens,
      pricing.cacheReadInputCostPerToken,
      pricing.cacheReadInputCostPerTokenAboveThreshold,
      pricing.thresholdTokens,
    )
    + tieredCost(
      cacheCreationInputTokens,
      pricing.cacheCreationInputCostPerToken,
      pricing.cacheCreationInputCostPerTokenAboveThreshold,
      pricing.thresholdTokens,
    )
    + tieredCost(
      outputTokens,
      pricing.outputCostPerToken,
      pricing.outputCostPerTokenAboveThreshold,
      pricing.thresholdTokens,
    );
}

export function estimateApiEquivalentCostCents(input: ApiEquivalentUsage): number | null {
  const claudeUsd = claudeCostUsd(input);
  if (claudeUsd != null) return Math.max(0, Math.round(claudeUsd * 100));

  const codexUsd = codexCostUsd(input);
  if (codexUsd != null) return Math.max(0, Math.round(codexUsd * 100));

  return null;
}
