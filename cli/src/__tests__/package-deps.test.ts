import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const cliRoot = path.resolve(testDir, "..", "..");

describe("cli package runtime dependencies", () => {
  it("declares every external esbuild dependency in cli/package.json", async () => {
    const configModule = await import(path.join(cliRoot, "esbuild.config.mjs"));
    const cliPackageJson = JSON.parse(
      fs.readFileSync(path.join(cliRoot, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };

    const declaredDeps = new Set(Object.keys(cliPackageJson.dependencies ?? {}));
    const missing = (configModule.default.external as string[])
      .filter((name) => !declaredDeps.has(name))
      .sort();

    expect(missing).toEqual([]);
  });
});
