import type { AgentNavigationLayout } from "@paperclipai/shared";

export type AgentLayoutMode = AgentNavigationLayout | "accountability";

const DEFAULT_LAYOUT: AgentLayoutMode = "accountability";

function storageKey(companyId: string, userId?: string | null) {
  return `paperclip:agent-layout:${userId ?? "anon"}:${companyId}`;
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
