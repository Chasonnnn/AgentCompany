import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { conferenceRooms } from "./conference_rooms.js";
import { agents } from "./agents.js";

export const conferenceRoomComments = pgTable(
  "conference_room_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    conferenceRoomId: uuid("conference_room_id").notNull().references(() => conferenceRooms.id, { onDelete: "cascade" }),
    authorAgentId: uuid("author_agent_id").references(() => agents.id, { onDelete: "set null" }),
    authorUserId: text("author_user_id"),
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
    companyIdx: index("conference_room_comments_company_idx").on(table.companyId),
  }),
);
