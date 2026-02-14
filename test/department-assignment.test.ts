import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { bootstrapWorkspacePresets } from "../src/workspace/bootstrap_presets.js";
import { runClientIntakePipeline } from "../src/pipeline/client_intake_run.js";
import { assignDepartmentTasks } from "../src/pipeline/department_assignment.js";
import { resolveInboxItem } from "../src/inbox/resolve.js";

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-dept-assign-"));
}

describe("department assignment", () => {
  test("requires CEO approval link before assignment and still denies cross-team assignment with audit log", async () => {
    const dir = await mkTmpDir();
    const boot = await bootstrapWorkspacePresets({
      workspace_dir: dir,
      org_mode: "enterprise",
      departments: ["frontend", "backend"]
    });
    const ceo = boot.agents.ceo_agent_id;
    const exec = boot.agents.executive_manager_agent_id;
    if (!ceo || !exec) throw new Error("missing ceo/executive manager");

    const intake = await runClientIntakePipeline({
      workspace_dir: dir,
      project_name: "CRM",
      ceo_actor_id: ceo,
      executive_manager_agent_id: exec,
      intake_text: "CRM for SMB sales teams."
    });

    const frontend = boot.departments.find((d) => d.department_key === "frontend");
    const backend = boot.departments.find((d) => d.department_key === "backend");
    if (!frontend || !backend) throw new Error("expected frontend/backend departments");

    await expect(
      assignDepartmentTasks({
        workspace_dir: dir,
        project_id: intake.project_id,
        department_key: "frontend",
        director_agent_id: frontend.director_agent_id,
        worker_agent_ids: [frontend.worker_agent_ids[0]!],
        approved_executive_plan_artifact_id: intake.artifacts.executive_plan_artifact_id
      })
    ).rejects.toThrow(/CEO approval required/i);

    await resolveInboxItem({
      workspace_dir: dir,
      project_id: intake.project_id,
      artifact_id: intake.artifacts.approval_artifact_id,
      decision: "approved",
      actor_id: ceo,
      actor_role: "ceo"
    });

    const allowed = await assignDepartmentTasks({
      workspace_dir: dir,
      project_id: intake.project_id,
      department_key: "frontend",
      director_agent_id: frontend.director_agent_id,
      worker_agent_ids: [frontend.worker_agent_ids[0]!],
      approved_executive_plan_artifact_id: intake.artifacts.executive_plan_artifact_id
    });

    expect(allowed.created_task_ids.length).toBeGreaterThan(0);
    expect(allowed.denied_assignments).toHaveLength(0);

    const denied = await assignDepartmentTasks({
      workspace_dir: dir,
      project_id: intake.project_id,
      department_key: "frontend",
      director_agent_id: frontend.director_agent_id,
      worker_agent_ids: [backend.worker_agent_ids[0]!],
      approved_executive_plan_artifact_id: intake.artifacts.executive_plan_artifact_id
    });

    expect(denied.created_task_ids).toHaveLength(0);
    expect(denied.denied_assignments).toHaveLength(1);
    expect(denied.denied_assignments[0]?.reason).toMatch(/team/i);
    expect(typeof denied.audit_log_relpath).toBe("string");

    const logAbs = path.join(dir, denied.audit_log_relpath);
    const log = await fs.readFile(logAbs, { encoding: "utf8" });
    expect(log).toContain("cross_team_assignment_denied");
  });
});
