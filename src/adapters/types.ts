import type { DriverCapabilities } from "../drivers/types.js";

export type AdapterName = "codex_app_server" | "codex_cli" | "claude_cli" | "gemini_cli";

export type AdapterStatus = {
  name: AdapterName;
  provider: "codex" | "claude" | "gemini";
  mode: "protocol" | "cli";
  available: boolean;
  reason?: string;
  capabilities: DriverCapabilities;
};
