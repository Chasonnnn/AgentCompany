import { buildClaudePrintCommand, CLAUDE_CAPABILITIES } from "./claude.js";
import { buildCodexExecCommand, CODEX_CAPABILITIES } from "./codex.js";
import { buildGeminiScaffoldCommand, GEMINI_CAPABILITIES } from "./gemini.js";
import type { BuiltCommand, DriverCapabilities } from "./types.js";

export type DriverName = "codex" | "claude" | "gemini";

export type ResolvedDriver = {
  name: DriverName;
  capabilities: DriverCapabilities;
  buildArtifactFillCommand: (args: {
    bin: string;
    prompt: string;
    model?: string;
    outputs_dir_abs: string;
  }) => BuiltCommand;
};

export function resolveDriverName(provider: string): DriverName {
  switch (provider) {
    case "codex":
    case "codex_app_server":
    case "codex-app-server":
      return "codex";
    case "claude":
      return "claude";
    // Common aliases.
    case "claude_code":
    case "claude-code":
      return "claude";
    case "gemini":
    case "gemini_cli":
      return "gemini";
    default:
      throw new Error(
        `Unknown provider "${provider}". Supported: codex, codex_app_server, claude, gemini`
      );
  }
}

export function getDriver(name: DriverName): ResolvedDriver {
  switch (name) {
    case "codex":
      return {
        name,
        capabilities: CODEX_CAPABILITIES,
        buildArtifactFillCommand: buildCodexExecCommand
      };
    case "claude":
      return {
        name,
        capabilities: CLAUDE_CAPABILITIES,
        buildArtifactFillCommand: buildClaudePrintCommand
      };
    case "gemini":
      return {
        name,
        capabilities: GEMINI_CAPABILITIES,
        buildArtifactFillCommand: buildGeminiScaffoldCommand
      };
    default: {
      const _exhaustive: never = name;
      return _exhaustive;
    }
  }
}
