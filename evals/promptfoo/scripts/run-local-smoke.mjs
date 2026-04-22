#!/usr/bin/env node
import {
  runComponentEvalPreflight,
  runPromptfooEval,
  withLocalPaperclipServer,
} from "./local-component-eval-lib.mjs";

async function main() {
  await withLocalPaperclipServer(async ({ baseUrl }) => {
    await runComponentEvalPreflight(baseUrl);
    await runPromptfooEval(baseUrl);
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
