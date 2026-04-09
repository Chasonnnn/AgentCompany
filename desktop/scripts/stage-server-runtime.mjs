import { rm } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopDir, "..");
const stageDir = path.join(desktopDir, ".stage", "server");
const require = createRequire(import.meta.url);
const { normalizeStagedWorkspacePackages } = require("../dist/runtime/staged-package-manifest.js");

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: "inherit",
      env: process.env,
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} failed with ${signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`}.`,
        ),
      );
    });
  });
}

const pnpmBin = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

async function main() {
  await rm(stageDir, { recursive: true, force: true });

  console.log("==> Staging Paperclip desktop server runtime");
  console.log("  [1/3] Preparing static UI bundle...");
  await run(pnpmBin, ["--dir", repoRoot, "--filter", "@paperclipai/server", "prepare:ui-dist"]);

  console.log("  [2/3] Building server runtime and workspace dependencies...");
  await run(pnpmBin, ["--dir", repoRoot, "--filter", "@paperclipai/server...", "build"]);

  console.log("  [3/3] Deploying standalone server package...");
  await run(pnpmBin, ["--dir", repoRoot, "--filter", "@paperclipai/server", "deploy", "--prod", stageDir]);

  const rewrittenCount = await normalizeStagedWorkspacePackages(stageDir);
  console.log(`  -> Normalized ${rewrittenCount} staged workspace package manifest${rewrittenCount === 1 ? "" : "s"} for runtime exports`);

  console.log(`Desktop server runtime staged at ${stageDir}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
