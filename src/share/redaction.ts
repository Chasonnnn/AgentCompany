export type RedactionResult = {
  text: string;
  redaction_count: number;
};

const REDACTION_PATTERNS: Array<[RegExp, string]> = [
  [/\bsk-[A-Za-z0-9]{20,}\b/g, "[REDACTED_API_KEY]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]"],
  [/\b(?:xoxb|xoxp|xoxa)-[A-Za-z0-9-]{16,}\b/g, "[REDACTED_SLACK_TOKEN]"],
  [/\b(Bearer\s+)[A-Za-z0-9._-]{12,}\b/gi, "$1[REDACTED_BEARER]"],
  [
    /\b((?:api[_-]?key|token|secret|password)\s*[:=]\s*)(["']?)[^"'\s\n]+(\2)/gi,
    "$1$2[REDACTED]$3"
  ]
];

export function redactSensitiveText(input: string): RedactionResult {
  let out = input;
  let count = 0;
  for (const [pattern, replacement] of REDACTION_PATTERNS) {
    const before = out;
    out = out.replace(pattern, replacement);
    if (out !== before) {
      // Count matches from the previous text for deterministic redaction counts.
      const matches = before.match(pattern);
      count += matches?.length ?? 0;
    }
  }
  return { text: out, redaction_count: count };
}

export function redactJsonValue(input: unknown): { value: unknown; redaction_count: number } {
  if (typeof input === "string") {
    const redacted = redactSensitiveText(input);
    return { value: redacted.text, redaction_count: redacted.redaction_count };
  }
  if (Array.isArray(input)) {
    let count = 0;
    const next = input.map((v) => {
      const out = redactJsonValue(v);
      count += out.redaction_count;
      return out.value;
    });
    return { value: next, redaction_count: count };
  }
  if (input && typeof input === "object") {
    let count = 0;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      const redacted = redactJsonValue(v);
      out[k] = redacted.value;
      count += redacted.redaction_count;
    }
    return { value: out, redaction_count: count };
  }
  return { value: input, redaction_count: 0 };
}
