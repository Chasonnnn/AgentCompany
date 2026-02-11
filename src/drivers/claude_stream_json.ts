function asObject(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function collectText(value: unknown, depth = 0): string[] {
  if (depth > 8) return [];
  if (typeof value === "string") {
    const s = value.trim();
    return s.length ? [value] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((v) => collectText(v, depth + 1));
  }
  const obj = asObject(value);
  if (!obj) return [];

  const out: string[] = [];
  if (typeof obj.text === "string" && obj.text.trim().length) out.push(obj.text);
  if (typeof obj.result === "string" && obj.result.trim().length) out.push(obj.result);
  if (typeof obj.output_text === "string" && obj.output_text.trim().length) out.push(obj.output_text);
  if (typeof obj.completion === "string" && obj.completion.trim().length) out.push(obj.completion);
  if (typeof obj.content === "string" && obj.content.trim().length) out.push(obj.content);
  if ("content" in obj) out.push(...collectText(obj.content, depth + 1));
  if ("delta" in obj) out.push(...collectText(obj.delta, depth + 1));
  if ("message" in obj) out.push(...collectText(obj.message, depth + 1));
  if ("result" in obj) out.push(...collectText(obj.result, depth + 1));
  return out;
}

function bestFromFragments(parts: string[]): string {
  const cleaned = parts.map((p) => p.trimEnd()).filter((p) => p.trim().length > 0);
  if (cleaned.length === 0) return "";
  let longest = cleaned[0];
  for (const p of cleaned.slice(1)) {
    if (p.length > longest.length) longest = p;
  }
  if (longest.length >= 200 || cleaned.length === 1) return longest;
  return cleaned.join("");
}

export function extractClaudeMarkdownFromStreamJson(raw: string): string {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const finalLike: string[] = [];
  const fragments: string[] = [];

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const obj = asObject(parsed);
    if (!obj) continue;
    const texts = collectText(obj);
    if (!texts.length) continue;

    const t = typeof obj.type === "string" ? obj.type : "";
    const isFinalLike =
      /result|final|complete|completed|message_stop/i.test(t) ||
      "result" in obj ||
      "completion" in obj ||
      "output_text" in obj;
    if (isFinalLike) finalLike.push(...texts);
    else fragments.push(...texts);
  }

  const picked = bestFromFragments(finalLike);
  if (picked.trim().length) return picked;

  const fallback = bestFromFragments(fragments);
  if (fallback.trim().length) return fallback;

  throw new Error("Unable to extract final markdown from Claude stream-json output.");
}
