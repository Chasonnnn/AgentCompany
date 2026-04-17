import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import {
  defaultCodexLocalFastModeForModel,
  DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX,
  DEFAULT_CODEX_LOCAL_MODEL,
} from "@paperclipai/adapter-codex-local";
import { DEFAULT_CURSOR_LOCAL_MODEL } from "@paperclipai/adapter-cursor-local";
import { DEFAULT_GEMINI_LOCAL_MODEL } from "@paperclipai/adapter-gemini-local";

const DEFAULT_CLAUDE_LOCAL_EFFORT = "xhigh";
const CLAUDE_LOCAL_EFFORT_LEVELS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

function thinkingEffortLabel(
  value: (typeof CLAUDE_LOCAL_EFFORT_LEVELS)[number],
): string {
  switch (value) {
    case "xhigh":
      return "X-High";
    default:
      return value.charAt(0).toUpperCase() + value.slice(1);
  }
}

export const defaultCreateValues: CreateConfigValues = {
  adapterType: "claude_local",
  cwd: "",
  instructionsFilePath: "",
  promptTemplate: "",
  model: "",
  thinkingEffort: "",
  chrome: false,
  dangerouslySkipPermissions: true,
  search: false,
  fastMode: false,
  dangerouslyBypassSandbox: false,
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
};

export const claudeThinkingEffortOptions = [
  { id: "", label: "Default (X-High)" },
  ...CLAUDE_LOCAL_EFFORT_LEVELS.map((id) => ({
    id,
    label: thinkingEffortLabel(id),
  })),
] as const;

export const claudeIssueThinkingEffortOptions = [
  { value: "", label: "Default" },
  ...CLAUDE_LOCAL_EFFORT_LEVELS.map((value) => ({
    value,
    label: thinkingEffortLabel(value),
  })),
] as const;

export function defaultThinkingEffortForAdapterType(adapterType: string): string {
  return adapterType === "claude_local" ? DEFAULT_CLAUDE_LOCAL_EFFORT : "";
}

export function createCreateValuesForAdapterType(
  adapterType: CreateConfigValues["adapterType"] = defaultCreateValues.adapterType,
): CreateConfigValues {
  const nextValues: CreateConfigValues = {
    ...defaultCreateValues,
    adapterType,
    thinkingEffort: defaultThinkingEffortForAdapterType(adapterType),
  };

  if (adapterType === "codex_local") {
    nextValues.model = DEFAULT_CODEX_LOCAL_MODEL;
    nextValues.fastMode = defaultCodexLocalFastModeForModel(DEFAULT_CODEX_LOCAL_MODEL);
    nextValues.dangerouslyBypassSandbox = DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX;
  } else if (adapterType === "gemini_local") {
    nextValues.model = DEFAULT_GEMINI_LOCAL_MODEL;
  } else if (adapterType === "cursor") {
    nextValues.model = DEFAULT_CURSOR_LOCAL_MODEL;
  } else if (adapterType === "opencode_local") {
    nextValues.model = "";
  }

  return nextValues;
}
