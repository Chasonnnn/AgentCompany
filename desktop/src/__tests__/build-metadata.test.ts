import { describe, expect, test } from "vitest";
import {
  createDesktopBuildMetadata,
  resolveDesktopBuildVersion,
} from "../runtime/build-metadata.js";

describe("build-metadata", () => {
  test("stamps CI release versions with a main prerelease suffix", () => {
    expect(
      resolveDesktopBuildVersion({
        packageVersion: "0.3.1",
        channel: "main",
        runNumber: "482",
      }),
    ).toBe("0.3.1-main.482");
  });

  test("writes desktop build metadata with a normalized feed URL", () => {
    expect(
      createDesktopBuildMetadata({
        packageVersion: "0.3.1",
        builtAt: "2026-04-08T22:00:00.000Z",
        env: {
          PAPERCLIP_DESKTOP_RELEASE_CHANNEL: "main",
          PAPERCLIP_DESKTOP_FEED_URL: "https://example.com/desktop/latest/macos/arm64/",
          GITHUB_SHA: "abc123",
          PAPERCLIP_DESKTOP_BUILD_VERSION: "0.3.1-main.482",
        },
      }),
    ).toEqual({
      channel: "main",
      feedUrl: "https://example.com/desktop/latest/macos/arm64",
      commitSha: "abc123",
      builtAt: "2026-04-08T22:00:00.000Z",
      version: "0.3.1-main.482",
    });
  });
});
