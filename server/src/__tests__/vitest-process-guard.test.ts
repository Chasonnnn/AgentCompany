import { describe, expect, it } from "vitest";
import {
  findTrackedProcessLeaks,
  isTrackedProcessCommand,
} from "../../../scripts/vitest-process-guard.mjs";

describe("vitest process guard", () => {
  it("matches Paperclip server and local adapter commands", () => {
    expect(isTrackedProcessCommand("node /Users/chason/paperclip/server/dist/index.js")).toBe(true);
    expect(
      isTrackedProcessCommand(
        "/Users/chason/.local/bin/claude --print - --output-format stream-json --verbose --append-system-prompt-file /tmp/paperclip-skills-123/agent-instructions.md",
      ),
    ).toBe(true);
    expect(isTrackedProcessCommand("/opt/homebrew/bin/codex exec --json -")).toBe(true);
    expect(isTrackedProcessCommand("/opt/homebrew/bin/codex app-server")).toBe(true);
    expect(isTrackedProcessCommand("/usr/local/bin/gemini --output-format stream-json --prompt hello")).toBe(true);
    expect(isTrackedProcessCommand("/usr/local/bin/agent -p --mode ask --output-format json hello")).toBe(true);
    expect(isTrackedProcessCommand("/usr/local/bin/opencode run --format json")).toBe(true);
    expect(isTrackedProcessCommand("/usr/local/bin/pi --mode json -p hello")).toBe(true);
    expect(isTrackedProcessCommand("/usr/bin/node unrelated-script.js")).toBe(false);
  });

  it("ignores codex desktop chronicle memgen processes", () => {
    expect(
      isTrackedProcessCommand(
        '/opt/homebrew/bin/codex exec - --config model_provider="openai-memgen" --cd /var/folders/c7/6l609_kn28g79m0_9klfr8z80000gn/T/chronicle/screen_recording',
      ),
    ).toBe(false);
  });

  it("reports only newly introduced tracked processes", () => {
    const processes = [
      {
        pid: 101,
        pgid: 101,
        ppid: 1,
        etime: "00:10",
        command: "node /Users/chason/paperclip/server/dist/index.js",
      },
      {
        pid: 202,
        pgid: 202,
        ppid: 1,
        etime: "00:05",
        command: "/Users/chason/.local/bin/claude --print - --output-format stream-json --verbose",
      },
    ];

    const leaked = findTrackedProcessLeaks(new Set([101]), processes);

    expect(leaked).toHaveLength(1);
    expect(leaked[0]?.pid).toBe(202);
  });
});
