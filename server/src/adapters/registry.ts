import type { ServerAdapterModule } from "./types.js";
import { getAdapterSessionManagement } from "@paperclipai/adapter-utils";
import {
  execute as claudeExecute,
  listClaudeSkills,
  syncClaudeSkills,
  listClaudeModels,
  testEnvironment as claudeTestEnvironment,
  sessionCodec as claudeSessionCodec,
  getQuotaWindows as claudeGetQuotaWindows,
} from "@paperclipai/adapter-claude-local/server";
import { agentConfigurationDoc as claudeAgentConfigurationDoc, models as claudeModels } from "@paperclipai/adapter-claude-local";
import {
  execute as codexExecute,
  listCodexSkills,
  syncCodexSkills,
  testEnvironment as codexTestEnvironment,
  sessionCodec as codexSessionCodec,
  getQuotaWindows as codexGetQuotaWindows,
} from "@paperclipai/adapter-codex-local/server";
import { agentConfigurationDoc as codexAgentConfigurationDoc, models as codexModels } from "@paperclipai/adapter-codex-local";
import {
  execute as cursorExecute,
  listCursorSkills,
  syncCursorSkills,
  testEnvironment as cursorTestEnvironment,
  sessionCodec as cursorSessionCodec,
} from "@paperclipai/adapter-cursor-local/server";
import { agentConfigurationDoc as cursorAgentConfigurationDoc, models as cursorModels } from "@paperclipai/adapter-cursor-local";
import {
  execute as geminiExecute,
  listGeminiSkills,
  syncGeminiSkills,
  testEnvironment as geminiTestEnvironment,
  sessionCodec as geminiSessionCodec,
} from "@paperclipai/adapter-gemini-local/server";
import { agentConfigurationDoc as geminiAgentConfigurationDoc, models as geminiModels } from "@paperclipai/adapter-gemini-local";
import {
  execute as openCodeExecute,
  listOpenCodeSkills,
  syncOpenCodeSkills,
  testEnvironment as openCodeTestEnvironment,
  sessionCodec as openCodeSessionCodec,
  listOpenCodeModels,
} from "@paperclipai/adapter-opencode-local/server";
import {
  agentConfigurationDoc as openCodeAgentConfigurationDoc,
  models as openCodeModels,
} from "@paperclipai/adapter-opencode-local";
import {
  execute as openclawGatewayExecute,
  testEnvironment as openclawGatewayTestEnvironment,
} from "@paperclipai/adapter-openclaw-gateway/server";
import {
  agentConfigurationDoc as openclawGatewayAgentConfigurationDoc,
  models as openclawGatewayModels,
} from "@paperclipai/adapter-openclaw-gateway";
import { listCodexModels } from "./codex-models.js";
import { listCursorModels } from "./cursor-models.js";
import {
  execute as piExecute,
  listPiSkills,
  syncPiSkills,
  testEnvironment as piTestEnvironment,
  sessionCodec as piSessionCodec,
  listPiModels,
} from "@paperclipai/adapter-pi-local/server";
import {
  agentConfigurationDoc as piAgentConfigurationDoc,
} from "@paperclipai/adapter-pi-local";
import {
  execute as hermesExecute,
  testEnvironment as hermesTestEnvironment,
  sessionCodec as hermesSessionCodec,
  listSkills as hermesListSkills,
  syncSkills as hermesSyncSkills,
  detectModel as detectModelFromHermes,
} from "hermes-paperclip-adapter/server";
import {
  agentConfigurationDoc as hermesAgentConfigurationDoc,
  models as hermesModels,
} from "hermes-paperclip-adapter";
import { BUILTIN_ADAPTER_TYPES } from "./builtin-adapter-types.js";
import { buildExternalAdapters } from "./plugin-loader.js";
import { getDisabledAdapterTypes } from "../services/adapter-plugin-store.js";
import { processAdapter } from "./process/index.js";
import { httpAdapter } from "./http/index.js";

const guardedProcessAdapter: ServerAdapterModule = {
  ...processAdapter,
  agentConfigurationDoc: `# process agent configuration

Adapter: process

Safety:
- unsafeAllowLocalExecution (boolean, required): must be true or the adapter fails closed before spawning anything
- This adapter is intended for explicitly trusted local development only

Core fields:
- command (string, required): command to execute
- args (string[] | string, optional): command arguments
- cwd (string, optional): absolute working directory
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds
`,
};

