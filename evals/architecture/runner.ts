import path from "node:path";
import { getBundlesForLane, getScenarioById } from "./scenarios.js";
import { getDefaultArtifactRoot, rebuildSummaryFromArtifactRoot, runObservedLane, runSeededLane } from "./core.js";

type Command = "run" | "run-observed" | "rebuild-summary";

function readArg(flag: string, args: string[]) {
  const index = args.indexOf(flag);
  if (index < 0) return null;
  return args[index + 1] ?? null;
}

function readCommand(args: string[]): Command {
  const command = (args[0] ?? "run") as Command;
  if (command !== "run" && command !== "run-observed" && command !== "rebuild-summary") {
    throw new Error(`Unknown eval runner command '${command}'.`);
  }
  return command;
}

async function main() {
  const args = process.argv.slice(2);
  const command = readCommand(args);
  const artifactRoot = readArg("--artifact-root", args) ?? getDefaultArtifactRoot();

  if (command === "rebuild-summary") {
    const summary = await rebuildSummaryFromArtifactRoot(artifactRoot);
    process.stdout.write(`${JSON.stringify({
      artifactRoot,
      generatedAt: summary.generatedAt,
      runCount: summary.runCount,
    }, null, 2)}\n`);
    return;
  }

  if (command === "run-observed") {
    const lookbackHours = Number.parseInt(readArg("--lookback-hours", args) ?? "24", 10);
    const maxRuns = Number.parseInt(readArg("--max-runs", args) ?? "12", 10);
    const seedValue = readArg("--seed", args);
    const seed = seedValue ? Number.parseInt(seedValue, 10) : undefined;
    const result = await runObservedLane({
      repoRoot: path.resolve(process.cwd()),
      artifactRoot,
      lookbackHours,
      maxRuns,
      seed,
    });
    process.stdout.write(`${JSON.stringify({
      artifactRoot,
      runCount: result.artifacts.length,
      latestRunId: result.summary.latestRunId,
      sourceKind: "observed",
    }, null, 2)}\n`);
    return;
  }

  const lane = (readArg("--lane", args) ?? "canary") as "canary" | "nightly" | "soak" | "baseline";
  const scenarioId = readArg("--scenario", args);
  const seedValue = readArg("--seed", args);
  const seed = seedValue ? Number.parseInt(seedValue, 10) : undefined;
  const repoRoot = process.cwd();
  const bundles = getBundlesForLane(lane);

  for (const bundle of bundles) {
    const scenarios = bundle.scenarioIds
      .map((id) => getScenarioById(id))
      .filter((scenario) => (scenarioId ? scenario.id === scenarioId : true));
    if (scenarios.length === 0) continue;

    const result = await runSeededLane({
      repoRoot: path.resolve(repoRoot),
      artifactRoot,
      bundle,
      scenarios,
      seed,
    });

    process.stdout.write(`${JSON.stringify({
      bundleId: bundle.id,
      lane,
      artifactRoot,
      runCount: result.artifacts.length,
      latestRunId: result.summary.latestRunId,
    }, null, 2)}\n`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
