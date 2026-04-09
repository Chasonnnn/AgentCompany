const isReleaseBuild = process.env.PAPERCLIP_DESKTOP_BUILD_MODE === "dist";
const publishUrl = process.env.PAPERCLIP_DESKTOP_FEED_URL?.trim();

module.exports = {
  appId: "com.paperclip.desktop.local",
  productName: "Paperclip",
  directories: {
    output: isReleaseBuild ? "dist/release/raw" : "dist/package",
  },
  files: [
    "dist/**/*",
  ],
  extraResources: [
    {
      from: ".stage/server",
      to: "server",
      filter: ["**/*"],
    },
  ],
  mac: {
    category: "public.app-category.developer-tools",
    target: isReleaseBuild
      ? [
          { target: "zip", arch: ["arm64"] },
          { target: "dmg", arch: ["arm64"] },
        ]
      : [{ target: "dir", arch: ["arm64"] }],
    artifactName: "Paperclip-${version}-macos-${arch}.${ext}",
  },
  asar: true,
  compression: "store",
  npmRebuild: false,
  detectUpdateChannel: false,
  electronUpdaterCompatibility: ">=2.16",
  publish: publishUrl
    ? [
        {
          provider: "generic",
          url: publishUrl,
        },
      ]
    : undefined,
  extraMetadata: process.env.PAPERCLIP_DESKTOP_BUILD_VERSION
    ? { version: process.env.PAPERCLIP_DESKTOP_BUILD_VERSION }
    : undefined,
};
