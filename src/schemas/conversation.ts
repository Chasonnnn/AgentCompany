import { z } from "zod";
import { IsoDateTime, SchemaVersion, Visibility } from "./common.js";

export const ConversationScope = z.enum(["workspace", "project"]);
export const ConversationKind = z.enum(["home", "channel", "dm"]);

export const ConversationParticipants = z
  .object({
    agent_ids: z.array(z.string().min(1)).default([]),
    team_ids: z.array(z.string().min(1)).default([])
  })
  .strict();

export const ConversationYaml = z
  .object({
    schema_version: SchemaVersion,
    type: z.literal("conversation"),
    id: z.string().min(1),
    scope: ConversationScope,
    project_id: z.string().min(1).optional(),
    kind: ConversationKind,
    name: z.string().min(1),
    slug: z.string().min(1),
    visibility: Visibility,
    created_at: IsoDateTime,
    created_by: z.string().min(1),
    auto_generated: z.boolean().default(false),
    participants: ConversationParticipants,
    dm_peer_agent_id: z.string().min(1).optional()
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.scope === "project" && !v.project_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "project_id is required when scope=project",
        path: ["project_id"]
      });
    }
    if (v.scope === "workspace" && v.project_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "project_id is not allowed when scope=workspace",
        path: ["project_id"]
      });
    }
    if (v.kind === "dm" && !v.dm_peer_agent_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "dm_peer_agent_id is required for dm conversations",
        path: ["dm_peer_agent_id"]
      });
    }
  });

export type ConversationYaml = z.infer<typeof ConversationYaml>;
