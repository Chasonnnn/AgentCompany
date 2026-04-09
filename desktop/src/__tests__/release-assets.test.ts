import { describe, expect, test } from "vitest";
import {
  rewriteLatestMacManifest,
  STABLE_MAC_DMG_NAME,
  STABLE_MAC_ZIP_BLOCKMAP_NAME,
  STABLE_MAC_ZIP_NAME,
} from "../runtime/release-assets.js";

describe("release-assets", () => {
  test("rewrites latest-mac.yml to stable Pages filenames", () => {
    const original = `
version: 0.3.1-main.482
files:
  - url: Paperclip-0.3.1-main.482-macos-arm64.zip
    sha512: zipsha
    size: 123
  - url: Paperclip-0.3.1-main.482-macos-arm64.dmg
    sha512: dmgsha
    size: 456
path: Paperclip-0.3.1-main.482-macos-arm64.zip
packages:
  arm64:
    blockMapSize: 99
    path: Paperclip-0.3.1-main.482-macos-arm64.zip.blockmap
`;

    expect(
      rewriteLatestMacManifest({
        latestManifestText: original,
        sourceZipName: "Paperclip-0.3.1-main.482-macos-arm64.zip",
        sourceDmgName: "Paperclip-0.3.1-main.482-macos-arm64.dmg",
        sourceZipBlockmapName: "Paperclip-0.3.1-main.482-macos-arm64.zip.blockmap",
      }),
    ).toContain(`url: ${STABLE_MAC_ZIP_NAME}`);
    expect(
      rewriteLatestMacManifest({
        latestManifestText: original,
        sourceZipName: "Paperclip-0.3.1-main.482-macos-arm64.zip",
        sourceDmgName: "Paperclip-0.3.1-main.482-macos-arm64.dmg",
        sourceZipBlockmapName: "Paperclip-0.3.1-main.482-macos-arm64.zip.blockmap",
      }),
    ).toContain(`url: ${STABLE_MAC_DMG_NAME}`);
    expect(
      rewriteLatestMacManifest({
        latestManifestText: original,
        sourceZipName: "Paperclip-0.3.1-main.482-macos-arm64.zip",
        sourceDmgName: "Paperclip-0.3.1-main.482-macos-arm64.dmg",
        sourceZipBlockmapName: "Paperclip-0.3.1-main.482-macos-arm64.zip.blockmap",
      }),
    ).toContain(`path: ${STABLE_MAC_ZIP_BLOCKMAP_NAME}`);
  });
});
