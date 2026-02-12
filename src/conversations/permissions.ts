import type { ConversationYaml } from "../schemas/conversation.js";

export type ConversationAccessArgs = {
  conversation: ConversationYaml;
  actor_id: string;
  actor_role: "human" | "ceo" | "director" | "manager" | "worker";
  actor_team_id?: string;
};

export function canAccessConversation(args: ConversationAccessArgs): boolean {
  if (args.actor_role === "human" || args.actor_role === "ceo") return true;

  const c = args.conversation;
  if (c.visibility === "org") return true;
  if (c.visibility === "managers") {
    return args.actor_role === "director" || args.actor_role === "manager";
  }

  if (c.participants.agent_ids.includes(args.actor_id)) return true;
  if (args.actor_team_id && c.participants.team_ids.includes(args.actor_team_id)) return true;

  // DMs are participant-scoped.
  if (c.kind === "dm") return false;
  if (c.visibility === "team") return false;
  return false;
}
