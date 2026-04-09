import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { conferenceRooms } from "./conference_rooms.js";
import { agents } from "./agents.js";

export const conferenceRoomParticipants = pgTable(
  "conference_room_participants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    conferenceRoomId: uuid("conference_room_id").notNull().references(() => conferenceRooms.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    addedByAgentId: uuid("added_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    addedByUserId: text("added_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    roomIdx: index("conference_room_participants_room_idx").on(table.conferenceRoomId),
    agentIdx: index("conference_room_participants_agent_idx").on(table.agentId),
    companyIdx: index("conference_room_participants_company_idx").on(table.companyId),
    roomAgentIdx: uniqueIndex("conference_room_participants_room_agent_idx").on(
      table.conferenceRoomId,
      table.agentId,
    ),
  }),
);
