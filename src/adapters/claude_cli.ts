import { CLAUDE_CAPABILITIES } from "../drivers/claude.js";
import type { AdapterStatus } from "./types.js";

export function claudeCliAdapterStatus(available: boolean, reason?: string): AdapterStatus {
  return {
    name: "claude_cli",
    provider: "claude",
    mode: "cli",
    available,
    reason,
    capabilities: CLAUDE_CAPABILITIES
  };
}

