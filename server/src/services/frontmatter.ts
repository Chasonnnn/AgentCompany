import { CORE_SCHEMA, load, YAMLException } from "js-yaml";
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
 * Uses js-yaml's `CORE_SCHEMA` (YAML 1.2-compatible). Legitimate
 * `true`/`false`/`null`/int/float scalars are still coerced to their native
 * types, but the YAML 1.1 bool aliases (`yes`/`no`/`on`/`off`/`y`/`n`) and
 * auto-conversion of unquoted ISO 8601 dates stay as strings. Downstream
 * consumers (`asString`, `asBoolean`, ...) would silently drop values coerced
 * to `Date` or unexpected booleans, so keeping those as strings is what
 * actually matches the shared-parser contract.
 *
 * `load()` in js-yaml v4 is safe against code-exec-style tags regardless of
 * schema choice; unknown explicit tags (for example `!!python/object`,
 * `!!js/function`) raise a `YAMLException` which is rethrown as a 422
 * Unprocessable error.
 */
export function parseYamlFrontmatter(
  raw: string,
  options: FrontmatterParseOptions = {},
): Record<string, unknown> {
  if (!raw.trim()) return {};
  const label = options.errorLabel ?? "YAML frontmatter";
  let parsed: unknown;
  try {
    parsed = load(raw, { schema: CORE_SCHEMA });
  } catch (err) {
    throw unprocessable(formatYamlError(err, label));
  }
  return isPlainRecord(parsed) ? parsed : {};
}

/**
 * Parse a standalone YAML document (no frontmatter delimiters).
 * Shares the `CORE_SCHEMA` parser and error handling with
 * `parseYamlFrontmatter`.
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
