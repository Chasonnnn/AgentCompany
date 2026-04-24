import { describe, expect, it } from "vitest";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { buildCodexLocalConfig } from "./build-config.js";

function makeValues(overrides: Partial<CreateConfigValues> = {}): CreateConfigValues {
  return {
    adapterType: "codex_local",
    cwd: "",
    instructionsFilePath: "",
    promptTemplate: "",
    model: "gpt-5.5",
    thinkingEffort: "",
    chrome: false,
    dangerouslySkipPermissions: true,
    search: false,
    fastMode: false,
    dangerouslyBypassSandbox: true,
    command: "",
    args: "",
    extraArgs: "",
    envVars: "",
    envBindings: {},
    url: "",
    bootstrapPrompt: "",
    payloadTemplateJson: "",
    workspaceStrategyType: "project_primary",
    workspaceBaseRef: "",
    workspaceBranchTemplate: "",
    worktreeParentDir: "",
    runtimeServicesJson: "",
    maxTurnsPerRun: 1000,
    heartbeatEnabled: false,
    intervalSec: 300,
    ...overrides,
  };
}

describe("buildCodexLocalConfig", () => {
  it("persists the fastMode toggle into adapter config", () => {
    const config = buildCodexLocalConfig(
      makeValues({
        search: true,
        fastMode: true,
      }),
    );

    expect(config).toMatchObject({
      model: "gpt-5.5",
      search: true,
      fastMode: true,
      dangerouslyBypassApprovalsAndSandbox: true,
    });
  });

  it("defaults fast mode on for eligible models when omitted", () => {
    const values = makeValues({
      model: "gpt-5.5",
    }) as unknown as Record<string, unknown>;
    delete values.fastMode;

    const config = buildCodexLocalConfig(values as unknown as CreateConfigValues);

    expect(config).toMatchObject({
      model: "gpt-5.5",
      fastMode: true,
    });
  });

  it("preserves an explicit fast mode disable on eligible models", () => {
    const config = buildCodexLocalConfig(
      makeValues({
        model: "gpt-5.5",
        fastMode: false,
      }),
    );

    expect(config).toMatchObject({
      model: "gpt-5.5",
      fastMode: false,
    });
  });
});
