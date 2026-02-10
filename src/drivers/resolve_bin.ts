import { readMachineConfig } from "../machine/machine.js";
import { resolveDriverName, type DriverName } from "./registry.js";

export async function resolveProviderBin(
  workspaceDir: string,
  provider: string
): Promise<{ driver: DriverName; bin: string }> {
  const driver = resolveDriverName(provider);
  const machine = await readMachineConfig(workspaceDir);
  const bin = machine.provider_bins[provider] ?? machine.provider_bins[driver] ?? driver;
  return { driver, bin };
}

