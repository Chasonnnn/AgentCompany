import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveStaticUiDist } from "../app.js";

describe("resolveStaticUiDist", () => {
  const dirname = "/repo/server/dist";
  const workspaceUiDist = path.resolve(dirname, "../../ui/dist");
  const packagedUiDist = path.resolve(dirname, "../ui-dist");

  it("prefers the workspace ui build over packaged ui-dist in a local checkout", () => {
    const uiDist = resolveStaticUiDist(dirname, (indexHtmlPath) => {
      return (
        indexHtmlPath === path.join(workspaceUiDist, "index.html") ||
        indexHtmlPath === path.join(packagedUiDist, "index.html")
      );
    });

    expect(uiDist).toBe(workspaceUiDist);
  });

  it("falls back to packaged ui-dist when the workspace build is absent", () => {
    const uiDist = resolveStaticUiDist(dirname, (indexHtmlPath) => {
      return indexHtmlPath === path.join(packagedUiDist, "index.html");
    });

    expect(uiDist).toBe(packagedUiDist);
  });

  it("returns null when no static ui bundle is available", () => {
    expect(resolveStaticUiDist(dirname, () => false)).toBeNull();
  });
});
