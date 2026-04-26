import { createHmac } from "node:crypto";
import type { Request } from "express";
import { eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issues } from "@paperclipai/db";

const HASH_ALGORITHM = "sha256";
const HASH_PREFIX = "run-hash:";
const HASH_DIGEST_CHARS = 16;

function resolveHashSecret(): string {
  return (
    process.env.PAPERCLIP_RUNID_HASH_SECRET?.trim() ||
    process.env.PAPERCLIP_AGENT_JWT_SECRET?.trim() ||
    "paperclip-runid-redaction-fallback"
  );
}

export function hashRunId(runId: string | null | undefined): string | null {
  if (!runId) return null;
  const digest = createHmac(HASH_ALGORITHM, resolveHashSecret()).update(runId).digest("hex");
  return `${HASH_PREFIX}${digest.slice(0, HASH_DIGEST_CHARS)}`;
}

export function redactRunId(
  rawRunId: string | null | undefined,
  privileged: boolean,
): string | null {
  if (!rawRunId) return null;
  return privileged ? rawRunId : hashRunId(rawRunId);
}

export type IssueAssigneeInfo = {
  companyId: string;
  assigneeAgentId: string | null;
};

async function actorCanReadRunForAssignee(
  db: Db,
  actorAgentId: string,
  assigneeAgentId: string | null,
): Promise<boolean> {
  if (!assigneeAgentId) return false;
  if (assigneeAgentId === actorAgentId) return true;
  let cursor: string | null = assigneeAgentId;
  const visited = new Set<string>();
  for (let depth = 0; cursor && depth < 50; depth += 1) {
    if (visited.has(cursor)) return false;
    visited.add(cursor);
    const rows: { id: string; reportsTo: string | null }[] = await db
      .select({ id: agents.id, reportsTo: agents.reportsTo })
      .from(agents)
      .where(eq(agents.id, cursor));
    const row = rows[0] ?? null;
    if (!row) return false;
    if (row.reportsTo === actorAgentId) return true;
    cursor = row.reportsTo;
  }
  return false;
}

export async function isActorPrivilegedForIssue(
  db: Db,
  req: Request,
  issue: IssueAssigneeInfo,
): Promise<boolean> {
  if (req.actor.type === "board") return true;
  if (req.actor.type !== "agent" || !req.actor.agentId) return false;
  if (req.actor.companyId !== issue.companyId) return false;
  return actorCanReadRunForAssignee(db, req.actor.agentId, issue.assigneeAgentId);
}

async function loadAssigneesByIssueIds(
  db: Db,
  issueIds: string[],
): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  if (issueIds.length === 0) return result;
  const rows = await db
    .select({ id: issues.id, assigneeAgentId: issues.assigneeAgentId })
    .from(issues)
    .where(inArray(issues.id, issueIds));
  for (const row of rows) {
    result.set(row.id, row.assigneeAgentId ?? null);
  }
  return result;
}

export async function buildIssuePrivilegeResolver(
  db: Db,
  req: Request,
  companyId: string,
  issueIds: string[],
): Promise<(issueId: string) => boolean> {
  if (req.actor.type === "board") {
    return () => true;
  }
  if (req.actor.type !== "agent" || !req.actor.agentId) {
    return () => false;
  }
  if (req.actor.companyId !== companyId) {
    return () => false;
  }
  const actorAgentId = req.actor.agentId;
  const assignees = await loadAssigneesByIssueIds(db, issueIds);
  const privilegedAssigneeIds = new Set<string>();
  const checkedAssignees = new Set<string>();
  for (const assigneeAgentId of assignees.values()) {
    if (!assigneeAgentId) continue;
    if (checkedAssignees.has(assigneeAgentId)) continue;
    checkedAssignees.add(assigneeAgentId);
    if (await actorCanReadRunForAssignee(db, actorAgentId, assigneeAgentId)) {
      privilegedAssigneeIds.add(assigneeAgentId);
    }
  }
  return (issueId: string) => {
    const assignee = assignees.get(issueId);
    if (!assignee) return false;
    return privilegedAssigneeIds.has(assignee);
  };
}
