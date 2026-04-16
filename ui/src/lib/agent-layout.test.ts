// @vitest-environment node

import { beforeEach, describe, expect, it } from "vitest";
import { getStoredAgentLayout, pruneStoredAgentLayouts, setStoredAgentLayout } from "./agent-layout";

const storage = new Map<string, string>();

Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
    clear: () => {
      storage.clear();
    },
    key: (index: number) => Array.from(storage.keys())[index] ?? null,
    get length() {
      return storage.size;
    },
  },
  configurable: true,
});

describe("agent layout storage", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("prunes layouts for archived or missing companies while keeping active ones", () => {
    setStoredAgentLayout("company-active", "project", "user-1");
    setStoredAgentLayout("company-archived", "department", "user-1");
    setStoredAgentLayout("company-other", "accountability", "user-2");

    pruneStoredAgentLayouts(["company-active"]);

    expect(getStoredAgentLayout("company-active", "user-1")).toBe("project");
    expect(localStorage.getItem("paperclip:agent-layout:user-1:company-archived")).toBeNull();
    expect(localStorage.getItem("paperclip:agent-layout:user-2:company-other")).toBeNull();
  });
});
