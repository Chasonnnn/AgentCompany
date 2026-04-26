/**
 * Backfill Paperclip-managed memory defaults and canonical memory guidance for
 * existing managed agent instruction bundles in a single company.
 *
 * Usage:
 *   DATABASE_URL=postgres://... \
 *   pnpm --filter @paperclipai/server exec tsx scripts/repair-agent-memory-contract.ts \
 *     --company <uuid> [--apply]
 *
 * Dry-run is the default. Pass --apply to write changes.
 */

import { createDb } from "@paperclipai/db";
import { agentService } from "../src/services/agents.ts";
import { agentInstructionsService } from "../src/services/agent-instructions.ts";
import {
  loadDefaultAgentInstructionsBundle,
  resolveDefaultAgentInstructionsBundleRole,
  withCanonicalAgentMemoryContract,
} from "../src/services/default-agent-instructions.ts";

function readArg(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

const companyId = readArg("--company");
if (!companyId) {
  console.error("--company <uuid> is required");
  process.exit(2);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL env var is required");
  process.exit(2);
}

const apply = hasFlag("--apply");
const db = createDb(databaseUrl);
const agents = agentService(db);
const instructions = agentInstructionsService();

const allAgents = await agents.list(companyId);
console.log(`Company ${companyId}: ${allAgents.length} agents (${apply ? "APPLY" : "dry-run"})`);

let skipped = 0;
let wouldChange = 0;
let applied = 0;
let failed = 0;

for (const agent of allAgents) {
  const label = `${agent.name} (${agent.id})`;
  try {
    const defaults = await loadDefaultAgentInstructionsBundle(
      resolveDefaultAgentInstructionsBundleRole(agent.role),
    );
    const current = await instructions.readFile(agent, "AGENTS.md");
    const nextContent = withCanonicalAgentMemoryContract(current.content);
    const needsAgentsUpdate = nextContent !== current.content;
    const bundle = await instructions.getBundle(agent);
    const existingPaths = new Set(bundle.files.map((file) => file.path));
    const missingDefaultFiles = Object.keys(defaults).filter((file) => !existingPaths.has(file));
    const needsDefaultsUpdate = missingDefaultFiles.length > 0;

    if (!needsAgentsUpdate && !needsDefaultsUpdate) {
      console.log(`[skip]     ${label}`);
      skipped += 1;
      continue;
    }

    if (!apply) {
      console.log(
        `[dry-run]  ${label} — ${needsAgentsUpdate ? "append memory contract" : "contract present"}; ` +
          `create defaults: ${missingDefaultFiles.join(", ") || "none"}`,
      );
      wouldChange += 1;
      continue;
    }

    let adapterConfig = agent.adapterConfig as Record<string, unknown>;
    let createdFiles: string[] = [];
    if (apply) {
      const repair = await instructions.repairManagedBundleDefaults(agent, defaults, {
        entryFile: "AGENTS.md",
        resetMemory: false,
      });
      adapterConfig = repair.adapterConfig;
      createdFiles = repair.createdFiles;
    }
    if (needsAgentsUpdate) {
      const written = await instructions.writeFile(
        { ...agent, adapterConfig },
        "AGENTS.md",
        nextContent,
      );
      adapterConfig = written.adapterConfig;
    }
    await agents.update(agent.id, { adapterConfig });
    console.log(
      `[applied]  ${label} — ${needsAgentsUpdate ? "appended memory contract" : "contract present"}; ` +
        `created defaults: ${createdFiles.join(", ") || "none"}`,
    );
    applied += 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[error]    ${label}: ${message}`);
    failed += 1;
  }
}

console.log(
  JSON.stringify(
    {
      companyId,
      apply,
      agents: allAgents.length,
      skipped,
      wouldChange,
      applied,
      failed,
    },
    null,
    2,
  ),
);

process.exit(failed > 0 ? 1 : 0);
