import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { initWorkspace } from "../src/workspace/init.js";
import { createTeam } from "../src/org/teams.js";
import { createAgent } from "../src/org/agents.js";
import { createProject } from "../src/work/projects.js";
import { createRun } from "../src/runtime/run.js";
import { proposeMemoryDelta } from "../src/memory/propose_memory_delta.js";
import { startUiWebServer } from "../src/ui/web_server.js";

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-"));
}

describe("ui web server", () => {
  test("serves snapshot and resolve APIs", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const { team_id } = await createTeam({ workspace_dir: dir, name: "Payments" });
    const mgr = await createAgent({
      workspace_dir: dir,
      name: "Manager",
      role: "manager",
      provider: "cmd",
      team_id
    });
    const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });
    const { run_id, context_pack_id } = await createRun({
      workspace_dir: dir,
      project_id,
      agent_id: mgr.agent_id,
      provider: "cmd"
    });
    const proposed = await proposeMemoryDelta({
      workspace_dir: dir,
      project_id,
      title: "Web pending",
      under_heading: "## Decisions",
      insert_lines: ["- web item"],
      visibility: "managers",
      produced_by: mgr.agent_id,
      run_id,
      context_pack_id
    });

    const web = await startUiWebServer({
      workspace_dir: dir,
      project_id,
      actor_id: mgr.agent_id,
      actor_role: "manager",
      actor_team_id: team_id,
      host: "127.0.0.1",
      port: 0
    });

    try {
      const healthRes = await fetch(`${web.url}/api/health`);
      expect(healthRes.status).toBe(200);
      const health = (await healthRes.json()) as any;
      expect(health.ok).toBe(true);

      const snapRes = await fetch(`${web.url}/api/ui/snapshot`);
      expect(snapRes.status).toBe(200);
      const snap = (await snapRes.json()) as any;
      expect(snap.review_inbox.pending.some((p: any) => p.artifact_id === proposed.artifact_id)).toBe(
        true
      );

      const resolveRes = await fetch(`${web.url}/api/ui/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ artifact_id: proposed.artifact_id, decision: "denied", notes: "No" })
      });
      expect(resolveRes.status).toBe(200);
      const resolved = (await resolveRes.json()) as any;
      expect(resolved.resolved.decision).toBe("denied");
      expect(
        resolved.snapshot.review_inbox.pending.some((p: any) => p.artifact_id === proposed.artifact_id)
      ).toBe(false);

      const snapAfterRes = await fetch(`${web.url}/api/ui/snapshot`);
      const snapAfter = (await snapAfterRes.json()) as any;
      expect(
        snapAfter.review_inbox.recent_decisions.some(
          (d: any) => d.subject_artifact_id === proposed.artifact_id && d.decision === "denied"
        )
      ).toBe(true);

      const commentRes = await fetch(`${web.url}/api/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          target_agent_id: mgr.agent_id,
          target_artifact_id: proposed.artifact_id,
          body: "Looks good after revision."
        })
      });
      expect(commentRes.status).toBe(200);
      const commentPayload = (await commentRes.json()) as any;
      expect(commentPayload.comment?.target?.artifact_id).toBe(proposed.artifact_id);
      expect(commentPayload.comment?.target?.agent_id).toBe(mgr.agent_id);
      expect(
        commentPayload.snapshot.comments.some(
          (c: any) => c.id === commentPayload.comment.id && c.body === "Looks good after revision."
        )
      ).toBe(true);
    } finally {
      await web.close();
    }
  });

  test("serves manager web page", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "Acme" });
    const { project_id } = await createProject({ workspace_dir: dir, name: "Proj" });

    const web = await startUiWebServer({
      workspace_dir: dir,
      project_id,
      actor_id: "human",
      actor_role: "manager",
      host: "127.0.0.1",
      port: 0
    });

    try {
      const pageRes = await fetch(`${web.url}/`);
      expect(pageRes.status).toBe(200);
      const html = await pageRes.text();
      expect(html).toContain("AgentCompany Manager Web");
      expect(html).toContain("Pending Approvals");
      expect(html).toContain("Run Monitor");
    } finally {
      await web.close();
    }
  });
});
