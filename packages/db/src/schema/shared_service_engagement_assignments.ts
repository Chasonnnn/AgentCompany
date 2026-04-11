import { index, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { sharedServiceEngagements } from "./shared_service_engagements.js";

export const sharedServiceEngagementAssignments = pgTable(
  "shared_service_engagement_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    engagementId: uuid("engagement_id")
      .notNull()
      .references(() => sharedServiceEngagements.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyEngagementIdx: index("shared_service_eng_assignments_company_engagement_idx").on(
      table.companyId,
      table.engagementId,
    ),
    agentIdx: index("shared_service_eng_assignments_agent_idx").on(table.agentId),
    engagementAgentUq: uniqueIndex("shared_service_eng_assignments_engagement_agent_uq").on(
      table.engagementId,
      table.agentId,
    ),
  }),
);
