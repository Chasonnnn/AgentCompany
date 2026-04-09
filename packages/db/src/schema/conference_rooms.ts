import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import type { ConferenceRoomStatus } from "@paperclipai/shared";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const conferenceRooms = pgTable(
  "conference_rooms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    agenda: text("agenda"),
    status: text("status").$type<ConferenceRoomStatus>().notNull().default("open"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusCreatedIdx: index("conference_rooms_company_status_created_idx").on(
      table.companyId,
      table.status,
      table.createdAt,
    ),
    companyUpdatedIdx: index("conference_rooms_company_updated_idx").on(table.companyId, table.updatedAt),
  }),
);
