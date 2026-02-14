import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  deleteGeminiApiKey,
  getGeminiApiKeyStatus,
  setGeminiApiKey
} from "../desktop-react/src/services/rpc.js";

type InvokeFn = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

declare global {
  interface Window {
    __TAURI__?: {
      core?: {
        invoke?: InvokeFn;
      };
    };
  }
}

describe("desktop rpc gemini key commands", () => {
  const originalTauri = (globalThis as any).window?.__TAURI__;

  beforeEach(() => {
    (globalThis as any).window = (globalThis as any).window ?? {};
  });

  afterEach(() => {
    (globalThis as any).window.__TAURI__ = originalTauri;
    vi.restoreAllMocks();
  });

  test("getGeminiApiKeyStatus invokes tauri command", async () => {
    const invoke = vi.fn().mockResolvedValue({ configured: true, storage: "macos_keychain" });
    (globalThis as any).window.__TAURI__ = { core: { invoke } };

    const result = await getGeminiApiKeyStatus();
    expect(result.configured).toBe(true);
    expect(invoke).toHaveBeenCalledWith("get_gemini_api_key_status", undefined);
  });

  test("setGeminiApiKey invokes tauri command with nested args payload", async () => {
    const invoke = vi.fn().mockResolvedValue({ configured: true, storage: "macos_keychain" });
    (globalThis as any).window.__TAURI__ = { core: { invoke } };

    await setGeminiApiKey("abc123");
    expect(invoke).toHaveBeenCalledWith("set_gemini_api_key", {
      args: {
        apiKey: "abc123"
      }
    });
  });

  test("deleteGeminiApiKey invokes tauri command", async () => {
    const invoke = vi.fn().mockResolvedValue({ configured: false, storage: "macos_keychain" });
    (globalThis as any).window.__TAURI__ = { core: { invoke } };

    await deleteGeminiApiKey();
    expect(invoke).toHaveBeenCalledWith("delete_gemini_api_key", undefined);
  });
});

