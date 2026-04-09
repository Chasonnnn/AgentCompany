export const STABLE_MAC_RELEASE_PATH = "desktop/latest/macos/arm64";
export const STABLE_MAC_ZIP_NAME = "Paperclip-macos-arm64.zip";
export const STABLE_MAC_DMG_NAME = "Paperclip-macos-arm64.dmg";
export const STABLE_MAC_ZIP_BLOCKMAP_NAME = `${STABLE_MAC_ZIP_NAME}.blockmap`;

export type DesktopReleaseManifestRewriteInput = {
  latestManifestText: string;
  sourceZipName: string;
  sourceDmgName: string;
  sourceZipBlockmapName: string | null;
};

function replaceAll(text: string, search: string, replacement: string): string {
  return text.split(search).join(replacement);
}

export function rewriteLatestMacManifest(input: DesktopReleaseManifestRewriteInput): string {
  let next = replaceAll(input.latestManifestText, input.sourceZipName, STABLE_MAC_ZIP_NAME);
  next = replaceAll(next, input.sourceDmgName, STABLE_MAC_DMG_NAME);
  if (input.sourceZipBlockmapName) {
    next = replaceAll(next, input.sourceZipBlockmapName, STABLE_MAC_ZIP_BLOCKMAP_NAME);
  }
  return next;
}
