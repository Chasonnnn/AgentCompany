import path from "node:path";
import type { BuiltCommand, DriverCapabilities } from "./types.js";

export const CODEX_CAPABILITIES: DriverCapabilities = {
  supports_streaming_events: true, // codex exec --json
  supports_resumable_session: true, // codex resume/fork exist
  supports_structured_output: true, // output schema + last message
  supports_token_usage: false,
  supports_patch_export: true,
  supports_interactive_approval_callbacks: false,
  supports_worktree_isolation: "recommended"
};

export function buildCodexExecCommand(args: {
  bin: string;
  prompt: string;
  model?: string;
  outputs_dir_abs: string;
}): BuiltCommand {
  const lastMessagePath = path.join(args.outputs_dir_abs, "last_message.md");

  const argv: string[] = [
    args.bin,
    "exec",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--color",
    "never",
    "--output-last-message",
    lastMessagePath,
    "--json",
    "-"
  ];
  if (args.model) {
    argv.splice(2, 0, "--model", args.model);
  }

  return {
    argv,
    stdin_text: args.prompt,
    final_text_file_abs: lastMessagePath
  };
}

