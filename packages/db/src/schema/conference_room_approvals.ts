import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { conferenceRooms } from "./conference_rooms.js";
import { approvals } from "./approvals.js";
import { agents } from "./agents.js";

export const conferenceRoomApprovals = pgTable(
  "conference_room_approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    conferenceRoomId: uuid("conference_room_id").notNull().references(() => conferenceRooms.id, { onDelete: "cascade" }),
    approvalId: uuid("approval_id").notNull().references(() => approvals.id, { onDelete: "cascade" }),
    linkedByAgentId: uuid("linked_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    linkedByUserId: text("linked_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    roomIdx: index("conference_room_approvals_room_idx").on(table.conferenceRoomId),
    approvalIdx: index("conference_room_approvals_approval_idx").on(table.approvalId),
    companyIdx: index("conference_room_approvals_company_idx").on(table.companyId),
    roomApprovalIdx: uniqueIndex("conference_room_approvals_room_approval_idx").on(
      table.conferenceRoomId,
      table.approvalId,
    ),
    approvalUniqueIdx: uniqueIndex("conference_room_approvals_approval_unique_idx").on(table.approvalId),
  }),
);
