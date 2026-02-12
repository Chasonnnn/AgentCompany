type JsonObject = Record<string, unknown>;

export type ContextCycleSignal = {
  count: number;
  signal_type: string;
  source: "provider_notification" | "provider_jsonl";
};

function asObject(v: unknown): JsonObject | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as JsonObject) : null;
}

function looksCycleKey(key: string): boolean {
  return /compact|compaction|context.?window|cycle/i.test(key);
}

function numericCount(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.floor(v);
  return null;
}

function signalsFromObject(
  obj: JsonObject,
  source: ContextCycleSignal["source"],
  prefix: string
): ContextCycleSignal[] {
  const out: ContextCycleSignal[] = [];
  for (const [k, raw] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    const lower = key.toLowerCase();

    if (looksCycleKey(lower)) {
      const n = numericCount(raw);
      if (n !== null) {
        out.push({ count: n, signal_type: lower, source });
      } else if (typeof raw === "boolean" && raw) {
        out.push({ count: 1, signal_type: lower, source });
      } else if (typeof raw === "string" && /compact|cycled|context window/i.test(raw)) {
        out.push({ count: 1, signal_type: lower, source });
      }
    }

    if (Array.isArray(raw)) {
      for (const item of raw) {
        const child = asObject(item);
        if (!child) continue;
        out.push(...signalsFromObject(child, source, key));
      }
    } else {
      const child = asObject(raw);
      if (child) out.push(...signalsFromObject(child, source, key));
    }
  }
  return out;
}

function dedupeSignals(signals: ContextCycleSignal[]): ContextCycleSignal[] {
  const seen = new Set<string>();
  const out: ContextCycleSignal[] = [];
  for (const s of signals) {
    const key = `${s.source}::${s.signal_type}::${s.count}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

export function detectContextCyclesFromJsonLine(line: string): ContextCycleSignal[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  const obj = asObject(parsed);
  if (!obj) return [];
  return dedupeSignals(signalsFromObject(obj, "provider_jsonl", ""));
}

export function detectContextCyclesFromProtocolNotification(
  method: string,
  params: unknown
): ContextCycleSignal[] {
  const methodLower = method.toLowerCase();
  const paramsObj = asObject(params) ?? {};
  const out = signalsFromObject(paramsObj, "provider_notification", "");

  if (/compact|compaction|context.?window|cycle/.test(methodLower)) {
    const explicit = out.reduce((n, s) => n + s.count, 0);
    if (explicit === 0) {
      out.push({
        count: 1,
        signal_type: methodLower,
        source: "provider_notification"
      });
    }
  }

  return dedupeSignals(out);
}

export function summarizeContextCycleSignals(signals: ContextCycleSignal[]): {
  count: number;
  signal_types: string[];
} {
  const count = signals.reduce((n, s) => n + Math.max(0, Math.floor(s.count)), 0);
  const signalTypes = [...new Set(signals.map((s) => s.signal_type))].sort();
  return { count, signal_types: signalTypes };
}
