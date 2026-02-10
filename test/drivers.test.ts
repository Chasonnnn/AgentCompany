import { describe, expect, test } from "vitest";
import { buildCodexExecCommand } from "../src/drivers/codex.js";
import { buildClaudePrintCommand } from "../src/drivers/claude.js";

describe("driver command builders", () => {
  test("codex exec includes required flags and uses stdin + last_message file", () => {
    const cmd = buildCodexExecCommand({
      bin: "/bin/codex",
      prompt: "hello",
      outputs_dir_abs: "/tmp/outputs"
    });
    expect(cmd.argv[0]).toBe("/bin/codex");
    expect(cmd.argv.includes("exec")).toBe(true);
    expect(cmd.argv.includes("--json")).toBe(true);
    expect(cmd.argv.at(-1)).toBe("-");
    expect(cmd.argv.includes("--output-last-message")).toBe(true);
    expect(cmd.stdin_text).toBe("hello");
    expect(cmd.final_text_file_abs).toBe("/tmp/outputs/last_message.md");
  });

  test("codex supports optional model", () => {
    const cmd = buildCodexExecCommand({
      bin: "/bin/codex",
      prompt: "x",
      outputs_dir_abs: "/tmp/outputs",
      model: "gpt-5"
    });
    const i = cmd.argv.indexOf("--model");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(cmd.argv[i + 1]).toBe("gpt-5");
  });

  test("claude print includes safety/tool flags and embeds prompt as an arg", () => {
    const cmd = buildClaudePrintCommand({
      bin: "/bin/claude",
      prompt: "hi",
      outputs_dir_abs: "/tmp/outputs"
    });
    expect(cmd.argv[0]).toBe("/bin/claude");
    expect(cmd.argv.includes("--print")).toBe(true);
    expect(cmd.argv.includes("--output-format")).toBe(true);
    expect(cmd.argv.includes("text")).toBe(true);
    expect(cmd.argv.includes("--tools")).toBe(true);
    expect(cmd.argv.at(-1)).toBe("hi");
  });

  test("claude supports optional model", () => {
    const cmd = buildClaudePrintCommand({
      bin: "/bin/claude",
      prompt: "hi",
      outputs_dir_abs: "/tmp/outputs",
      model: "claude-3-7-sonnet-latest"
    });
    const i = cmd.argv.indexOf("--model");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(cmd.argv[i + 1]).toBe("claude-3-7-sonnet-latest");
  });
});

