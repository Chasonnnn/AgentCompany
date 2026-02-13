import { z } from "zod";
import { ResultSpec, type ResultError, type ResultSpec as ResultSpecType } from "../schemas/result.js";
import type { JobSpec } from "../schemas/job.js";

function zodIssueText(issue: z.ZodIssue): string {
  const path = issue.path.length ? `${issue.path.join(".")}: ` : "";
  return `${path}${issue.message}`;
}

function extractMarkdownCodeFence(raw: string): string[] {
  const matches = [...raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  return matches.map((m) => (m[1] ?? "").trim()).filter(Boolean);
}

function tryParseJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sanitizeJsonLike(text: string): string {
  return text
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/^\uFEFF/, "")
    .trim();
}

function tryParseJsonLenient(text: string): unknown | null {
  const strict = tryParseJson(text);
  if (strict !== null) return strict;
  const sanitized = sanitizeJsonLike(text);
  if (!sanitized) return null;
  return tryParseJson(sanitized);
}

function extractBalancedJsonObjects(raw: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}") {
      depth = Math.max(0, depth - 1);
      if (depth === 0 && start >= 0) {
        out.push(raw.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return out;
}

function collectJsonCandidates(rawText: string): unknown[] {
  const candidates: string[] = [];
  const trimmed = rawText.trim();
  if (trimmed.length) candidates.push(trimmed);
  candidates.push(...extractMarkdownCodeFence(rawText));
  candidates.push(...extractBalancedJsonObjects(rawText));

  const out: unknown[] = [];
  for (const text of candidates) {
    const parsed = tryParseJsonLenient(text);
    if (parsed === null) continue;
    out.push(...extractStructuredPayloadCandidates(parsed), parsed);
  }
  return out;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function looksLikeResultCandidate(v: unknown): boolean {
  const obj = asRecord(v);
  if (!obj) return false;
  if (obj.type === "result") return true;
  return (
    ("status" in obj && "summary" in obj) ||
    ("job_id" in obj && "attempt_run_id" in obj) ||
    ("files_changed" in obj && "commands_run" in obj && "artifacts" in obj)
  );
}

function extractStructuredPayloadCandidates(value: unknown, depth = 0): unknown[] {
  if (depth > 6) return [];
  if (typeof value === "string") {
    const parsed = tryParseJsonLenient(value);
    if (parsed === null) return [];
    return [parsed, ...extractStructuredPayloadCandidates(parsed, depth + 1)];
  }
  if (Array.isArray(value)) {
    return value.flatMap((v) => extractStructuredPayloadCandidates(v, depth + 1));
  }
  const obj = asRecord(value);
  if (!obj) return [];
  const out: unknown[] = [];
  const keys = [
    "structured_output",
    "result",
    "response",
    "payload",
    "data",
    "output",
    "message",
    "content"
  ];
  for (const key of keys) {
    if (!(key in obj)) continue;
    const nested = obj[key];
    out.push(nested);
    out.push(...extractStructuredPayloadCandidates(nested, depth + 1));
  }
  return out;
}

export function extractResultCandidate(rawText: string): unknown | null {
  const expanded = collectJsonCandidates(rawText);
  for (const candidate of expanded) {
    if (looksLikeResultCandidate(candidate)) return candidate;
  }
  for (const candidate of expanded) {
    if (asRecord(candidate)) return candidate;
  }
  return null;
}

export function extractGenericJsonObjectCandidate(rawText: string): unknown | null {
  const expanded = collectJsonCandidates(rawText);
  for (const candidate of expanded) {
    if (asRecord(candidate)) return candidate;
  }
  return null;
}

export function validateResultCandidate(args: {
  candidate: unknown;
  job_id: string;
  attempt_run_id: string;
}):
  | { ok: true; result: ResultSpecType }
  | { ok: false; errors: ResultError[] } {
  if (!args.candidate || typeof args.candidate !== "object" || Array.isArray(args.candidate)) {
    return {
      ok: false,
      errors: [
        {
          code: "result_not_object",
          message: "Result candidate is not a JSON object"
        }
      ]
    };
  }

  const normalized = {
    schema_version: 1,
    type: "result",
    ...args.candidate,
    job_id:
      typeof (args.candidate as Record<string, unknown>).job_id === "string"
        ? (args.candidate as Record<string, unknown>).job_id
        : args.job_id,
    attempt_run_id:
      typeof (args.candidate as Record<string, unknown>).attempt_run_id === "string"
        ? (args.candidate as Record<string, unknown>).attempt_run_id
        : args.attempt_run_id
  };

  const parsed = ResultSpec.safeParse(normalized);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => ({
        code: "result_schema_invalid",
        message: zodIssueText(issue)
      }))
    };
  }

  if (parsed.data.job_id !== args.job_id) {
    return {
      ok: false,
      errors: [
        {
          code: "result_job_id_mismatch",
          message: `result.job_id=${parsed.data.job_id} does not match expected job_id=${args.job_id}`
        }
      ]
    };
  }

  return { ok: true, result: parsed.data };
}

