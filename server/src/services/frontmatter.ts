import { load, YAMLException } from "js-yaml";
import { unprocessable } from "../errors.js";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface FrontmatterParseOptions {
  /**
   * Label inserted into the 422 error message thrown when the YAML payload
   * cannot be parsed. Lets callers produce context-specific messages like
   * "Invalid SKILL.md frontmatter: ..." without leaking js-yaml's internals.
   */
  errorLabel?: string;
}

export interface FrontmatterDoc {
  frontmatter: Record<string, unknown>;
  body: string;
}

function formatYamlError(err: unknown, label: string): string {
  if (err instanceof YAMLException) {
    const reason = err.reason?.trim() || err.message;
    return `Invalid ${label}: ${reason}`;
  }
  if (err instanceof Error && err.message) {
    return `Invalid ${label}: ${err.message}`;
  }
  return `Invalid ${label}: failed to parse YAML`;
}

/**
 * Parse a YAML frontmatter block into a plain record.
 *
 * Uses js-yaml's default (safe) schema: scalars, arrays, and maps only.
 * Unknown explicit tags (for example `!!python/object`, `!!js/function`)
 * raise a YAMLException which is rethrown as a 422 Unprocessable error.
 */
export function parseYamlFrontmatter(
  raw: string,
  options: FrontmatterParseOptions = {},
): Record<string, unknown> {
  if (!raw.trim()) return {};
  const label = options.errorLabel ?? "YAML frontmatter";
  let parsed: unknown;
  try {
    parsed = load(raw);
  } catch (err) {
    throw unprocessable(formatYamlError(err, label));
  }
  return isPlainRecord(parsed) ? parsed : {};
}

/**
 * Parse a standalone YAML document (no frontmatter delimiters).
 * Shares the safe schema and error handling with `parseYamlFrontmatter`.
 */
export function parseYamlFile(
  raw: string,
  options: FrontmatterParseOptions = {},
): Record<string, unknown> {
  return parseYamlFrontmatter(raw, {
    errorLabel: options.errorLabel ?? "YAML file",
  });
}

/**
 * Split a markdown document into its leading YAML frontmatter block and body.
 * Only the first `---`-delimited block is interpreted as frontmatter, so any
 * subsequent `---` separators inside the body are preserved verbatim.
 */
export function parseFrontmatterMarkdown(
  raw: string,
  options: FrontmatterParseOptions = {},
): FrontmatterDoc {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { frontmatter: {}, body: normalized.trim() };
  }
  const closing = normalized.indexOf("\n---\n", 4);
  if (closing < 0) {
    return { frontmatter: {}, body: normalized.trim() };
  }
  const frontmatterRaw = normalized.slice(4, closing).trim();
  const body = normalized.slice(closing + 5).trim();
  return {
    frontmatter: parseYamlFrontmatter(frontmatterRaw, options),
    body,
  };
}
