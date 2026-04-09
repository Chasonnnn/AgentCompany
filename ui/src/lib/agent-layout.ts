import type { AgentNavigationLayout } from "@paperclipai/shared";

const DEFAULT_LAYOUT: AgentNavigationLayout = "department";

function storageKey(companyId: string, userId?: string | null) {
  return `paperclip:agent-layout:${userId ?? "anon"}:${companyId}`;
}

export function getStoredAgentLayout(companyId: string, userId?: string | null): AgentNavigationLayout {
  try {
    const raw = localStorage.getItem(storageKey(companyId, userId));
    return raw === "project" ? "project" : DEFAULT_LAYOUT;
  } catch {
    return DEFAULT_LAYOUT;
  }
}

export function setStoredAgentLayout(
  companyId: string,
  layout: AgentNavigationLayout,
  userId?: string | null,
) {
  try {
    localStorage.setItem(storageKey(companyId, userId), layout);
  } catch {
    // Ignore localStorage failures.
  }
}
