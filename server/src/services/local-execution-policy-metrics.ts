import type { TelemetryClient } from "@paperclipai/shared/telemetry";

export function maybeTrackLocalExecutionPolicyViolation(
  telemetryClient: TelemetryClient | null | undefined,
  input: {
    adapterType: string | null | undefined;
    errorCode?: string | null;
    errorMeta?: Record<string, unknown> | null;
  },
): boolean {
  if (!telemetryClient || input.errorCode !== "local_execution_policy_violation") {
    return false;
  }

  const policyPreset =
    typeof input.errorMeta?.policyPreset === "string" && input.errorMeta.policyPreset.trim().length > 0
      ? input.errorMeta.policyPreset.trim()
      : "unknown";
  const violationKind =
    typeof input.errorMeta?.violationKind === "string" && input.errorMeta.violationKind.trim().length > 0
      ? input.errorMeta.violationKind.trim()
      : "unknown";

  telemetryClient.track("adapter.local_execution_policy_violation", {
    adapter_type: input.adapterType?.trim() || "unknown",
    policy_preset: policyPreset,
    violation_kind: violationKind,
  });
  return true;
}
