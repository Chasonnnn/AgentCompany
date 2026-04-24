import { describe, expect, it, vi } from "vitest";
import { maybeTrackLocalExecutionPolicyViolation } from "./local-execution-policy-metrics.js";

describe("maybeTrackLocalExecutionPolicyViolation", () => {
  it("emits telemetry for local execution policy violations", () => {
    const telemetryClient = {
      track: vi.fn(),
    } as any;

    const tracked = maybeTrackLocalExecutionPolicyViolation(telemetryClient, {
      adapterType: "claude_local",
      errorCode: "local_execution_policy_violation",
      errorMeta: {
        policyPreset: "claude_environment_probe",
        violationKind: "env_key_not_allowed",
      },
    });

    expect(tracked).toBe(true);
    expect(telemetryClient.track).toHaveBeenCalledWith(
      "adapter.local_execution_policy_violation",
      {
        adapter_type: "claude_local",
        policy_preset: "claude_environment_probe",
        violation_kind: "env_key_not_allowed",
      },
    );
  });

  it("ignores unrelated failures", () => {
    const telemetryClient = {
      track: vi.fn(),
    } as any;

    expect(
      maybeTrackLocalExecutionPolicyViolation(telemetryClient, {
        adapterType: "claude_local",
        errorCode: "adapter_failed",
        errorMeta: {
          policyPreset: "claude_environment_probe",
          violationKind: "env_key_not_allowed",
        },
      }),
    ).toBe(false);
    expect(telemetryClient.track).not.toHaveBeenCalled();
  });
});
