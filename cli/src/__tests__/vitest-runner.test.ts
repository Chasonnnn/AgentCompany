import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const cliRoot = path.resolve(testDir, "..", "..");
const repoRoot = path.resolve(cliRoot, "..");
const vitestRunnerModule = path.join(repoRoot, "scripts", "vitest-runner.mjs");

describe("root vitest runner wrapper", () => {
  it("drops a leading pnpm separator before forwarding file filters", async () => {
    const { buildVitestCommandArgs } = await import(vitestRunnerModule);

    expect(
      buildVitestCommandArgs("run", ["--", "server/src/__tests__/heartbeat-comment-wake-batching.test.ts"]),
    ).toEqual(["exec", "vitest", "run", "server/src/__tests__/heartbeat-comment-wake-batching.test.ts"]);
  });

  it("preserves normal forwarded args unchanged", async () => {
    const { buildVitestCommandArgs } = await import(vitestRunnerModule);

    expect(buildVitestCommandArgs("watch", ["-t", "heartbeat"])).toEqual(["exec", "vitest", "-t", "heartbeat"]);
  });
});
