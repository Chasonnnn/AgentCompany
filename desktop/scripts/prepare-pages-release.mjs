import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const {
  loadDesktopBuildMetadata,
  resolveDesktopBuildMetadataPath,
} = require("../dist/runtime/build-metadata.js");
const {
  STABLE_MAC_DMG_NAME,
  STABLE_MAC_RELEASE_PATH,
  STABLE_MAC_ZIP_BLOCKMAP_NAME,
  STABLE_MAC_ZIP_NAME,
  rewriteLatestMacManifest,
} = require("../dist/runtime/release-assets.js");

function readArgValue(flagName) {
  const index = process.argv.indexOf(flagName);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

async function findArtifact(inputRoot, matcher) {
  const entries = await readdir(inputRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (matcher(entry.name)) return path.join(inputRoot, entry.name);
  }
  return null;
}

async function main() {
  const inputRoot = path.resolve(
    desktopDir,
    readArgValue("--input-root") ?? path.join("dist", "release", "raw"),
  );
  const outputRoot = path.resolve(
    desktopDir,
    readArgValue("--output-dir") ?? path.join("dist", "release", "pages", STABLE_MAC_RELEASE_PATH),
  );

  if (!existsSync(inputRoot)) {
    throw new Error(`Desktop release input directory not found: ${inputRoot}`);
  }

  const zipPath = await findArtifact(inputRoot, (name) => name.endsWith(".zip") && !name.endsWith(".blockmap"));
  const dmgPath = await findArtifact(inputRoot, (name) => name.endsWith(".dmg"));
  const manifestPath = await findArtifact(
    inputRoot,
    (name) => name === "latest-mac.yml" || name.endsWith("-mac.yml"),
  );
  if (!zipPath || !dmgPath || !manifestPath) {
    throw new Error(`Missing zip, dmg, or latest-mac.yml in ${inputRoot}`);
  }

  const zipBlockmapPath = `${zipPath}.blockmap`;
  const latestManifestText = await readFile(manifestPath, "utf8");
  const rewrittenManifest = rewriteLatestMacManifest({
    latestManifestText,
    sourceZipName: path.basename(zipPath),
    sourceDmgName: path.basename(dmgPath),
    sourceZipBlockmapName: existsSync(zipBlockmapPath) ? path.basename(zipBlockmapPath) : null,
  });

  const metadataPath = resolveDesktopBuildMetadataPath(desktopDir);
  const metadata = loadDesktopBuildMetadata(metadataPath);
  if (!metadata) {
    throw new Error(`Desktop build metadata not found at ${metadataPath}`);
  }

  await mkdir(outputRoot, { recursive: true });
  await cp(zipPath, path.join(outputRoot, STABLE_MAC_ZIP_NAME));
  await cp(dmgPath, path.join(outputRoot, STABLE_MAC_DMG_NAME));
  if (existsSync(zipBlockmapPath)) {
    await cp(zipBlockmapPath, path.join(outputRoot, STABLE_MAC_ZIP_BLOCKMAP_NAME));
  }
  await writeFile(path.join(outputRoot, "latest-mac.yml"), rewrittenManifest);
  await writeFile(
    path.join(outputRoot, "build.json"),
    `${JSON.stringify(
      {
        channel: metadata.channel,
        version: metadata.version,
        commitSha: metadata.commitSha,
        builtAt: metadata.builtAt,
        feedUrl: metadata.feedUrl,
      },
      null,
      2,
    )}\n`,
  );

  console.log(`Desktop Pages release prepared at ${outputRoot}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
