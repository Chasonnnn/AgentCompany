import type {
  AgentExecutionModel,
  AgentTemplateLifecycleStatus,
} from "./constants.js";

const LEGACY_RELAY_ARCHETYPE_KEYS = new Set([
  "product_manager",
  "project_product_manager",
  "program_manager",
]);

type InferAgentExecutionModelInput = {
  role?: string | null;
  operatingClass?: string | null;
  capabilityProfileKey?: string | null;
  archetypeKey?: string | null;
};

export function inferAgentExecutionModel(
  input: InferAgentExecutionModelInput,
): AgentExecutionModel {
  if (input.operatingClass === "executive" || input.capabilityProfileKey?.startsWith("executive")) {
    return "governance";
  }

  if (
    input.operatingClass === "shared_service_lead" ||
    input.operatingClass === "consultant" ||
    input.capabilityProfileKey === "shared_service_lead" ||
    input.capabilityProfileKey === "consultant"
  ) {
    return "shared_service";
  }

  if (input.role === "pm" || LEGACY_RELAY_ARCHETYPE_KEYS.has(input.archetypeKey ?? "")) {
    return "relay_legacy";
  }

  return "shared_state";
}

export function inferAgentTemplateLifecycleStatus(
  executionModel: AgentExecutionModel,
): AgentTemplateLifecycleStatus {
  return executionModel === "relay_legacy" ? "legacy" : "active";
}
