import { CODEX_CAPABILITIES } from "../drivers/codex.js";
import type { AdapterStatus } from "./types.js";

export function codexCliAdapterStatus(available: boolean, reason?: string): AdapterStatus {
  return {
    name: "codex_cli",
    provider: "codex",
    mode: "cli",
    available,
    reason,
    capabilities: CODEX_CAPABILITIES
  };
}

