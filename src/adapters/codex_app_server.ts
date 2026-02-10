import type { AdapterStatus } from "./types.js";
import { CODEX_CAPABILITIES } from "../drivers/codex.js";

export const CODEX_APP_SERVER_CAPABILITIES = {
  ...CODEX_CAPABILITIES,
  supports_resumable_session: true,
  supports_streaming_events: true,
  supports_structured_output: true
} as const;

export function codexAppServerAdapterStatus(available: boolean, reason?: string): AdapterStatus {
  return {
    name: "codex_app_server",
    provider: "codex",
    mode: "protocol",
    available,
    reason,
    capabilities: CODEX_APP_SERVER_CAPABILITIES
  };
}

