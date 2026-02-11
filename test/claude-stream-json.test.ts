import { describe, expect, test } from "vitest";
import { extractClaudeMarkdownFromStreamJson } from "../src/drivers/claude_stream_json.js";

describe("claude stream-json parser", () => {
  test("prefers final result payload when available", () => {
    const raw = [
      JSON.stringify({ type: "assistant.delta", delta: { text: "# Temp" } }),
      JSON.stringify({
        type: "result",
        result: {
          content: [{ type: "text", text: "---\nschema_version: 1\n---\n\n# Final\n\n## Summary\n\nok" }]
        }
      })
    ].join("\n");
    const out = extractClaudeMarkdownFromStreamJson(raw);
    expect(out).toContain("# Final");
    expect(out).not.toContain("# Temp");
  });

  test("falls back to concatenated delta text when no final event exists", () => {
    const raw = [
      JSON.stringify({ type: "assistant.delta", delta: { text: "---\n" } }),
      JSON.stringify({ type: "assistant.delta", delta: { text: "schema_version: 1\n---\n\n" } }),
      JSON.stringify({ type: "assistant.delta", delta: { text: "# Title\n\n## Summary\n\nok\n" } })
    ].join("\n");
    const out = extractClaudeMarkdownFromStreamJson(raw);
    expect(out).toContain("# Title");
    expect(out).toContain("## Summary");
  });
});
