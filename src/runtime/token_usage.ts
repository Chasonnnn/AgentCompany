export type RunUsageSource = "provider_reported" | "estimated_chars";
export type RunUsageConfidence = "high" | "low";

export type RunUsageSummary = {
  source: RunUsageSource;
  confidence: RunUsageConfidence;
  estimate_method?: string;
  provider?: string;
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens: number;
  captured_from_event_type?: string;
};

const ESTIMATE_METHOD = "estimated from character counts using tokens≈chars/4";

function asNonNegativeInt(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  if (v < 0) return undefined;
  return Math.floor(v);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function looksLikeUsageObject(v: unknown): v is Record<string, unknown> {
  if (!isObject(v)) return false;
  return (
    "total_tokens" in v ||
    "input_tokens" in v ||
    "output_tokens" in v ||
    "prompt_tokens" in v ||
    "completion_tokens" in v
  );
}

function normalizeUsageCandidate(
  candidate: unknown,
  provider?: string,
  capturedFromEventType?: string
): RunUsageSummary | null {
  if (!isObject(candidate)) return null;

  const input = asNonNegativeInt(candidate.input_tokens ?? candidate.prompt_tokens);
  const cachedInput = asNonNegativeInt(candidate.cached_input_tokens);
  const output = asNonNegativeInt(candidate.output_tokens ?? candidate.completion_tokens);
  const reasoning = asNonNegativeInt(candidate.reasoning_output_tokens);

  let total = asNonNegativeInt(candidate.total_tokens);
  if (total === undefined) {
    const subtotal =
      (input ?? 0) + (cachedInput ?? 0) + (output ?? 0) + (reasoning ?? 0);
    if (subtotal > 0) total = subtotal;
  }
  if (total === undefined) return null;

  return {
    source: "provider_reported",
    confidence: "high",
    provider,
    input_tokens: input,
    cached_input_tokens: cachedInput,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: total,
    captured_from_event_type: capturedFromEventType
  };
}

function collectUsageCandidates(value: unknown, out: Array<{ value: unknown; eventType?: string }>, depth = 0): void {
  if (depth > 8) return;
  if (Array.isArray(value)) {
    for (const item of value) collectUsageCandidates(item, out, depth + 1);
    return;
  }
  if (!isObject(value)) return;

  if (looksLikeUsageObject(value)) {
    out.push({
      value,
      eventType:
        typeof value.type === "string" && value.type.length > 0 ? value.type : undefined
    });
  }
  if ("tokenUsage" in value) out.push({ value: value.tokenUsage, eventType: "tokenUsage" });
  if ("last_token_usage" in value) out.push({ value: value.last_token_usage, eventType: "last_token_usage" });
  if ("total_token_usage" in value) out.push({ value: value.total_token_usage, eventType: "total_token_usage" });
  if ("usage" in value) out.push({ value: value.usage, eventType: "usage" });

  for (const child of Object.values(value)) {
    collectUsageCandidates(child, out, depth + 1);
  }
}

export function extractUsageFromJsonLine(line: string, provider?: string): RunUsageSummary[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }

  const candidates: Array<{ value: unknown; eventType?: string }> = [];
  collectUsageCandidates(parsed, candidates);

  const dedupe = new Set<string>();
  const out: RunUsageSummary[] = [];
  for (const c of candidates) {
    const normalized = normalizeUsageCandidate(c.value, provider, c.eventType);
    if (!normalized) continue;
    const sig = JSON.stringify({
      provider: normalized.provider,
      input_tokens: normalized.input_tokens ?? null,
      cached_input_tokens: normalized.cached_input_tokens ?? null,
      output_tokens: normalized.output_tokens ?? null,
      reasoning_output_tokens: normalized.reasoning_output_tokens ?? null,
      total_tokens: normalized.total_tokens
    });
    if (dedupe.has(sig)) continue;
    dedupe.add(sig);
    out.push(normalized);
  }
  return out;
}

export function splitCompleteLines(buffer: string): { lines: string[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n");
  if (parts.length === 0) return { lines: [], rest: "" };
  const rest = parts.pop() ?? "";
  return {
    lines: parts.filter((l) => l.trim().length > 0),
    rest
  };
}

export function estimateUsageFromChars(args: {
  provider?: string;
  stdin_chars: number;
  stdout_chars: number;
  stderr_chars: number;
}): RunUsageSummary {
  const input = Math.max(0, Math.ceil(Math.max(0, args.stdin_chars) / 4));
  const output = Math.max(0, Math.ceil(Math.max(0, args.stdout_chars + args.stderr_chars) / 4));
  return {
    source: "estimated_chars",
    confidence: "low",
    estimate_method: ESTIMATE_METHOD,
    provider: args.provider,
    input_tokens: input,
    output_tokens: output,
    total_tokens: input + output
  };
}

export function selectPreferredUsage(usages: RunUsageSummary[]): RunUsageSummary | null {
  if (usages.length === 0) return null;
  let best = usages[0];
  for (const u of usages.slice(1)) {
    if (u.total_tokens > best.total_tokens) best = u;
  }
  return best;
}
