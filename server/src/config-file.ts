import fs from "node:fs";
import { agentcompanyConfigSchema, type AgentCompanyConfig } from "@agentcompany/shared";
import { resolveAgentCompanyConfigPath } from "./paths.js";

export function readConfigFile(): AgentCompanyConfig | null {
  const configPath = resolveAgentCompanyConfigPath();

  if (!fs.existsSync(configPath)) return null;

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return agentcompanyConfigSchema.parse(raw);
  } catch {
    return null;
  }
}
