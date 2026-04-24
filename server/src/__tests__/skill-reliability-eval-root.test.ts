import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadArchitectureScenarioIds,
  loadPromptfooCaseIds,
  resolveEvalRoot,
} from "../services/skill-reliability.ts";

async function seedEvalTree(root: string) {
  const testsDir = path.join(root, "evals", "promptfoo", "tests");
  await fs.mkdir(testsDir, { recursive: true });
  await fs.writeFile(
    path.join(testsDir, "reliability.yaml"),
    [
      "tests:",
      "  - description: \"reliability.review_activation - route to review skill\"",
      "  - description: \"reliability.adapt_activation - route to adapt skill\"",
      "  - description: \"reliability.skill_disambiguation - pick the right sibling\"",
    ].join("\n"),
    "utf8",
  );
  const archDir = path.join(root, "evals", "architecture");
  await fs.mkdir(archDir, { recursive: true });
  await fs.writeFile(
    path.join(archDir, "scenarios.ts"),
    [
      "export const scenarios = [",
      "  { id: \"architecture.packaged_eval_discovery\" },",
      "  { id: \"architecture.workspace_cwd_resolution\" },",
      "];",
    ].join("\n"),
    "utf8",
  );
}

async function makeTempDir(label: string) {
  return fs.mkdtemp(path.join(os.tmpdir(), `skill-reliability-${label}-`));
}

describe("eval root resolution for skill reliability audit", () => {
  let workspaceDir = "";
  let packagedServerCwd = "";

  beforeEach(async () => {
    workspaceDir = await makeTempDir("workspace");
    packagedServerCwd = await makeTempDir("packaged-server");
    await seedEvalTree(workspaceDir);
    await fs.mkdir(path.join(packagedServerCwd, "dist"), { recursive: true });
    await fs.writeFile(path.join(packagedServerCwd, "package.json"), "{}", "utf8");
  });

  afterEach(async () => {
    for (const dir of [workspaceDir, packagedServerCwd]) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    vi.restoreAllMocks();
  });

  it("discovers eval files in a workspace cwd even when process.cwd() points at packaged app resources", async () => {
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(packagedServerCwd);

    const evalRoot = await resolveEvalRoot([workspaceDir]);
    expect(evalRoot).toBe(workspaceDir);

    const promptfooIds = await loadPromptfooCaseIds(evalRoot);
    expect(promptfooIds.has("reliability.review_activation")).toBe(true);
    expect(promptfooIds.has("reliability.adapt_activation")).toBe(true);
    expect(promptfooIds.has("reliability.skill_disambiguation")).toBe(true);

    const scenarioIds = await loadArchitectureScenarioIds(evalRoot);
    expect(scenarioIds.has("architecture.packaged_eval_discovery")).toBe(true);

    cwdSpy.mockRestore();
  });

  it("returns missing cases accurately so unknown_promptfoo_case still fires for genuinely absent ids", async () => {
    const evalRoot = await resolveEvalRoot([workspaceDir]);
    const promptfooIds = await loadPromptfooCaseIds(evalRoot);
    expect(promptfooIds.has("reliability.vercel_react_native_activation")).toBe(false);
  });

  it("falls back to process.cwd() when no workspace candidates are provided and cwd holds the evals tree", async () => {
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);
    const evalRoot = await resolveEvalRoot([]);
    expect(evalRoot).toBe(workspaceDir);
    cwdSpy.mockRestore();
  });

  it("returns null when neither workspace candidates nor process.cwd() contain evals (no silent empty registry masquerading as success)", async () => {
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(packagedServerCwd);
    const emptyCandidate = await makeTempDir("no-evals");
    try {
      const evalRoot = await resolveEvalRoot([emptyCandidate]);
      expect(evalRoot).toBeNull();

      const promptfooIds = await loadPromptfooCaseIds(evalRoot);
      expect(promptfooIds.size).toBe(0);

      const scenarioIds = await loadArchitectureScenarioIds(evalRoot);
      expect(scenarioIds.size).toBe(0);
    } finally {
      await fs.rm(emptyCandidate, { recursive: true, force: true }).catch(() => {});
      cwdSpy.mockRestore();
    }
  });

  it("prefers the first workspace candidate in priority order over later ones", async () => {
    const otherWorkspace = await makeTempDir("workspace-secondary");
    await seedEvalTree(otherWorkspace);
    try {
      const evalRoot = await resolveEvalRoot([workspaceDir, otherWorkspace]);
      expect(evalRoot).toBe(workspaceDir);
    } finally {
      await fs.rm(otherWorkspace, { recursive: true, force: true }).catch(() => {});
    }
  });
});
