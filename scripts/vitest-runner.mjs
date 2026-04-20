#!/usr/bin/env node
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const mode = process.argv[2] === "run" ? "run" : "watch";
const cliArgs = process.argv.slice(3);
const pnpmBin = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

export function normalizeForwardedArgs(args) {
  let start = 0;
  while (args[start] === "--") {
    start += 1;
  }
  return args.slice(start);
}

export function buildVitestCommandArgs(runMode, args) {
  const forwardedArgs = normalizeForwardedArgs(args);
  return [
    "exec",
    "vitest",
    ...(runMode === "run" ? ["run"] : []),
    ...forwardedArgs,
  ];
}

function runCommand(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(pnpmBin, args, {
      stdio: "inherit",
      env: process.env,
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
}

function exitForSignal(signal) {
  if (signal === "SIGINT") process.exit(130);
  if (signal === "SIGTERM") process.exit(143);
  process.exit(1);
}

async function main() {
  for (const args of [["run", "preflight:workspace-links"], ["run", "test:prepare"], buildVitestCommandArgs(mode, cliArgs)]) {
    const { code, signal } = await runCommand(args);
    if (signal) {
      exitForSignal(signal);
    }
    if (typeof code === "number" && code !== 0) {
      process.exit(code);
    }
  }
}

const invokedPath = process.argv[1];
const isMainModule = typeof invokedPath === "string" && import.meta.url === pathToFileURL(invokedPath).href;

if (isMainModule) {
  main().catch((error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
