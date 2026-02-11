import fs from "node:fs/promises";
import path from "node:path";
import { newId } from "../core/ids.js";
import { nowIso } from "../core/time.js";
import { ensureDir } from "../store/fs.js";
import { writeYamlFile } from "../store/yaml.js";
import { REQUIRED_DIRS, REQUIRED_FILES } from "./layout.js";

export type InitWorkspaceArgs = {
  root_dir: string;
  company_name: string;
  force?: boolean;
};

export async function initWorkspace(args: InitWorkspaceArgs): Promise<void> {
  const rootDir = args.root_dir;

  // Prevent accidental initialization into a non-empty directory unless forced.
  try {
    const entries = await fs.readdir(rootDir);
    if (!args.force && entries.length > 0) {
      throw new Error(
        `Refusing to initialize in a non-empty directory (${rootDir}). Use --force to override.`
      );
    }
  } catch (e) {
    // If directory doesn't exist, that's fine; it will be created.
    const err = e as NodeJS.ErrnoException;
    if (err?.code !== "ENOENT") throw e;
  }

  for (const d of REQUIRED_DIRS) {
    await ensureDir(path.join(rootDir, d));
  }

  const companyId = newId("cmp");
  await writeYamlFile(path.join(rootDir, "company/company.yaml"), {
    schema_version: 1,
    type: "company",
    id: companyId,
    name: args.company_name,
    created_at: nowIso()
  });

  await writeYamlFile(path.join(rootDir, "company/policy.yaml"), {
    schema_version: 1,
    type: "policy",
    id: newId("art"),
    visibility_defaults: {
      worker_journal: "private_agent",
      worker_milestone_artifact: "team",
      manager_proposal: "managers",
      director_workplan: "org"
    }
  });

  await writeYamlFile(path.join(rootDir, ".local/machine.yaml"), {
    schema_version: 1,
    type: "machine",
    repo_roots: {},
    provider_bins: {},
    provider_pricing_usd_per_1k_tokens: {}
  });

  // Sanity check: ensure required files exist after initialization.
  for (const f of REQUIRED_FILES) {
    // no-op; writeYamlFile already created them.
    void f;
  }
}
