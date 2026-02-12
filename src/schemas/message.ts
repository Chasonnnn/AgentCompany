import { z } from "zod";
import { IsoDateTime, SchemaVersion, Visibility } from "./common.js";
import { ActorRole } from "./review.js";

export const MessageKind = z.enum(["text", "system", "report"]);

export const MessageJson = z
  .object({
    schema_version: SchemaVersion,
    type: z.literal("message"),
    id: z.string().min(1),
    conversation_id: z.string().min(1),
    project_id: z.string().min(1).optional(),
    created_at: IsoDateTime,
    author_id: z.string().min(1),
    author_role: ActorRole,
    kind: MessageKind.default("text"),
    visibility: Visibility,
    body: z.string().min(1),
    mentions: z.array(z.string().min(1)).default([])
  })
  .strict();

export type MessageJson = z.infer<typeof MessageJson>;
