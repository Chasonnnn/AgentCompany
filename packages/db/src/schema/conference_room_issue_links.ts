import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { conferenceRooms } from "./conference_rooms.js";
import { issues } from "./issues.js";
import { agents } from "./agents.js";

export const conferenceRoomIssueLinks = pgTable(
  "conference_room_issue_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    conferenceRoomId: uuid("conference_room_id").notNull().references(() => conferenceRooms.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    linkedByAgentId: uuid("linked_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    linkedByUserId: text("linked_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    roomIdx: index("conference_room_issue_links_room_idx").on(table.conferenceRoomId),
    issueIdx: index("conference_room_issue_links_issue_idx").on(table.issueId),
    companyIdx: index("conference_room_issue_links_company_idx").on(table.companyId),
    roomIssueIdx: uniqueIndex("conference_room_issue_links_room_issue_idx").on(
      table.conferenceRoomId,
      table.issueId,
    ),
  }),
);
