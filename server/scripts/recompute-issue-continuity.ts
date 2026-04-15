import { createDb } from "@paperclipai/db";
import { issueContinuityService } from "../src/services/issue-continuity.ts";

function readArg(name: string) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to repair issue continuity state");
}

const companyId = readArg("--company");
const db = createDb(databaseUrl);
const continuity = issueContinuityService(db);
const repaired = await continuity.recomputeAll(companyId ?? undefined);

console.log(
  JSON.stringify(
    {
      repairedIssues: repaired,
      companyId: companyId ?? null,
    },
    null,
    2,
  ),
);

process.exit(0);
