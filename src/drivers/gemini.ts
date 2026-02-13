import type { BuiltCommand, DriverCapabilities } from "./types.js";

export const GEMINI_CAPABILITIES: DriverCapabilities = {
  supports_streaming_events: true,
  supports_resumable_session: false,
  supports_structured_output: true,
  supports_token_usage: false,
  supports_patch_export: false,
  supports_interactive_approval_callbacks: false,
  supports_worktree_isolation: "unsupported"
};

// Prefer deterministic JSON output for machine parsing and policy replay.
export function buildGeminiScaffoldCommand(args: {
  bin: string;
  prompt: string;
  model?: string;
  outputs_dir_abs: string;
}): BuiltCommand {
  const argv = [args.bin, "--output-format", "json"];
  if (args.model) argv.push("--model", args.model);
  argv.push("-p", args.prompt);
  return { argv };
}
