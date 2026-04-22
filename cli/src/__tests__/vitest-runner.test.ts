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

  it("caps default Vitest worker env for repo-script runs", async () => {
    const { buildVitestEnv, getDefaultVitestWorkerCount } = await import(vitestRunnerModule);

    const env = buildVitestEnv({});

    expect(env.VITEST_MAX_FORKS).toMatch(/^\d+$/);
    expect(env.VITEST_MAX_THREADS).toBe(env.VITEST_MAX_FORKS);
    expect(getDefaultVitestWorkerCount(2)).toBe(1);
    expect(getDefaultVitestWorkerCount(8)).toBe(2);
    expect(getDefaultVitestWorkerCount(32)).toBe(2);
  });

  it("preserves explicit Vitest worker overrides", async () => {
    const { buildVitestEnv } = await import(vitestRunnerModule);

    const env = buildVitestEnv({
      VITEST_MAX_FORKS: "3",
      VITEST_MAX_THREADS: "2",
    });

    expect(env.VITEST_MAX_FORKS).toBe("3");
    expect(env.VITEST_MAX_THREADS).toBe("2");
  });
});
