import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  diffDesktopUiBundle,
  resolveDesktopUiBundleVerificationPaths,
  verifyDesktopUiBundle,
} from "../runtime/ui-bundle-verifier.js";

const tempDirs: string[] = [];

async function createTempDir(prefix: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function writeBundleFile(root: string, relativePath: string, content: string) {
  const targetPath = path.join(root, ...relativePath.split("/"));
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, content);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("ui-bundle-verifier", () => {
  test("accepts matching bundle trees", async () => {
    const sourceDir = await createTempDir("paperclip-ui-source-");
    const targetDir = await createTempDir("paperclip-ui-target-");

    await writeBundleFile(sourceDir, "index.html", "<html>fresh</html>");
    await writeBundleFile(sourceDir, "assets/index.js", "console.log('fresh');");
    await writeBundleFile(targetDir, "index.html", "<html>fresh</html>");
    await writeBundleFile(targetDir, "assets/index.js", "console.log('fresh');");

    await expect(
      verifyDesktopUiBundle({
        mode: "staged",
        sourceDir,
        targetDir,
        targetLabel: "desktop staged runtime",
      }),
    ).resolves.toMatchObject({
      sourceFileCount: 2,
      targetFileCount: 2,
      missingInTarget: [],
      extraInTarget: [],
      mismatched: [],
    });
  });

  test("reports missing, extra, and mismatched files", async () => {
    const sourceDir = await createTempDir("paperclip-ui-source-");
    const targetDir = await createTempDir("paperclip-ui-target-");

    await writeBundleFile(sourceDir, "index.html", "<html>fresh</html>");
    await writeBundleFile(sourceDir, "assets/index.js", "console.log('fresh');");
    await writeBundleFile(targetDir, "index.html", "<html>stale</html>");
    await writeBundleFile(targetDir, "assets/legacy.js", "console.log('legacy');");

    await expect(
      diffDesktopUiBundle({
        mode: "package",
        sourceDir,
        targetDir,
        targetLabel: "packaged desktop app",
      }),
    ).resolves.toEqual({
      sourceFileCount: 2,
      targetFileCount: 2,
      missingInTarget: ["assets/index.js"],
      extraInTarget: ["assets/legacy.js"],
      mismatched: ["index.html"],
    });
  });

  test("resolves staged and packaged verification paths", () => {
    const repoRoot = "/Users/chason/paperclip";
    const desktopDir = "/Users/chason/paperclip/desktop";

    expect(resolveDesktopUiBundleVerificationPaths({ repoRoot, desktopDir, mode: "staged" })).toEqual({
      mode: "staged",
      sourceDir: "/Users/chason/paperclip/server/ui-dist",
      targetDir: "/Users/chason/paperclip/desktop/.stage/server/ui-dist",
      targetLabel: "desktop staged runtime",
    });

    expect(resolveDesktopUiBundleVerificationPaths({ repoRoot, desktopDir, mode: "package" })).toEqual({
      mode: "package",
      sourceDir: "/Users/chason/paperclip/server/ui-dist",
      targetDir: "/Users/chason/paperclip/desktop/dist/package/mac-arm64/Paperclip.app/Contents/Resources/server/ui-dist",
      targetLabel: "packaged desktop app",
    });

    expect(resolveDesktopUiBundleVerificationPaths({ repoRoot, desktopDir, mode: "dist" })).toEqual({
      mode: "dist",
      sourceDir: "/Users/chason/paperclip/server/ui-dist",
      targetDir: "/Users/chason/paperclip/desktop/dist/release/raw/mac-arm64/Paperclip.app/Contents/Resources/server/ui-dist",
      targetLabel: "dist raw desktop app bundle",
    });
  });
});
