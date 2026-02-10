import path from "node:path";
import { MachineYaml } from "../schemas/machine.js";
import { readYamlFile, writeYamlFile } from "../store/yaml.js";

export async function readMachineConfig(workspaceDir: string): Promise<MachineYaml> {
  const p = path.join(workspaceDir, ".local/machine.yaml");
  return MachineYaml.parse(await readYamlFile(p));
}

export async function setRepoRoot(
  workspaceDir: string,
  repoId: string,
  absPath: string
): Promise<void> {
  const p = path.join(workspaceDir, ".local/machine.yaml");
  const doc = MachineYaml.parse(await readYamlFile(p));
  await writeYamlFile(p, {
    ...doc,
    repo_roots: { ...doc.repo_roots, [repoId]: absPath }
  });
}

export async function setProviderBin(
  workspaceDir: string,
  provider: string,
  absPath: string
): Promise<void> {
  const p = path.join(workspaceDir, ".local/machine.yaml");
  const doc = MachineYaml.parse(await readYamlFile(p));
  await writeYamlFile(p, {
    ...doc,
    provider_bins: { ...doc.provider_bins, [provider]: absPath }
  });
}

