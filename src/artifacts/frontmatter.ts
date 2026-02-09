import YAML from "yaml";

export type FrontMatterParseResult =
  | {
      ok: true;
      frontmatter: unknown;
      body: string;
    }
  | {
      ok: false;
      error: string;
    };

export function parseFrontMatter(markdown: string): FrontMatterParseResult {
  // Strict: front matter must be the very first thing in the file.
  if (!markdown.startsWith("---\n") && !markdown.startsWith("---\r\n")) {
    return { ok: false, error: "missing_frontmatter" };
  }

  // Find closing delimiter on its own line.
  const lines = markdown.split(/\r?\n/);
  if (lines.length < 3) return { ok: false, error: "frontmatter_unclosed" };
  if (lines[0] !== "---") return { ok: false, error: "frontmatter_invalid_start" };

  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) return { ok: false, error: "frontmatter_unclosed" };

  const fmText = lines.slice(1, endIdx).join("\n");
  let frontmatter: unknown;
  try {
    frontmatter = YAML.parse(fmText);
  } catch (e) {
    return { ok: false, error: `frontmatter_yaml_parse_error: ${(e as Error).message}` };
  }

  const body = lines.slice(endIdx + 1).join("\n");
  return { ok: true, frontmatter, body };
}

