import fs from "node:fs/promises";
import path from "node:path";
import { newId } from "../core/ids.js";
import { nowIso } from "../core/time.js";
import { appendEventJsonl, newEnvelope } from "../runtime/events.js";
import { CommentYaml, type CommentYaml as CommentYamlType } from "../schemas/comment.js";
import { ensureDir, pathExists } from "../store/fs.js";
import { readYamlFile, writeYamlFile } from "../store/yaml.js";

export type CreateCommentArgs = {
  workspace_dir: string;
  project_id: string;
  author_id: string;
  author_role: "human" | "ceo" | "director" | "manager" | "worker";
  body: string;
  target_agent_id?: string;
  target_artifact_id?: string;
  target_run_id?: string;
  visibility?: "private_agent" | "team" | "managers" | "org";
};

export type CommentEntry = CommentYamlType;

export type ListCommentsArgs = {
  workspace_dir: string;
  project_id: string;
  target_agent_id?: string;
  target_artifact_id?: string;
  target_run_id?: string;
  limit?: number;
};

function commentsDir(workspaceDir: string): string {
  return path.join(workspaceDir, "inbox", "comments");
}

function commentFilePath(workspaceDir: string, commentId: string): string {
  return path.join(commentsDir(workspaceDir), `${commentId}.yaml`);
}

async function maybeAppendCommentEvent(comment: CommentEntry, workspaceDir: string): Promise<void> {
  const runId = comment.target.run_id;
  if (!runId) return;
  const eventsPath = path.join(
    workspaceDir,
    "work",
    "projects",
    comment.target.project_id,
    "runs",
    runId,
    "events.jsonl"
  );
  if (!(await pathExists(eventsPath))) return;

  const ev = newEnvelope({
    schema_version: 1,
    ts_wallclock: comment.created_at,
    run_id: runId,
    session_ref: `local_comment_${comment.id}`,
    actor: comment.author_id,
    visibility: comment.visibility,
    type: "comment.added",
    payload: {
      comment_id: comment.id,
      project_id: comment.target.project_id,
      agent_id: comment.target.agent_id,
      artifact_id: comment.target.artifact_id,
      body: comment.body
    }
  });
  await appendEventJsonl(eventsPath, ev);
}

export async function createComment(args: CreateCommentArgs): Promise<{ comment_id: string; comment: CommentEntry }> {
  const body = args.body.trim();
  if (!body) throw new Error("Comment body is required");

  const target_agent_id = args.target_agent_id?.trim();
  const target_artifact_id = args.target_artifact_id?.trim();
  const target_run_id = args.target_run_id?.trim();
  if (!target_agent_id && !target_artifact_id && !target_run_id) {
    throw new Error("Comment target requires one of: target_agent_id, target_artifact_id, target_run_id");
  }

  const id = newId("cmt");
  const created_at = nowIso();
  const comment = CommentYaml.parse({
    schema_version: 1,
    type: "comment",
    id,
    created_at,
    author_id: args.author_id,
    author_role: args.author_role,
    visibility: args.visibility ?? "managers",
    target: {
      project_id: args.project_id,
      agent_id: target_agent_id,
      artifact_id: target_artifact_id,
      run_id: target_run_id
    },
    body
  });

  const dir = commentsDir(args.workspace_dir);
  await ensureDir(dir);
  await writeYamlFile(commentFilePath(args.workspace_dir, id), comment);
  await maybeAppendCommentEvent(comment, args.workspace_dir);

  return { comment_id: id, comment };
}

export async function listComments(args: ListCommentsArgs): Promise<CommentEntry[]> {
  const limit = Math.max(1, Math.min(args.limit ?? 300, 5000));
  const dir = commentsDir(args.workspace_dir);
  let files: string[] = [];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith(".yaml")).sort().reverse();
  } catch {
    return [];
  }

  const out: CommentEntry[] = [];
  for (const f of files) {
    if (out.length >= limit) break;
    try {
      const parsed = CommentYaml.safeParse(await readYamlFile(path.join(dir, f)));
      if (!parsed.success) continue;
      const c = parsed.data;
      if (c.target.project_id !== args.project_id) continue;
      if (args.target_agent_id && c.target.agent_id !== args.target_agent_id) continue;
      if (args.target_artifact_id && c.target.artifact_id !== args.target_artifact_id) continue;
      if (args.target_run_id && c.target.run_id !== args.target_run_id) continue;
      out.push(c);
    } catch {
      // best-effort
    }
  }

  out.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  return out.slice(0, limit);
}
