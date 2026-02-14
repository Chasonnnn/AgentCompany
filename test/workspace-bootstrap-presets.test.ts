import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { bootstrapWorkspacePresets } from "../src/workspace/bootstrap_presets.js";
import { validateWorkspace } from "../src/workspace/validate.js";
import { listAgents } from "../src/org/agents_list.js";
import { readHeartbeatConfig } from "../src/runtime/heartbeat_store.js";

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-"));
}

describe("workspace preset bootstrap", () => {
  test("enterprise mode creates executive manager and director+worker staffing per department", async () => {
    const dir = await mkTmpDir();
    const res = await bootstrapWorkspacePresets({
      workspace_dir: dir,
      company_name: "Preset Co",
      project_name: "Alpha",
      org_mode: "enterprise",
      departments: ["frontend", "backend", "data"],
      workers_per_dept: 2
    });
    expect(res.company_name).toBe("Preset Co");
    expect(res.org_mode).toBe("enterprise");
    expect(res.project_id.startsWith("proj_")).toBe(true);
    expect(res.departments).toHaveLength(3);
    expect(res.agents.director_agent_id).toBeUndefined();
    expect(typeof res.agents.executive_manager_agent_id).toBe("string");
    expect(res.default_session.actor_role).toBe("manager");
    expect(res.default_session.actor_id).toBe(res.agents.executive_manager_agent_id);
    expect(typeof res.default_session.actor_id).toBe("string");
    for (const dept of res.departments) {
      expect(typeof dept.director_agent_id).toBe("string");
      expect(dept.worker_agent_ids.length).toBe(2);
    }

    const agents = await listAgents({ workspace_dir: dir });
    const globalDirectors = agents.filter((a) => a.role === "director" && !a.team_id);
    expect(globalDirectors).toHaveLength(0);
    const heartbeatConfig = await readHeartbeatConfig(dir);
    expect(heartbeatConfig.hierarchy_mode).toBe("enterprise_v1");
    expect(heartbeatConfig.executive_manager_agent_id).toBe(res.agents.executive_manager_agent_id);
    expect(heartbeatConfig.allow_director_to_spawn_workers).toBe(true);

    const validation = await validateWorkspace(dir);
    expect(validation.ok).toBe(true);
  });

  test("standard mode can still use a global director default actor", async () => {
    const dir = await mkTmpDir();
    const res = await bootstrapWorkspacePresets({
      workspace_dir: dir,
      org_mode: "standard",
      departments: ["operations", "qa"]
    });
    expect(res.org_mode).toBe("standard");
    expect(res.default_session.actor_role).toBe("director");
    expect(res.agents.director_agent_id).toBe(res.default_session.actor_id);
  });

  test("force reset rewrites controlled workspace state and avoids stale team accumulation", async () => {
    const dir = await mkTmpDir();
    await bootstrapWorkspacePresets({
      workspace_dir: dir,
      org_mode: "enterprise",
      departments: ["frontend", "backend"]
    });
    const firstTeams = await fs.readdir(path.join(dir, "org", "teams"));
    expect(firstTeams.length).toBe(2);

    await bootstrapWorkspacePresets({
      workspace_dir: dir,
      org_mode: "enterprise",
      departments: ["data"],
      force: true
    });
    const secondTeams = await fs.readdir(path.join(dir, "org", "teams"));
    expect(secondTeams.length).toBe(1);
  }, 15000);
});
