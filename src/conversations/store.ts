import fs from "node:fs/promises";
import path from "node:path";
import type { Dirent } from "node:fs";
import { newId } from "../core/ids.js";
import { nowIso } from "../core/time.js";
import { appendFileAtomic, ensureDir, pathExists, writeFileAtomic } from "../store/fs.js";
import { readYamlFile, writeYamlFile } from "../store/yaml.js";
import { ConversationYaml, type ConversationYaml as ConversationYamlType } from "../schemas/conversation.js";
import { MessageJson, type MessageJson as MessageJsonType } from "../schemas/message.js";
import type { EventVisibility } from "../runtime/events.js";

export type ConversationScope = "workspace" | "project";

function workspaceHomeDir(workspaceDir: string): string {
  return path.join(workspaceDir, "inbox", "workspace_home");
}

function workspaceConversationsRoot(workspaceDir: string): string {
  return path.join(workspaceDir, "inbox", "conversations");
}

function projectConversationsRoot(workspaceDir: string, projectId: string): string {
  return path.join(workspaceDir, "work", "projects", projectId, "conversations");
}

function conversationDirFromDoc(workspaceDir: string, conversation: ConversationYamlType): string {
  if (conversation.scope === "workspace") {
    if (conversation.slug === "home") return workspaceHomeDir(workspaceDir);
    return path.join(workspaceConversationsRoot(workspaceDir), conversation.id);
  }
  if (!conversation.project_id) {
    throw new Error(`Conversation ${conversation.id} missing project_id for project scope`);
  }
  return path.join(projectConversationsRoot(workspaceDir, conversation.project_id), conversation.id);
}

function conversationFiles(dir: string): { yaml: string; messages: string } {
  return {
    yaml: path.join(dir, "conversation.yaml"),
    messages: path.join(dir, "messages.jsonl")
  };
}

async function ensureConversationFiles(workspaceDir: string, conversation: ConversationYamlType): Promise<void> {
  const dir = conversationDirFromDoc(workspaceDir, conversation);
  const files = conversationFiles(dir);
  await ensureDir(dir);
  await writeYamlFile(files.yaml, conversation);
  if (!(await pathExists(files.messages))) {
    await writeFileAtomic(files.messages, "");
  }
}

async function readConversationYaml(file: string): Promise<ConversationYamlType | null> {
  try {
    return ConversationYaml.parse(await readYamlFile(file));
  } catch {
    return null;
  }
}

async function listWorkspaceConversations(workspaceDir: string): Promise<ConversationYamlType[]> {
  const out: ConversationYamlType[] = [];

  const home = await readConversationYaml(path.join(workspaceHomeDir(workspaceDir), "conversation.yaml"));
  if (home) out.push(home);

  let entries: Dirent[] = [];
  try {
    entries = await fs.readdir(workspaceConversationsRoot(workspaceDir), { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const doc = await readConversationYaml(
      path.join(workspaceConversationsRoot(workspaceDir), entry.name, "conversation.yaml")
    );
    if (doc) out.push(doc);
  }
  return out;
}

async function listProjectConversations(workspaceDir: string, projectId: string): Promise<ConversationYamlType[]> {
  const root = projectConversationsRoot(workspaceDir, projectId);
  let entries: Dirent[] = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: ConversationYamlType[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const doc = await readConversationYaml(path.join(root, entry.name, "conversation.yaml"));
    if (doc) out.push(doc);
  }
  return out;
}

function sortConversations(rows: ConversationYamlType[]): ConversationYamlType[] {
  const rank = (c: ConversationYamlType): number => {
    if (c.slug === "home") return 0;
    if (c.slug === "executive-office") return 1;
    if (c.slug === "planning-council") return 2;
    if (c.slug === "executive-meeting") return 3;
    if (c.kind === "channel") return 4;
    if (c.kind === "dm") return 5;
    return 6;
  };
  return [...rows].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    return a.name.localeCompare(b.name);
  });
}

function messageFileFromConversation(workspaceDir: string, c: ConversationYamlType): string {
  return conversationFiles(conversationDirFromDoc(workspaceDir, c)).messages;
}

export async function listConversations(args: {
  workspace_dir: string;
  scope: ConversationScope;
  project_id?: string;
}): Promise<ConversationYamlType[]> {
  if (args.scope === "workspace") {
    return sortConversations(await listWorkspaceConversations(args.workspace_dir));
  }
  if (!args.project_id) return [];
  return sortConversations(await listProjectConversations(args.workspace_dir, args.project_id));
}