const guardedHttpAdapter: ServerAdapterModule = {
  ...httpAdapter,
  agentConfigurationDoc: `# http agent configuration

Adapter: http

Safety:
- Only absolute http:// and https:// endpoints are accepted
- HTTPS is required for non-loopback targets
- Loopback http:// targets are only allowed in local_trusted mode
- Local, private, link-local, metadata, multicast, and reserved targets are blocked

Core fields:
- url (string, required): endpoint to invoke
- method (string, optional): HTTP method, default POST
- headers (object, optional): request headers
- payloadTemplate (object, optional): JSON payload template
- timeoutMs (number, optional): request timeout in milliseconds
`,
};

const claudeLocalAdapter: ServerAdapterModule = {
  type: "claude_local",
  execute: claudeExecute,
  testEnvironment: claudeTestEnvironment,
  listSkills: listClaudeSkills,
  syncSkills: syncClaudeSkills,
  sessionCodec: claudeSessionCodec,
  sessionManagement: getAdapterSessionManagement("claude_local") ?? undefined,
  models: claudeModels,
  listModels: listClaudeModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: false,
  // Claude can emit AskUserQuestion tool-use in the --print runner and Paperclip
  // captures that back into persisted decision-question artifacts. Host settings
  // such as skipAutoPermissionPrompt=true can still suppress native question UI.
  nativeDecisionQuestions: true,
  agentConfigurationDoc: claudeAgentConfigurationDoc,
  getQuotaWindows: claudeGetQuotaWindows,
};

const codexLocalAdapter: ServerAdapterModule = {
  type: "codex_local",
  execute: codexExecute,
  testEnvironment: codexTestEnvironment,
  listSkills: listCodexSkills,
  syncSkills: syncCodexSkills,
  sessionCodec: codexSessionCodec,
  sessionManagement: getAdapterSessionManagement("codex_local") ?? undefined,
  models: codexModels,
  listModels: listCodexModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: false,
  nativePlanningMode: true,
  nativeDecisionQuestions: true,
  agentConfigurationDoc: codexAgentConfigurationDoc,
  getQuotaWindows: codexGetQuotaWindows,
};

const cursorLocalAdapter: ServerAdapterModule = {
  type: "cursor",
  execute: cursorExecute,
  testEnvironment: cursorTestEnvironment,
  listSkills: listCursorSkills,
  syncSkills: syncCursorSkills,
  sessionCodec: cursorSessionCodec,
  sessionManagement: getAdapterSessionManagement("cursor") ?? undefined,
  models: cursorModels,
  listModels: listCursorModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: true,
  agentConfigurationDoc: cursorAgentConfigurationDoc,
};

const geminiLocalAdapter: ServerAdapterModule = {
  type: "gemini_local",
  execute: geminiExecute,
  testEnvironment: geminiTestEnvironment,
  listSkills: listGeminiSkills,
  syncSkills: syncGeminiSkills,
  sessionCodec: geminiSessionCodec,
  sessionManagement: getAdapterSessionManagement("gemini_local") ?? undefined,
  models: geminiModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: true,
  nativeDecisionQuestions: true,
  agentConfigurationDoc: geminiAgentConfigurationDoc,
};

const openclawGatewayAdapter: ServerAdapterModule = {
  type: "openclaw_gateway",
  execute: openclawGatewayExecute,
  testEnvironment: openclawGatewayTestEnvironment,
  models: openclawGatewayModels,
  supportsLocalAgentJwt: false,
  supportsInstructionsBundle: false,
  requiresMaterializedRuntimeSkills: false,
  agentConfigurationDoc: openclawGatewayAgentConfigurationDoc,
};

const openCodeLocalAdapter: ServerAdapterModule = {
  type: "opencode_local",
  execute: openCodeExecute,
  testEnvironment: openCodeTestEnvironment,
  listSkills: listOpenCodeSkills,
  syncSkills: syncOpenCodeSkills,
  sessionCodec: openCodeSessionCodec,
  models: openCodeModels,
  sessionManagement: getAdapterSessionManagement("opencode_local") ?? undefined,
  listModels: listOpenCodeModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: true,
  agentConfigurationDoc: openCodeAgentConfigurationDoc,
};

const piLocalAdapter: ServerAdapterModule = {
  type: "pi_local",
  execute: piExecute,
  testEnvironment: piTestEnvironment,
  listSkills: listPiSkills,
  syncSkills: syncPiSkills,
  sessionCodec: piSessionCodec,
  sessionManagement: getAdapterSessionManagement("pi_local") ?? undefined,
  models: [],
  listModels: listPiModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: true,
  agentConfigurationDoc: piAgentConfigurationDoc,
};

