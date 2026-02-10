import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { demoInit } from "../src/demo/demo_init.js";
import { scaffoldProjectIntake } from "../src/pipeline/intake_scaffold.js";
import { validateWorkspace } from "../src/workspace/validate.js";

async function mkTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-"));
  return dir;
}

describe("pipeline intake scaffold", () => {
  test("scaffoldProjectIntake creates tasks and artifacts that validate", async () => {
    const dir = await mkTmpDir();
    const demo = await demoInit({ workspace_dir: dir, company_name: "DemoCo" });

    const res = await scaffoldProjectIntake({
      workspace_dir: dir,
      project_name: "New Project",
      ceo_agent_id: demo.agents.ceo_agent_id,
      director_agent_id: demo.agents.director_agent_id,
      manager_agent_ids: [
        demo.agents.payments_manager_agent_id,
        demo.agents.growth_manager_agent_id
      ]
    });

    expect(res.project_id).toMatch(/^proj_/);
    const intakeArtifact = path.join(
      dir,
      "work/projects",
      res.project_id,
      "artifacts",
      `${res.artifacts.intake_brief_artifact_id}.md`
    );
    await fs.access(intakeArtifact);

    const validate = await validateWorkspace(dir);
    expect(validate.ok).toBe(true);
  });
});