export async function readConversation(args: {
  workspace_dir: string;
  scope: ConversationScope;
  conversation_id: string;
  project_id?: string;
}): Promise<ConversationYamlType | null> {
  const rows = await listConversations({
    workspace_dir: args.workspace_dir,
    scope: args.scope,
    project_id: args.project_id
  });
  return rows.find((c) => c.id === args.conversation_id) ?? null;
}

export async function upsertConversation(args: {
  workspace_dir: string;
  conversation: ConversationYamlType;
}): Promise<ConversationYamlType> {
  const conversation = ConversationYaml.parse(args.conversation);
  await ensureConversationFiles(args.workspace_dir, conversation);
  return conversation;
}

export async function createConversation(args: {
  workspace_dir: string;
  scope: ConversationScope;
  project_id?: string;
  kind: "home" | "channel" | "dm";
  name: string;
  slug: string;
  visibility: EventVisibility;
  created_by: string;
  auto_generated?: boolean;
  participants?: {
    agent_ids?: string[];
    team_ids?: string[];
  };
  dm_peer_agent_id?: string;
  id?: string;
}): Promise<ConversationYamlType> {
  const createdAt = nowIso();
  const conv = ConversationYaml.parse({
    schema_version: 1,
    type: "conversation",
    id: args.id ?? newId("conv"),
    scope: args.scope,
    project_id: args.scope === "project" ? args.project_id : undefined,
    kind: args.kind,
    name: args.name.trim(),
    slug: args.slug.trim(),
    visibility: args.visibility,
    created_at: createdAt,
    created_by: args.created_by,
    auto_generated: args.auto_generated ?? false,
    participants: {
      agent_ids: [...new Set((args.participants?.agent_ids ?? []).filter(Boolean))],
      team_ids: [...new Set((args.participants?.team_ids ?? []).filter(Boolean))]
    },
    dm_peer_agent_id: args.dm_peer_agent_id
  });
  await ensureConversationFiles(args.workspace_dir, conv);
  return conv;
}

export async function listConversationMessages(args: {
  workspace_dir: string;
  scope: ConversationScope;
  conversation_id: string;
  project_id?: string;
  limit?: number;
}): Promise<MessageJsonType[]> {
  const conv = await readConversation({
    workspace_dir: args.workspace_dir,
    scope: args.scope,
    project_id: args.project_id,
    conversation_id: args.conversation_id
  });
  if (!conv) return [];
  const limit = Math.max(1, Math.min(args.limit ?? 300, 5000));
  const file = messageFileFromConversation(args.workspace_dir, conv);
  let s = "";
  try {
    s = await fs.readFile(file, { encoding: "utf8" });
  } catch {
    return [];
  }
  const parsed: MessageJsonType[] = [];
  for (const line of s.split("\n").map((l) => l.trim()).filter(Boolean)) {
    try {
      const msg = MessageJson.parse(JSON.parse(line));
      parsed.push(msg);
    } catch {
      // best-effort; malformed lines should not break timeline rendering.
    }
  }
  parsed.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
  return parsed.slice(Math.max(0, parsed.length - limit));
}

export async function sendConversationMessage(args: {
  workspace_dir: string;
  scope: ConversationScope;
  conversation_id: string;
  project_id?: string;
  body: string;
  author_id: string;
  author_role: "human" | "ceo" | "director" | "manager" | "worker";
  visibility?: EventVisibility;
  kind?: "text" | "system" | "report";
  mentions?: string[];
}): Promise<{ conversation: ConversationYamlType; message: MessageJsonType }> {
  const body = args.body.trim();
  if (!body) throw new Error("Message body is required");

  const conversation = await readConversation({
    workspace_dir: args.workspace_dir,
    scope: args.scope,
    project_id: args.project_id,
    conversation_id: args.conversation_id
  });
  if (!conversation) throw new Error(`Conversation not found: ${args.conversation_id}`);

  const message = MessageJson.parse({
    schema_version: 1,
    type: "message",
    id: newId("msg"),
    conversation_id: conversation.id,
    project_id: conversation.project_id,
    created_at: nowIso(),
    author_id: args.author_id,
    author_role: args.author_role,
    kind: args.kind ?? "text",
    visibility: args.visibility ?? conversation.visibility,
    body,
    mentions: [...new Set(args.mentions ?? [])]
  });
  const file = messageFileFromConversation(args.workspace_dir, conversation);
  await appendFileAtomic(file, `${JSON.stringify(message)}\n`, { workspace_lock: false });
  return { conversation, message };
}
