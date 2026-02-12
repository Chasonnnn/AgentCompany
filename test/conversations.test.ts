import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { initWorkspace } from "../src/workspace/init.js";
import { createTeam } from "../src/org/teams.js";
import { createAgent } from "../src/org/agents.js";
import { routeRpcMethod } from "../src/server/router.js";

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentcompany-"));
}

describe("conversations + workspace slack rpc methods", () => {
  test("creates project defaults and supports DM messaging", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "AC", force: false });

    const team = await createTeam({ workspace_dir: dir, name: "Frontend" });
    const ceo = await createAgent({
      workspace_dir: dir,
      name: "CEO",
      role: "ceo",
      provider: "manual"
    });
    const worker = await createAgent({
      workspace_dir: dir,
      name: "Frontend Worker",
      role: "worker",
      provider: "codex",
      team_id: team.team_id
    });

    const created = (await routeRpcMethod("workspace.project.create_with_defaults", {
      workspace_dir: dir,
      name: "Slack Rewrite",
      ceo_actor_id: ceo.agent_id
    })) as any;
    expect(created.project_id.startsWith("proj_")).toBe(true);
    expect(created.global_manager_agent_id).toBe("agent_global_manager");

    const projectConversations = (await routeRpcMethod("conversation.list", {
      workspace_dir: dir,
      scope: "project",
      project_id: created.project_id
    })) as any[];
    expect(projectConversations.some((c) => c.slug === "home")).toBe(true);
    expect(projectConversations.some((c) => c.slug === "executive-meeting")).toBe(true);
    expect(projectConversations.some((c) => c.slug === "frontend")).toBe(true);

    const dm = (await routeRpcMethod("conversation.create_dm", {
      workspace_dir: dir,
      scope: "project",
      project_id: created.project_id,
      created_by: ceo.agent_id,
      peer_agent_id: worker.agent_id
    })) as any;

    await routeRpcMethod("conversation.message.send", {
      workspace_dir: dir,
      scope: "project",
      project_id: created.project_id,
      conversation_id: dm.id,
      author_id: ceo.agent_id,
      author_role: "ceo",
      body: "Need status update in 20 mins."
    });

    const messages = (await routeRpcMethod("conversation.messages.list", {
      workspace_dir: dir,
      scope: "project",
      project_id: created.project_id,
      conversation_id: dm.id
    })) as any[];
    expect(messages.length).toBe(1);
    expect(messages[0].body).toContain("status update");
  });

  test("links project repos and exposes resources/profile snapshots", async () => {
    const dir = await mkTmpDir();
    await initWorkspace({ root_dir: dir, company_name: "AC", force: false });
    const ceo = await createAgent({
      workspace_dir: dir,
      name: "CEO",
      role: "ceo",
      provider: "manual"
    });
    const worker = await createAgent({
      workspace_dir: dir,
      name: "Ops Worker",
      role: "worker",
      provider: "codex",
      model_hint: "gpt-5-codex"
    });

    const created = (await routeRpcMethod("workspace.project.create_with_defaults", {
      workspace_dir: dir,
      name: "Ops",
      ceo_actor_id: ceo.agent_id,
      repo_ids: ["repo_ops"]
    })) as any;
    expect(created.repo_links.some((r: any) => r.repo_id === "repo_ops")).toBe(true);

    const linked = (await routeRpcMethod("workspace.project.link_repo", {
      workspace_dir: dir,
      project_id: created.project_id,
      repo_id: "repo_docs",
      label: "Docs Repo"
    })) as any;
    expect(linked.repos.some((r: any) => r.repo_id === "repo_docs")).toBe(true);

    const projects = (await routeRpcMethod("workspace.projects.list", {
      workspace_dir: dir
    })) as any;
    expect(Array.isArray(projects.projects)).toBe(true);
    expect(projects.projects.some((p: any) => p.project_id === created.project_id)).toBe(true);

    const resources = (await routeRpcMethod("resources.snapshot", {
      workspace_dir: dir,
      project_id: created.project_id
    })) as any;
    expect(typeof resources.totals.agents).toBe("number");

    const profile = (await routeRpcMethod("agent.profile.snapshot", {
      workspace_dir: dir,
      project_id: created.project_id,
      agent_id: worker.agent_id
    })) as any;
    expect(profile.agent.agent_id).toBe(worker.agent_id);
    expect(profile.agent.model_hint).toBe("gpt-5-codex");
  });
});
