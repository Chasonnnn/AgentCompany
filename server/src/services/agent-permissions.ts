import type {
  AgentCapabilityProfileKey,
  AgentOperatingClass,
  AgentOrgLevel,
} from "@paperclipai/shared";

export type NormalizedAgentPermissions = Record<string, unknown> & {
  canCreateAgents: boolean;
};

export function defaultOperatingClassForLegacyAgent(
  role: string,
  orgLevel?: AgentOrgLevel | null,
): AgentOperatingClass {
  if (role === "ceo" || role === "cto" || role === "cfo" || role === "cmo" || role === "coo") {
    return "executive";
  }
  if (orgLevel === "executive") return "executive";
  if (orgLevel === "director") return "project_leadership";
  return "worker";
}

export function defaultCapabilityProfileKeyForAgent(input: {
  role: string;
  operatingClass?: AgentOperatingClass | null;
  orgLevel?: AgentOrgLevel | null;
}): AgentCapabilityProfileKey {
  const operatingClass = input.operatingClass ?? defaultOperatingClassForLegacyAgent(input.role, input.orgLevel);
  if (input.role === "ceo") return "legacy_ceo";
  if (input.role === "coo" && operatingClass === "executive") return "executive_operator";
  if (operatingClass === "executive") return "executive_specialist";
  if (operatingClass === "project_leadership") return "project_lead";
  if (operatingClass === "shared_service_lead") return "shared_service_lead";
  if (operatingClass === "consultant") return "consultant";
  return "worker";
}

export function capabilityProfileCanCreateAgents(capabilityProfileKey: string | null | undefined): boolean {
  return capabilityProfileKey === "legacy_ceo" || capabilityProfileKey === "executive_operator";
}

export function defaultPermissionsForRole(
  role: string,
  options?: { capabilityProfileKey?: string | null; operatingClass?: AgentOperatingClass | null; orgLevel?: AgentOrgLevel | null },
): NormalizedAgentPermissions {
  const capabilityProfileKey = options?.capabilityProfileKey
    ?? defaultCapabilityProfileKeyForAgent({
      role,
      operatingClass: options?.operatingClass ?? undefined,
      orgLevel: options?.orgLevel ?? undefined,
    });
  return {
    canCreateAgents: capabilityProfileCanCreateAgents(capabilityProfileKey),
  };
}

export function normalizeAgentPermissions(
  permissions: unknown,
  role: string,
  options?: { capabilityProfileKey?: string | null; operatingClass?: AgentOperatingClass | null; orgLevel?: AgentOrgLevel | null },
): NormalizedAgentPermissions {
  const defaults = defaultPermissionsForRole(role, options);
  if (typeof permissions !== "object" || permissions === null || Array.isArray(permissions)) {
    return defaults;
  }

  const record = permissions as Record<string, unknown>;
  return {
    canCreateAgents:
      typeof record.canCreateAgents === "boolean"
        ? record.canCreateAgents
        : defaults.canCreateAgents,
  };
}

export function agentHasCreatePermission(agent: {
  role: string;
  orgLevel?: AgentOrgLevel | null;
  operatingClass?: AgentOperatingClass | null;
  capabilityProfileKey?: string | null;
  permissions: Record<string, unknown> | null | undefined;
}) {
  const normalized = normalizeAgentPermissions(agent.permissions, agent.role, {
    capabilityProfileKey: agent.capabilityProfileKey ?? undefined,
    operatingClass: agent.operatingClass ?? undefined,
    orgLevel: agent.orgLevel ?? undefined,
  });
  return normalized.canCreateAgents;
}
