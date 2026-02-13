import { GEMINI_CAPABILITIES } from "../drivers/gemini.js";
import type { AdapterStatus } from "./types.js";

export function geminiCliAdapterStatus(available: boolean, reason?: string): AdapterStatus {
  return {
    name: "gemini_cli",
    provider: "gemini",
    mode: "cli",
    available,
    reason,
    capabilities: GEMINI_CAPABILITIES
  };
}

