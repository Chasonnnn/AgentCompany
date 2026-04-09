import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const {
  createDesktopBuildMetadata,
  readDesktopPackageVersion,
  writeDesktopBuildMetadata,
} = require("../dist/runtime/build-metadata.js");

async function main() {
  const packageVersion = await readDesktopPackageVersion(path.join(desktopDir, "package.json"));
  const metadata = createDesktopBuildMetadata({
    packageVersion,
    env: process.env,
  });
  const metadataPath = await writeDesktopBuildMetadata({
    baseDir: desktopDir,
    metadata,
  });

  console.log(`Desktop build metadata written to ${metadataPath}`);
  console.log(`  version=${metadata.version}`);
  console.log(`  channel=${metadata.channel}`);
  console.log(`  feedUrl=${metadata.feedUrl ?? "disabled"}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