const hermesLocalAdapter: ServerAdapterModule = {
  type: "hermes_local",
  execute: hermesExecute,
  testEnvironment: hermesTestEnvironment,
  sessionCodec: hermesSessionCodec,
  listSkills: hermesListSkills,
  syncSkills: hermesSyncSkills,
  models: hermesModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: false,
  agentConfigurationDoc: hermesAgentConfigurationDoc,
  detectModel: () => detectModelFromHermes(),
};

const adaptersByType = new Map<string, ServerAdapterModule>();

// For builtin types that are overridden by an external adapter, we keep the
// original builtin so it can be restored when the override is deactivated.
const builtinFallbacks = new Map<string, ServerAdapterModule>();

// Tracks which override types are currently deactivated (paused).  When
// paused, `getServerAdapter()` returns the builtin fallback instead of the
// external.  Persisted across reloads via the same disabled-adapters store.
const pausedOverrides = new Set<string>();

function registerBuiltInAdapters() {
  for (const adapter of [
    claudeLocalAdapter,
    codexLocalAdapter,
    openCodeLocalAdapter,
    piLocalAdapter,
    cursorLocalAdapter,
    geminiLocalAdapter,
    openclawGatewayAdapter,
    hermesLocalAdapter,
    guardedProcessAdapter,
    guardedHttpAdapter,
  ]) {
    adaptersByType.set(adapter.type, adapter);
  }
}

registerBuiltInAdapters();

export function resetServerAdaptersForTests(): void {
  adaptersByType.clear();
  builtinFallbacks.clear();
  pausedOverrides.clear();
  registerBuiltInAdapters();
}

// ---------------------------------------------------------------------------
// Load external adapter plugins (e.g. droid_local)
//
// External adapter packages export createServerAdapter() which returns a
// ServerAdapterModule. When the module provides its own sessionManagement
// it is preserved; otherwise the host falls back to the built-in registry
// lookup (so externals that override a built-in type inherit the builtin's
// policy). This brings init-time registration to at-least-as-good behavior
// as the hot-install path (routes/adapters.ts:179 -> registerServerAdapter):
// both preserve module-provided sessionManagement, and init-time additionally
// applies the registry fallback for externals overriding a built-in type.
// ---------------------------------------------------------------------------

/** Cached sync wrapper — the store is a simple JSON file read, safe to call frequently. */
function getDisabledAdapterTypesFromStore(): string[] {
  return getDisabledAdapterTypes();
}

/**
 * Merge an external adapter module with host-provided session management.
 *
 * Module-provided `sessionManagement` takes precedence. When absent, fall
 * back to the hardcoded registry keyed by adapter type (so externals that
 * override a built-in — same `type` — inherit the builtin's policy). If
 * neither is available, `sessionManagement` remains `undefined`.
 *
 * Exported for unit tests; runtime callers use the IIFE below, which
 * applies this transformation during the external-adapter load pass.
 */
export function resolveExternalAdapterRegistration(
  externalAdapter: ServerAdapterModule,
): ServerAdapterModule {
  return {
    ...externalAdapter,
    sessionManagement:
      externalAdapter.sessionManagement
        ?? getAdapterSessionManagement(externalAdapter.type)
        ?? undefined,
  };
}

/**
 * Load external adapters from the plugin store and hardcoded sources.
 * Called once at module initialization. The promise is exported so that
 * callers (e.g. assertKnownAdapterType, app startup) can await completion
 * and avoid racing against the loading window.
 */
const externalAdaptersReady: Promise<void> = (async () => {
  try {
    const externalAdapters = await buildExternalAdapters();
    for (const externalAdapter of externalAdapters) {
      const overriding = BUILTIN_ADAPTER_TYPES.has(externalAdapter.type);
      if (overriding) {
        console.log(
          `[paperclip] External adapter "${externalAdapter.type}" overrides built-in adapter`,
        );
        // Save the original builtin for later restoration.
        const existing = adaptersByType.get(externalAdapter.type);
        if (existing && !builtinFallbacks.has(externalAdapter.type)) {
          builtinFallbacks.set(externalAdapter.type, existing);
        }
      }
      adaptersByType.set(
        externalAdapter.type,
        resolveExternalAdapterRegistration(externalAdapter),
      );
    }
  } catch (err) {
    console.error("[paperclip] Failed to load external adapters:", err);
  }
})();

/**
 * Await this before validating adapter types to avoid race conditions
 * during server startup. External adapters are loaded asynchronously;
 * calling assertKnownAdapterType before this resolves will reject
 * valid external adapter types.
 */
