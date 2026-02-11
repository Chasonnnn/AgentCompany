import type { MachineYaml } from "../schemas/machine.js";
import type { RunUsageSummary } from "../schemas/run.js";
import type { ProviderTokenRateCardUsdPer1k } from "../schemas/budget.js";

function providerAliasCandidates(provider: string): string[] {
  const out = new Set<string>();
  const p = provider.trim();
  if (!p) return [];
  out.add(p);
  if (p === "codex_app_server" || p === "codex-app-server") out.add("codex");
  if (p === "claude_code" || p === "claude-code") out.add("claude");
  return [...out];
}

function resolveRateCard(
  machine: MachineYaml,
  provider: string
): { provider_key: string; rate_card: ProviderTokenRateCardUsdPer1k } | null {
  const all = machine.provider_pricing_usd_per_1k_tokens ?? {};
  for (const candidate of providerAliasCandidates(provider)) {
    const found = all[candidate];
    if (found) return { provider_key: candidate, rate_card: found };
  }
  if (all.default) return { provider_key: "default", rate_card: all.default };
  return null;
}

export type CostComputation = {
  cost_usd: number | null;
  currency: "USD";
  source: "provider_rate_card" | "no_rate_card";
  rate_card_provider?: string;
};

function roundCostUsd(v: number): number {
  return Math.round(v * 1_000_000_000) / 1_000_000_000;
}

export function computeRunUsageCostUsd(args: {
  usage: RunUsageSummary;
  provider: string;
  machine: MachineYaml;
}): CostComputation {
  const resolved = resolveRateCard(args.machine, args.provider);
  if (!resolved) {
    return {
      cost_usd: null,
      currency: "USD",
      source: "no_rate_card"
    };
  }

  const usage = args.usage;
  let input = usage.input_tokens ?? 0;
  let cachedInput = usage.cached_input_tokens ?? 0;
  let output = usage.output_tokens ?? 0;
  let reasoning = usage.reasoning_output_tokens ?? 0;

  const splitKnown =
    usage.input_tokens !== undefined ||
    usage.cached_input_tokens !== undefined ||
    usage.output_tokens !== undefined ||
    usage.reasoning_output_tokens !== undefined;

  if (!splitKnown && usage.total_tokens > 0) {
    input = Math.floor(usage.total_tokens / 2);
    output = usage.total_tokens - input;
    cachedInput = 0;
    reasoning = 0;
  }

  const rates = resolved.rate_card;
  const cost =
    (input / 1000) * rates.input +
    (cachedInput / 1000) * (rates.cached_input ?? rates.input) +
    (output / 1000) * rates.output +
    (reasoning / 1000) * (rates.reasoning_output ?? rates.output);

  return {
    cost_usd: roundCostUsd(cost),
    currency: "USD",
    source: "provider_rate_card",
    rate_card_provider: resolved.provider_key
  };
}
