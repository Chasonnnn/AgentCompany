import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { bootstrapWorkspacePresets } from "../src/workspace/bootstrap_presets.js";
import { validateWorkspace } from "../src/workspace/validate.js";

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-"));
}

describe("workspace preset bootstrap", () => {
  test("creates selected preset departments and default session actor", async () => {
    const dir = await mkTmpDir();
    const res = await bootstrapWorkspacePresets({
      workspace_dir: dir,
      company_name: "Preset Co",
      project_name: "Alpha",
      departments: ["engineering", "design", "security"]
    });
    expect(res.company_name).toBe("Preset Co");
    expect(res.project_id.startsWith("proj_")).toBe(true);
    expect(res.departments).toHaveLength(3);
    expect(res.default_session.actor_role).toBe("director");
    expect(typeof res.default_session.actor_id).toBe("string");
    expect(typeof res.default_session.actor_team_id).toBe("string");

    const validation = await validateWorkspace(dir);
    expect(validation.ok).toBe(true);
  });

  test("falls back to a manager default session actor when director is disabled", async () => {
    const dir = await mkTmpDir();
    const res = await bootstrapWorkspacePresets({
      workspace_dir: dir,
      departments: ["operations", "qa"],
      include_director: false
    });
    expect(res.default_session.actor_role).toBe("manager");
    expect(res.departments.some((d) => d.manager_agent_id === res.default_session.actor_id)).toBe(true);
  });

  test("force reset rewrites controlled workspace state and avoids stale team accumulation", async () => {
    const dir = await mkTmpDir();
    await bootstrapWorkspacePresets({
      workspace_dir: dir,
      departments: ["engineering", "product"]
    });
    const firstTeams = await fs.readdir(path.join(dir, "org", "teams"));
    expect(firstTeams.length).toBe(2);

    await bootstrapWorkspacePresets({
      workspace_dir: dir,
      departments: ["data"],
      force: true
    });
    const secondTeams = await fs.readdir(path.join(dir, "org", "teams"));
    expect(secondTeams.length).toBe(1);
  });
});
