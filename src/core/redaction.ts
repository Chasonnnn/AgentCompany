export type RedactionResult = {
  text: string;
  redaction_count: number;
};

export type SensitivePatternKind =
  | "OPENAI_API_KEY"
  | "GITHUB_TOKEN"
  | "SLACK_TOKEN"
  | "BEARER_TOKEN"
  | "GENERIC_CREDENTIAL_ASSIGNMENT";

export type SensitiveTextMatchSummary = {
  total_matches: number;
  matches_by_kind: Record<SensitivePatternKind, number>;
};

type RedactionPattern = {
  kind: SensitivePatternKind;
  pattern: RegExp;
  replacement: string;
};

const REDACTION_PATTERNS: readonly RedactionPattern[] = [
  { kind: "OPENAI_API_KEY", pattern: /\bsk-[A-Za-z0-9]{20,}\b/g, replacement: "[REDACTED_API_KEY]" },
  {
    kind: "GITHUB_TOKEN",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
    replacement: "[REDACTED_GITHUB_TOKEN]"
  },
  {
    kind: "SLACK_TOKEN",
    pattern: /\b(?:xoxb|xoxp|xoxa)-[A-Za-z0-9-]{16,}\b/g,
    replacement: "[REDACTED_SLACK_TOKEN]"
  },
  {
    kind: "BEARER_TOKEN",
    pattern: /\b(Bearer\s+)[A-Za-z0-9._-]{12,}\b/gi,
    replacement: "$1[REDACTED_BEARER]"
  },
  {
    kind: "GENERIC_CREDENTIAL_ASSIGNMENT",
    pattern: /\b((?:api[_-]?key|token|secret|password)\s*[:=]\s*)(["']?)[^"'\s\n]+(\2)/gi,
    replacement: "$1$2[REDACTED]$3"
  }
];

function emptyMatchCounts(): Record<SensitivePatternKind, number> {
  return {
    OPENAI_API_KEY: 0,
    GITHUB_TOKEN: 0,
    SLACK_TOKEN: 0,
    BEARER_TOKEN: 0,
    GENERIC_CREDENTIAL_ASSIGNMENT: 0
  };
}

function countMatches(input: string, pattern: RegExp): number {
  const matches = input.match(pattern);
  return matches?.length ?? 0;
}

export function detectSensitiveText(input: string): SensitiveTextMatchSummary {
  const counts = emptyMatchCounts();
  let totalMatches = 0;
  for (const { kind, pattern } of REDACTION_PATTERNS) {
    const count = countMatches(input, pattern);
    counts[kind] += count;
    totalMatches += count;
  }
  return { total_matches: totalMatches, matches_by_kind: counts };
}

export function countSensitiveTextMatches(input: string): number {
  return detectSensitiveText(input).total_matches;
}

export function redactSensitiveText(input: string): RedactionResult {
  let out = input;
  let count = 0;
  for (const { pattern, replacement } of REDACTION_PATTERNS) {
    const before = out;
    out = out.replace(pattern, replacement);
    if (out !== before) {
      count += countMatches(before, pattern);
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

export class SensitiveTextError extends Error {
  readonly reason_code = "SECRET_DETECTED" as const;
  readonly context_label: string;
  readonly total_matches: number;
  readonly matches_by_kind: Record<SensitivePatternKind, number>;

  constructor(args: { context_label: string; summary: SensitiveTextMatchSummary }) {
    super(
      `Detected ${args.summary.total_matches} sensitive token match(es) in ${args.context_label}. Remove or sanitize secrets before submitting this memory change.`
    );
    this.name = "SensitiveTextError";
    this.context_label = args.context_label;
    this.total_matches = args.summary.total_matches;
    this.matches_by_kind = args.summary.matches_by_kind;
  }
}

export function isSensitiveTextError(input: unknown): input is SensitiveTextError {
  return input instanceof SensitiveTextError;
}

export function sensitiveTextErrorData(err: SensitiveTextError): {
  reason_code: "SECRET_DETECTED";
  context_label: string;
  total_matches: number;
  matches_by_kind: Record<SensitivePatternKind, number>;
} {
  return {
    reason_code: err.reason_code,
    context_label: err.context_label,
    total_matches: err.total_matches,
    matches_by_kind: err.matches_by_kind
  };
}

export function assertNoSensitiveText(input: string, contextLabel: string): void {
  const summary = detectSensitiveText(input);
  if (summary.total_matches <= 0) return;
  throw new SensitiveTextError({ context_label: contextLabel, summary });
}
