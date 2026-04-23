/**
 * Append the load-balancing guidance to existing delegator agents' AGENTS.md
 * bundles in a single company. Useful for companies whose agents were hired
 * before the onboarding templates learned about load balancing.
 *
 * Usage:
 *   DATABASE_URL=postgres://... \
 *   pnpm --filter @paperclipai/server exec tsx scripts/refresh-delegator-briefings.ts \
 *     --company <uuid> [--apply]
 *
 * Dry-run is the default. Pass --apply to actually write. The script is
 * idempotent: agents whose AGENTS.md already references
 * skills/paperclip/references/load-balancing.md are skipped.
 *
 * Only delegator-class agents are touched:
 *   operatingClass in (executive, project_leadership, shared_service_lead).
 * Workers and consultants are left alone.
 *
 * The paperclip server must have bootstrapped the embedded postgres at least
 * once so DATABASE_URL is reachable. Safe to run with the server up or down —
 * it only reads agent rows and writes the bundle entry file plus adapterConfig.
 */

import { createDb } from "@paperclipai/db";
import { agentService } from "../src/services/agents.ts";
import { agentInstructionsService } from "../src/services/agent-instructions.ts";

const LOAD_BALANCING_MARKER = "skills/paperclip/references/load-balancing.md";

const APPENDED_SECTION = `

## Load balancing across same-role reports

When you assign or reassign work and more than one report could reasonably own it (e.g. multiple Backend engineers or multiple QA agents), prefer the report with the fewest open issues before falling back to tenure or context fit. Otherwise one agent accumulates a queue while peers sit idle.

See \`skills/paperclip/references/load-balancing.md\` for the full recipe and edge cases.
`;

const DELEGATOR_OPERATING_CLASSES = new Set([
  "executive",
  "project_leadership",
  "shared_service_lead",
]);

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
const svc = agentService(db);
const instructions = agentInstructionsService();

const allAgents = await svc.list(companyId);
const delegators = allAgents.filter((agent) =>
  DELEGATOR_OPERATING_CLASSES.has(agent.operatingClass),
);

console.log(
  `Company ${companyId}: ${allAgents.length} agents, ${delegators.length} delegators (${apply ? "APPLY" : "dry-run"})`,
);

let skippedExisting = 0;
let wouldAppend = 0;
let applied = 0;
let failed = 0;

for (const agent of delegators) {
  const label = `${agent.name} (${agent.role}/${agent.operatingClass})`;
  try {
    const current = await instructions.readFile(agent, "AGENTS.md");
    if (current.content.includes(LOAD_BALANCING_MARKER)) {
      console.log(`[skip]     ${label} — already references load-balancing.md`);
      skippedExisting += 1;
      continue;
    }
    if (!apply) {
      console.log(`[dry-run]  ${label} — would append ${APPENDED_SECTION.length} bytes`);
      wouldAppend += 1;
      continue;
    }
    const nextContent = current.content + APPENDED_SECTION;
    const result = await instructions.writeFile(agent, "AGENTS.md", nextContent);
    await svc.update(agent.id, { adapterConfig: result.adapterConfig });
    console.log(`[applied]  ${label}`);
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
      delegators: delegators.length,
      skippedExisting,
      wouldAppend,
      applied,
      failed,
    },
    null,
    2,
  ),
);

process.exit(failed > 0 ? 1 : 0);
