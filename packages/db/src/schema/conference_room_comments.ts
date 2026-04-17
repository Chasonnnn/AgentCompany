import { type AnyPgColumn, pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import type { ConferenceRoomMessageType } from "@paperclipai/shared";
import { companies } from "./companies.js";
import { conferenceRooms } from "./conference_rooms.js";
import { agents } from "./agents.js";

export const conferenceRoomComments = pgTable(
  "conference_room_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    conferenceRoomId: uuid("conference_room_id").notNull().references(() => conferenceRooms.id, { onDelete: "cascade" }),
    parentCommentId: uuid("parent_comment_id").references((): AnyPgColumn => conferenceRoomComments.id, { onDelete: "set null" }),
    authorAgentId: uuid("author_agent_id").references(() => agents.id, { onDelete: "set null" }),
    authorUserId: text("author_user_id"),
    messageType: text("message_type").$type<ConferenceRoomMessageType>().notNull().default("note"),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    roomIdx: index("conference_room_comments_room_idx").on(table.conferenceRoomId),
    roomCreatedIdx: index("conference_room_comments_room_created_idx").on(
      table.conferenceRoomId,
      table.createdAt,
    ),
    roomParentIdx: index("conference_room_comments_room_parent_idx").on(table.conferenceRoomId, table.parentCommentId),
    companyIdx: index("conference_room_comments_company_idx").on(table.companyId),
  }),
);
