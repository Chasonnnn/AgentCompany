import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { AgentYaml } from "../schemas/agent.js";
import { TeamYaml } from "../schemas/team.js";
import { readYamlFile } from "../store/yaml.js";
import type { RunMonitorSnapshot } from "./run_monitor.js";
import type { ReviewInboxSnapshot } from "./review_inbox.js";

export type UiColleagueStatus = "active" | "needs_review" | "idle";

export type UiColleague = {
  agent_id: string;
  name: string;
  role: "ceo" | "director" | "manager" | "worker";
  provider: string;
  team_id?: string;
  team_name?: string;
  active_runs: number;
  total_runs: number;
  pending_reviews: number;
  recent_decisions: number;
  last_seen_at?: string;
  status: UiColleagueStatus;
};

type BuildColleaguesArgs = {
  workspace_dir: string;
  monitor: RunMonitorSnapshot;
  review_inbox: ReviewInboxSnapshot;
};

type MutableColleague = UiColleague;

function roleRank(role: UiColleague["role"]): number {
  switch (role) {
    case "ceo":
      return 0;
    case "director":
      return 1;
    case "manager":
      return 2;
    case "worker":
      return 3;
  }
}

function maxIso(a: string | undefined, b: string | null | undefined): string | undefined {
  if (!b) return a;
  if (!a) return b;
  return a >= b ? a : b;
}

async function readTeamMap(workspaceDir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const teamsDir = path.join(workspaceDir, "org", "teams");
  let entries: Dirent[] = [];
  try {
    entries = await fs.readdir(teamsDir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const abs = path.join(teamsDir, entry.name, "team.yaml");
    try {
      const parsed = TeamYaml.safeParse(await readYamlFile(abs));
      if (!parsed.success) continue;
      out.set(parsed.data.id, parsed.data.name);
    } catch {
      // best-effort
    }
  }
  return out;
}

async function readAgents(
  workspaceDir: string,
  teamNames: Map<string, string>
): Promise<Map<string, MutableColleague>> {
  const out = new Map<string, MutableColleague>();
  const agentsDir = path.join(workspaceDir, "org", "agents");
  let entries: Dirent[] = [];
  try {
    entries = await fs.readdir(agentsDir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const abs = path.join(agentsDir, entry.name, "agent.yaml");
    try {
      const parsed = AgentYaml.safeParse(await readYamlFile(abs));
      if (!parsed.success) continue;
      const a = parsed.data;
      out.set(a.id, {
        agent_id: a.id,
        name: a.name,
        role: a.role,
        provider: a.provider,
        team_id: a.team_id,
        team_name: a.team_id ? teamNames.get(a.team_id) : undefined,
        active_runs: 0,
        total_runs: 0,
        pending_reviews: 0,
        recent_decisions: 0,
        last_seen_at: undefined,
        status: "idle"
      });
    } catch {
      // best-effort
    }
  }

  return out;
}

function finalizeStatus(c: MutableColleague): void {
  if (c.active_runs > 0) {
    c.status = "active";
    return;
  }
  if (c.pending_reviews > 0) {
    c.status = "needs_review";
    return;
  }
  c.status = "idle";
}

export async function buildUiColleagues(args: BuildColleaguesArgs): Promise<UiColleague[]> {
  const teamNames = await readTeamMap(args.workspace_dir);
  const colleagues = await readAgents(args.workspace_dir, teamNames);

  for (const run of args.monitor.rows) {
    const agentId = run.agent_id;
    if (!agentId) continue;
    const c = colleagues.get(agentId);
    if (!c) continue;
    c.total_runs += 1;
    if (run.live_status === "running" || run.run_status === "running") {
      c.active_runs += 1;
    }
    c.last_seen_at = maxIso(c.last_seen_at, run.last_event?.ts_wallclock ?? run.created_at);
  }

  for (const pending of args.review_inbox.pending) {
    const producer = pending.produced_by;
    if (!producer) continue;
    const c = colleagues.get(producer);
    if (!c) continue;
    c.pending_reviews += 1;
    c.last_seen_at = maxIso(c.last_seen_at, pending.created_at);
  }

  for (const decision of args.review_inbox.recent_decisions) {
    const actor = decision.actor_id;
    const c = colleagues.get(actor);
    if (!c) continue;
    c.recent_decisions += 1;
    c.last_seen_at = maxIso(c.last_seen_at, decision.created_at);
  }

  const out = Array.from(colleagues.values());
  for (const c of out) finalizeStatus(c);

  out.sort((a, b) => {
    if (a.active_runs !== b.active_runs) return b.active_runs - a.active_runs;
    if (a.pending_reviews !== b.pending_reviews) return b.pending_reviews - a.pending_reviews;
    if ((a.last_seen_at ?? "") !== (b.last_seen_at ?? "")) {
      return (a.last_seen_at ?? "") < (b.last_seen_at ?? "") ? 1 : -1;
    }
    const roleCmp = roleRank(a.role) - roleRank(b.role);
    if (roleCmp !== 0) return roleCmp;
    return a.name.localeCompare(b.name);
  });

  return out;
}
