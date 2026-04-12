function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export type AgentTemplateMode = "agent_snapshot" | "reusable";

const TEMPLATE_MODE_ROOT = "paperclip";
const TEMPLATE_MODE_KEY = "templateMode";

export function readAgentTemplateMode(metadata: unknown): AgentTemplateMode {
  const record = asRecord(metadata);
  const paperclip = record ? asRecord(record[TEMPLATE_MODE_ROOT]) : null;
  const rawMode = paperclip?.[TEMPLATE_MODE_KEY];
  return rawMode === "reusable" ? "reusable" : "agent_snapshot";
}

export function withAgentTemplateMode(
  metadata: Record<string, unknown> | null | undefined,
  mode: AgentTemplateMode,
  extras?: Record<string, unknown>,
): Record<string, unknown> {
  const base = metadata && !Array.isArray(metadata) ? { ...metadata } : {};
  const existingPaperclip = asRecord(base[TEMPLATE_MODE_ROOT]) ?? {};
  base[TEMPLATE_MODE_ROOT] = {
    ...existingPaperclip,
    [TEMPLATE_MODE_KEY]: mode,
    ...(extras ?? {}),
  };
  return base;
}