export function waitForExternalAdapters(): Promise<void> {
  return externalAdaptersReady;
}

export function registerServerAdapter(adapter: ServerAdapterModule): void {
  if (BUILTIN_ADAPTER_TYPES.has(adapter.type) && !builtinFallbacks.has(adapter.type)) {
    const existing = adaptersByType.get(adapter.type);
    if (existing) {
      builtinFallbacks.set(adapter.type, existing);
    }
  }
  adaptersByType.set(adapter.type, adapter);
}

export function unregisterServerAdapter(type: string): void {
  if (type === processAdapter.type || type === httpAdapter.type) return;
  if (builtinFallbacks.has(type)) {
    pausedOverrides.delete(type);
    const fallback = builtinFallbacks.get(type);
    if (fallback) {
      adaptersByType.set(type, fallback);
    }
    return;
  }
  if (BUILTIN_ADAPTER_TYPES.has(type)) {
    return;
  }
  adaptersByType.delete(type);
}

export function requireServerAdapter(type: string): ServerAdapterModule {
  const adapter = findActiveServerAdapter(type);
  if (!adapter) {
    throw new Error(`Unknown adapter type: ${type}`);
  }
  return adapter;
}

export function getServerAdapter(type: string): ServerAdapterModule {
  return findActiveServerAdapter(type) ?? guardedProcessAdapter;
}

export async function listAdapterModels(type: string): Promise<{ id: string; label: string }[]> {
  const adapter = findActiveServerAdapter(type);
  if (!adapter) return [];
  if (adapter.listModels) {
    const discovered = await adapter.listModels();
    if (discovered.length > 0) return discovered;
  }
  return adapter.models ?? [];
}

export function listServerAdapters(): ServerAdapterModule[] {
  return Array.from(adaptersByType.values());
}

/**
 * List adapters excluding those that are disabled in settings.
 * Used for menus and agent creation flows — disabled adapters remain
 * functional for existing agents but hidden from selection.
 */
export function listEnabledServerAdapters(): ServerAdapterModule[] {
  const disabled = getDisabledAdapterTypesFromStore();
  const disabledSet = disabled.length > 0 ? new Set(disabled) : null;
  return disabledSet
    ? Array.from(adaptersByType.values()).filter((a) => !disabledSet.has(a.type))
    : Array.from(adaptersByType.values());
}

export async function detectAdapterModel(
  type: string,
): Promise<{ model: string; provider: string; source: string; candidates?: string[] } | null> {
  const adapter = findActiveServerAdapter(type);
  if (!adapter?.detectModel) return null;
  const detected = await adapter.detectModel();
  if (!detected) return null;
  return {
    model: detected.model,
    provider: detected.provider,
    source: detected.source,
    ...(detected.candidates?.length ? { candidates: detected.candidates } : {}),
  };
}

// ---------------------------------------------------------------------------
// Override pause / resume
// ---------------------------------------------------------------------------

/**
 * Pause or resume an external override for a builtin adapter type.
 *
 * - `paused = true`  → subsequent calls to `getServerAdapter(type)` return
 *   the builtin fallback instead of the external adapter.  Already-running
 *   agent sessions are unaffected (they hold a reference to the module they
 *   started with).
 *
 * - `paused = false` → the external adapter is active again.
 *
 * Returns `true` if the state actually changed, `false` if the type is not
 * an override or was already in the requested state.
 */
export function setOverridePaused(type: string, paused: boolean): boolean {
  if (!builtinFallbacks.has(type)) return false;
  const wasPaused = pausedOverrides.has(type);
  if (paused && !wasPaused) {
    pausedOverrides.add(type);
    console.log(`[paperclip] Override paused for "${type}" — builtin adapter restored`);
    return true;
  }
  if (!paused && wasPaused) {
    pausedOverrides.delete(type);
    console.log(`[paperclip] Override resumed for "${type}" — external adapter active`);
    return true;
  }
  return false;
}

/** Check whether the external override for a builtin type is currently paused. */
export function isOverridePaused(type: string): boolean {
  return pausedOverrides.has(type);
}

/** Get the set of types whose overrides are currently paused. */
export function getPausedOverrides(): Set<string> {
  return pausedOverrides;
}

export function findServerAdapter(type: string): ServerAdapterModule | null {
  return adaptersByType.get(type) ?? null;
}

export function findActiveServerAdapter(type: string): ServerAdapterModule | null {
  if (pausedOverrides.has(type)) {
    const fallback = builtinFallbacks.get(type);
    if (fallback) return fallback;
  }
  return adaptersByType.get(type) ?? null;
}