export function buildStrictJsonRepairPrompt(args: {
  job: JobSpec;
  attempt_run_id: string;
  previous_output: string;
  validation_errors: ResultError[];
}): string {
  const errors = args.validation_errors.map((e) => `- ${e.code}: ${e.message}`).join("\n");
  const preview = args.previous_output.slice(0, 8000);
  return [
    "Return JSON only. Do not include markdown fences or explanatory text.",
    "The JSON must match this strict schema:",
    JSON.stringify(
      {
        schema_version: 1,
        type: "result",
        job_id: args.job.job_id,
        attempt_run_id: args.attempt_run_id,
        status: "succeeded|needs_input|blocked|failed|canceled",
        summary: "string",
        files_changed: [{ path: "string", change_type: "added|modified|deleted|renamed", summary: "string?" }],
        commands_run: [{ command: "string", exit_code: 0, summary: "string?" }],
        artifacts: [{ relpath: "string", artifact_id: "string?", kind: "string?", sha256: "string?" }],
        next_actions: [{ action: "string", rationale: "string?" }],
        errors: [{ code: "string", message: "string", details: "string?" }]
      },
      null,
      2
    ),
    "",
    "Validation issues to fix:",
    errors || "- Unknown parse/shape failure",
    "",
    "Previous output:",
    preview
  ].join("\n");
}

export function buildCodexReformatPrompt(args: {
  job: JobSpec;
  attempt_run_id: string;
  previous_output: string;
  validation_errors: ResultError[];
}): string {
  return [
    "You are a strict JSON reformatter.",
    "Transform the input text into a valid ResultSpec JSON object.",
    "Do not invent repository facts. If unknown, keep arrays empty and explain in errors.",
    "",
    buildStrictJsonRepairPrompt({
      job: args.job,
      attempt_run_id: args.attempt_run_id,
      previous_output: args.previous_output,
      validation_errors: args.validation_errors
    })
  ].join("\n");
}

export function buildFallbackNeedsInputResult(args: {
  job_id: string;
  attempt_run_id: string;
  errors: ResultError[];
}): ResultSpecType {
  const summary =
    "Worker output could not be normalized into ResultSpec after deterministic repair retries.";
  return ResultSpec.parse({
    schema_version: 1,
    type: "result",
    job_id: args.job_id,
    attempt_run_id: args.attempt_run_id,
    status: "needs_input",
    summary,
    files_changed: [],
    commands_run: [],
    artifacts: [],
    next_actions: [
      {
        action: "Provide clearer worker instructions or manually supply a valid ResultSpec JSON payload.",
        rationale: "Normalization retries exhausted"
      }
    ],
    errors: args.errors.length
      ? args.errors
      : [
          {
            code: "result_unparseable",
            message: "Unable to parse worker output into JSON"
          }
        ]
  });
}
