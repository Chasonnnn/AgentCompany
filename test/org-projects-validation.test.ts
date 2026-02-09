import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { initWorkspace } from "../src/workspace/init.js";
import { validateWorkspace } from "../src/workspace/validate.js";
import { createTeam } from "../src/org/teams.js";
import { createAgent } from "../src/org/agents.js";
import { createProject } from "../src/work/projects.js";

async function mkTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-"));
  return dir;
}

describe("workspace validation: org and projects", () => {
  test("invalid team.yaml is reported", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const { team_id } = await createTeam({ workspace_dir: dir, name: "Payments" });
    // Break schema_version
    const teamYamlPath = path.join(dir, "org/teams", team_id, "team.yaml");
    const raw = await fs.readFile(teamYamlPath, { encoding: "utf8" });
    await fs.writeFile(teamYamlPath, raw.replace("schema_version: 1", "schema_version: "), {
      encoding: "utf8"
    });

    const res = await validateWorkspace(dir);
    expect(res.ok).toBe(false);
  });

  test("invalid agent.yaml is reported", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const { team_id } = await createTeam({ workspace_dir: dir, name: "Payments" });
    const { agent_id } = await createAgent({
      workspace_dir: dir,
      name: "Mallory",
      role: "worker",
      provider: "codex",
      team_id
    });
    const agentYamlPath = path.join(dir, "org/agents", agent_id, "agent.yaml");
    const raw = await fs.readFile(agentYamlPath, { encoding: "utf8" });
    await fs.writeFile(agentYamlPath, raw.replace("type: agent", "type: not_agent"), {
      encoding: "utf8"
    });
    const res = await validateWorkspace(dir);
    expect(res.ok).toBe(false);
  });

  test("invalid project.yaml is reported", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const { project_id } = await createProject({ workspace_dir: dir, name: "Project X" });
    const projectYamlPath = path.join(dir, "work/projects", project_id, "project.yaml");
    const raw = await fs.readFile(projectYamlPath, { encoding: "utf8" });
    await fs.writeFile(projectYamlPath, raw.replace("status: active", "status: nope"), {
      encoding: "utf8"
    });
    const res = await validateWorkspace(dir);
    expect(res.ok).toBe(false);
  });
});

