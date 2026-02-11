import type { BuiltCommand, DriverCapabilities } from "./types.js";

export const CLAUDE_CAPABILITIES: DriverCapabilities = {
  supports_streaming_events: true, // --output-format=stream-json
  // Our v0 command uses --no-session-persistence, so resuming is not supported in practice.
  supports_resumable_session: false,
  supports_structured_output: true, // --json-schema
  supports_token_usage: true,
  supports_patch_export: false,
  supports_interactive_approval_callbacks: false,
  supports_worktree_isolation: "unsupported"
};

export function buildClaudePrintCommand(args: {
  bin: string;
  prompt: string;
  model?: string;
  outputs_dir_abs: string;
}): BuiltCommand {
  const argv: string[] = [
    args.bin,
    "--print",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--no-session-persistence",
    "--permission-mode",
    "dontAsk",
    "--tools",
    "",
    args.prompt
  ];
  if (args.model) {
    argv.splice(1, 0, "--model", args.model);
  }
  return {
    argv,
    final_text_parser: "claude_stream_json"
  };
}
