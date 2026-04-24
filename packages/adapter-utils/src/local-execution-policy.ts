import path from "node:path";

export const LOCAL_EXECUTION_POLICY_ERROR_CODE = "local_execution_policy_violation";

export type LocalExecutionViolationKind =
  | "local_execution_disabled"
  | "command_not_allowed"
  | "env_key_not_allowed"
  | "cwd_not_allowed"
  | "network_policy_unsupported";

export type LocalExecutionNetworkPolicy =
  | "all"
  | "loopback"
  | "none"
  | {
      mode: "allowlist";
      hosts: string[];
    };

export interface LocalExecutionPolicy {
  preset?: string | null;
  allowedCommands?: string[] | null;
  allowedEnvKeys?: string[] | null;
  allowedFsPaths?: string[] | null;
  allowedNetwork?: LocalExecutionNetworkPolicy | null;
}

export interface NormalizedLocalExecutionPolicy {
  preset: string;
  allowedCommands: string[] | null;
  allowedEnvKeys: string[] | null;
  allowedFsPaths: string[] | null;
  allowedNetwork: LocalExecutionNetworkPolicy;
}

export interface ApplyLocalExecutionPolicyInput {
  policy: NormalizedLocalExecutionPolicy | null | undefined;
  executionKind: "local" | "remote";
  command: string;
  cwd: string;
  env: Record<string, string>;
  declaredEnvKeys?: string[];
}

export interface ApplyLocalExecutionPolicyResult {
  env: Record<string, string>;
}

export class LocalExecutionPolicyError extends Error {
  readonly errorCode = LOCAL_EXECUTION_POLICY_ERROR_CODE;
  readonly errorMeta: Record<string, unknown>;

  constructor(message: string, meta: Record<string, unknown>) {
    super(message);
    this.name = "LocalExecutionPolicyError";
    this.errorMeta = meta;
  }
}

const PERMISSIVE_POLICY: NormalizedLocalExecutionPolicy = {
  preset: "permissive",
  allowedCommands: null,
  allowedEnvKeys: null,
  allowedFsPaths: null,
  allowedNetwork: "all",
};

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeStringList(value: unknown, fieldName: string): string[] | null {
  if (value == null) return null;
  if (!Array.isArray(value)) {
    throw new Error(`localExecutionPolicy.${fieldName} must be an array of strings.`);
  }

  const values = value
    .map((entry) => asTrimmedString(entry))
    .filter((entry): entry is string => entry != null);
  return values.length > 0 ? Array.from(new Set(values)) : [];
}

function normalizeAllowedNetwork(value: unknown): LocalExecutionNetworkPolicy {
  if (value == null) return "all";
  if (value === "all") return "all";
  if (value === "loopback") return "loopback";
  if (value === "off" || value === "none") return "none";

  const parsed = asObject(value);
  if (parsed.mode === "allowlist") {
    const hosts = normalizeStringList(parsed.hosts, "allowedNetwork.hosts");
    if (!hosts || hosts.length === 0) {
      throw new Error("localExecutionPolicy.allowedNetwork.hosts must include at least one host.");
    }
    return { mode: "allowlist", hosts };
  }

  throw new Error(
    "localExecutionPolicy.allowedNetwork must be `all`, `loopback`, `off`, or { mode: \"allowlist\", hosts: [...] }.",
  );
}

function commandMatchesPolicy(command: string, allowedCommands: string[]): boolean {
  const candidateBasename = path.basename(command).toLowerCase();
  const candidatePath = path.resolve(command);

  return allowedCommands.some((allowed) => {
    if (allowed.includes("/") || allowed.includes("\\")) {
      return path.resolve(allowed) === candidatePath;
    }
    return allowed.toLowerCase() === candidateBasename;
  });
}

function pathWithinRoot(candidate: string, root: string): boolean {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedRoot = path.resolve(root);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function buildViolationError(input: {
  policy: NormalizedLocalExecutionPolicy;
  violationKind: LocalExecutionViolationKind;
  message: string;
  details?: Record<string, unknown>;
}): LocalExecutionPolicyError {
  return new LocalExecutionPolicyError(input.message, {
    policyPreset: input.policy.preset,
    violationKind: input.violationKind,
    ...(input.details ?? {}),
  });
}

export function permissiveLocalExecutionPolicy(): NormalizedLocalExecutionPolicy {
  return { ...PERMISSIVE_POLICY };
}

export function parseLocalExecutionPolicy(
  value: unknown,
  options: { defaultPreset?: string } = {},
): NormalizedLocalExecutionPolicy | null {
  if (value == null) return null;
  const parsed = asObject(value);
  if (Object.keys(parsed).length === 0) {
    return {
      preset: options.defaultPreset ?? "custom",
      allowedCommands: null,
      allowedEnvKeys: null,
      allowedFsPaths: null,
      allowedNetwork: "all",
    };
  }

  return {
    preset: asTrimmedString(parsed.preset) ?? options.defaultPreset ?? "custom",
    allowedCommands: normalizeStringList(parsed.allowedCommands, "allowedCommands"),
    allowedEnvKeys: normalizeStringList(parsed.allowedEnvKeys, "allowedEnvKeys"),
    allowedFsPaths: normalizeStringList(parsed.allowedFsPaths, "allowedFsPaths"),
    allowedNetwork: normalizeAllowedNetwork(parsed.allowedNetwork),
  };
}

export function applyLocalExecutionPolicy(
  input: ApplyLocalExecutionPolicyInput,
): ApplyLocalExecutionPolicyResult {
  if (!input.policy || input.executionKind === "remote") {
    return { env: input.env };
  }

  const policy = input.policy;

  if (policy.allowedCommands && !commandMatchesPolicy(input.command, policy.allowedCommands)) {
    throw buildViolationError({
      policy,
      violationKind: "command_not_allowed",
      message: `Local execution policy blocked command "${input.command}".`,
      details: {
        command: input.command,
        allowedCommands: policy.allowedCommands,
      },
    });
  }

  if (policy.allowedFsPaths && !policy.allowedFsPaths.some((root) => pathWithinRoot(input.cwd, root))) {
    throw buildViolationError({
      policy,
      violationKind: "cwd_not_allowed",
      message: `Local execution policy blocked working directory "${input.cwd}".`,
      details: {
        cwd: input.cwd,
        allowedFsPaths: policy.allowedFsPaths,
      },
    });
  }

  if (policy.allowedNetwork !== "all") {
    throw buildViolationError({
      policy,
      violationKind: "network_policy_unsupported",
      message: "Local execution policy requested network restrictions that are not yet supported by this runner.",
      details: {
        allowedNetwork: policy.allowedNetwork,
      },
    });
  }

  if (!policy.allowedEnvKeys) {
    return { env: input.env };
  }

  const allowedEnvKeys = new Set(policy.allowedEnvKeys);
  const disallowedDeclaredEnvKeys = (input.declaredEnvKeys ?? []).filter((key) => !allowedEnvKeys.has(key));
  if (disallowedDeclaredEnvKeys.length > 0) {
    throw buildViolationError({
      policy,
      violationKind: "env_key_not_allowed",
      message: `Local execution policy blocked env keys: ${disallowedDeclaredEnvKeys.join(", ")}`,
      details: {
        envKeys: disallowedDeclaredEnvKeys,
        allowedEnvKeys: policy.allowedEnvKeys,
      },
    });
  }

  return {
    env: Object.fromEntries(
      Object.entries(input.env).filter(([key]) => allowedEnvKeys.has(key)),
    ),
  };
}
