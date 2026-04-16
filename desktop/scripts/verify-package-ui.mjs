import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopDir, "..");
const require = createRequire(import.meta.url);
const {
  resolveDesktopUiBundleVerificationPaths,
  verifyDesktopUiBundle,
} = require("../dist/runtime/ui-bundle-verifier.js");

async function main() {
  const [mode] = process.argv.slice(2).filter((value) => value !== "--");
  if (mode !== "staged" && mode !== "package" && mode !== "dist") {
    throw new Error("Usage: node ./scripts/verify-package-ui.mjs <staged|package|dist>");
  }

  const paths = resolveDesktopUiBundleVerificationPaths({
    repoRoot,
    desktopDir,
    mode,
  });

  const diff = await verifyDesktopUiBundle(paths);
  console.log(
    `Verified ${mode} desktop UI bundle parity (${diff.sourceFileCount} source files, ${diff.targetFileCount} target files).`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
