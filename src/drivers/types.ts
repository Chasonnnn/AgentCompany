export type WorktreeIsolationSupport = "unsupported" | "recommended" | "required";

export type DriverCapabilities = {
  supports_streaming_events: boolean;
  supports_resumable_session: boolean;
  supports_structured_output: boolean;
  supports_token_usage: boolean;
  supports_patch_export: boolean;
  supports_interactive_approval_callbacks: boolean;
  supports_worktree_isolation: WorktreeIsolationSupport;
};

export type BuiltCommand = {
  argv: string[];
  env?: Record<string, string>;
  stdin_text?: string;
  // If set, read this file for the final model output; otherwise, use run outputs stdout.txt.
  final_text_file_abs?: string;
  // Optional parser hint for stdout/stderr output when providers emit structured streams.
  final_text_parser?: "claude_stream_json";
};
