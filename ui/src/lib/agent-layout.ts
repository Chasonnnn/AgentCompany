import type { AgentNavigationLayout } from "@paperclipai/shared";

export type AgentLayoutMode = AgentNavigationLayout | "accountability";

const DEFAULT_LAYOUT: AgentLayoutMode = "accountability";
export const AGENT_LAYOUT_STORAGE_PREFIX = "paperclip:agent-layout:";

function storageKey(companyId: string, userId?: string | null) {
  return `${AGENT_LAYOUT_STORAGE_PREFIX}${userId ?? "anon"}:${companyId}`;
}

export function getStoredAgentLayout(companyId: string, userId?: string | null): AgentLayoutMode {
  try {
    const raw = localStorage.getItem(storageKey(companyId, userId));
    return raw === "project" || raw === "department" || raw === "accountability"
      ? raw
      : DEFAULT_LAYOUT;
  } catch {
    return DEFAULT_LAYOUT;
  }
}

export function setStoredAgentLayout(
  companyId: string,
  layout: AgentLayoutMode,
  userId?: string | null,
) {
  try {
    localStorage.setItem(storageKey(companyId, userId), layout);
  } catch {
    // Ignore localStorage failures.
  }
}

export function pruneStoredAgentLayouts(companyIds: Iterable<string>) {
  const allowedCompanyIds = new Set(companyIds);
  try {
    const keysToRemove: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key || !key.startsWith(AGENT_LAYOUT_STORAGE_PREFIX)) continue;
      const companyId = key.split(":").pop();
      if (!companyId || allowedCompanyIds.has(companyId)) continue;
      keysToRemove.push(key);
    }
    for (const key of keysToRemove) {
      localStorage.removeItem(key);
    }
  } catch {
    // Ignore localStorage failures.
  }
}
