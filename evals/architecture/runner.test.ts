import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evalSummaryIndexSchema } from "../../packages/shared/src/index.js";
import { executeSeededRun, materializeScenarioFixture, rebuildSummaryFromArtifactRoot } from "./core.js";
import { getBundlesForLane, getScenarioById } from "./scenarios.js";

const tempDirs: string[] = [];

async function createTempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "paperclip-evals-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("architecture eval runner", () => {
  it("materializes portable fixtures with overlays and cleans them up", async () => {
    const scenario = getScenarioById("director-tech-lead-handoff-quality");
    const materialized = await materializeScenarioFixture({
      repoRoot: process.cwd(),
      scenario,
    });

    const decisionLog = await readFile(path.join(materialized.targetDir, "projects/platform/decision-log.md"), "utf8");
    expect(decisionLog).toContain("Handoff requested");

    await materialized.cleanup();
    await expect(readFile(materialized.targetDir, "utf8")).rejects.toBeTruthy();
  });

  it("rebuilds the summary index from raw artifacts", async () => {
    const artifactRoot = await createTempDir();
    const bundle = getBundlesForLane("canary")[0]!;
    const scenario = getScenarioById(bundle.scenarioIds[0]!);

    await executeSeededRun({
      repoRoot: process.cwd(),
      artifactRoot,
      bundle,
      scenario,
      seed: 11,
    });

    const summary = await rebuildSummaryFromArtifactRoot(artifactRoot);
    expect(evalSummaryIndexSchema.parse(summary)).toMatchObject({
      runCount: 1,
    });
    expect(summary.runs[0]?.scenarioId).toBe(scenario.id);
  });

  it("keeps fairness constraints identical across baseline bundle comparisons", () => {
    const bundles = getBundlesForLane("baseline");
    const scenario = getScenarioById("hierarchy-vs-flat-vs-single-agent");
    const serialized = JSON.stringify(scenario.fairnessConstraints);

    expect(bundles.length).toBeGreaterThanOrEqual(3);
    for (const bundle of bundles) {
      expect(bundle.scenarioIds).toContain("hierarchy-vs-flat-vs-single-agent");
      expect(JSON.stringify(scenario.fairnessConstraints)).toBe(serialized);
    }
  });
});
