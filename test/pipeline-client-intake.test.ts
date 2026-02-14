import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { bootstrapWorkspacePresets } from "../src/workspace/bootstrap_presets.js";
import { runClientIntakePipeline } from "../src/pipeline/client_intake_run.js";
import { validateMarkdownArtifact } from "../src/artifacts/markdown.js";
import { listProjectTasks } from "../src/work/tasks_list.js";

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-client-intake-"));
}

async function readArtifact(workspaceDir: string, projectId: string, artifactId: string): Promise<string> {
  return fs.readFile(
    path.join(workspaceDir, "work", "projects", projectId, "artifacts", `${artifactId}.md`),
    { encoding: "utf8" }
  );
}

describe("pipeline client intake", () => {
  test("generates intake -> executive plan -> meeting transcript -> department plans and gates worker execution", async () => {
    const dir = await mkTmpDir();
    const boot = await bootstrapWorkspacePresets({
      workspace_dir: dir,
      org_mode: "enterprise",
      departments: ["frontend", "backend"]
    });
    const ceo = boot.agents.ceo_agent_id;
    const exec = boot.agents.executive_manager_agent_id;
    if (!ceo || !exec) {
      throw new Error("enterprise bootstrap did not return ceo/executive manager");
    }

    const out = await runClientIntakePipeline({
      workspace_dir: dir,
      project_name: "CRM Tool",
      ceo_actor_id: ceo,
      executive_manager_agent_id: exec,
      intake_text: "Build a CRM with contacts, pipeline, and activity tracking."
    });

    expect(out.project_id.startsWith("proj_")).toBe(true);
    expect(typeof out.meeting_conversation_id).toBe("string");
    expect(Object.keys(out.department_plan_artifact_ids)).toHaveLength(2);

    const intakeMd = await readArtifact(dir, out.project_id, out.artifacts.intake_brief_artifact_id);
    const intakeVal = validateMarkdownArtifact(intakeMd);
    expect(intakeVal.ok).toBe(true);
    if (!intakeVal.ok) return;
    expect(intakeVal.frontmatter.type).toBe("intake_brief");

    const executiveMd = await readArtifact(dir, out.project_id, out.artifacts.executive_plan_artifact_id);
    const executiveVal = validateMarkdownArtifact(executiveMd);
    expect(executiveVal.ok).toBe(true);
    if (!executiveVal.ok) return;
    expect(executiveVal.frontmatter.type).toBe("executive_plan");

    const transcriptMd = await readArtifact(
      dir,
      out.project_id,
      out.artifacts.meeting_transcript_artifact_id
    );
    const transcriptVal = validateMarkdownArtifact(transcriptMd);
    expect(transcriptVal.ok).toBe(true);
    if (!transcriptVal.ok) return;
    expect(transcriptVal.frontmatter.type).toBe("meeting_transcript");

    for (const artifactId of Object.values(out.department_plan_artifact_ids)) {
      const md = await readArtifact(dir, out.project_id, artifactId);
      const val = validateMarkdownArtifact(md);
      expect(val.ok).toBe(true);
      if (!val.ok) return;
      expect(val.frontmatter.type).toBe("department_plan");
    }

    const tasks = await listProjectTasks({
      workspace_dir: dir,
      project_id: out.project_id
    });
    const allWorkerIds = new Set(boot.departments.flatMap((d) => d.worker_agent_ids));
    const workerTasks = tasks.filter((t) => t.frontmatter.assignee_agent_id && allWorkerIds.has(t.frontmatter.assignee_agent_id));
    expect(workerTasks).toHaveLength(0);
  }, 20_000);
});

