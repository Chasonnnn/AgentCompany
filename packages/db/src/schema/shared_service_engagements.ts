import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { SharedServiceEngagementStatus } from "@paperclipai/shared";
import { companies } from "./companies.js";
import { projects } from "./projects.js";
import { agents } from "./agents.js";

export const sharedServiceEngagements = pgTable(
  "shared_service_engagements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    targetProjectId: uuid("target_project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    serviceAreaKey: text("service_area_key").notNull(),
    serviceAreaLabel: text("service_area_label").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    status: text("status").$type<SharedServiceEngagementStatus>().notNull().default("requested"),
    requestedByAgentId: uuid("requested_by_agent_id").references(() => agents.id),
    requestedByUserId: text("requested_by_user_id"),
    approvedByAgentId: uuid("approved_by_agent_id").references(() => agents.id),
    approvedByUserId: text("approved_by_user_id"),
    closedByAgentId: uuid("closed_by_agent_id").references(() => agents.id),
    closedByUserId: text("closed_by_user_id"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    outcomeSummary: text("outcome_summary"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("shared_service_engagements_company_idx").on(table.companyId),
    projectIdx: index("shared_service_engagements_project_idx").on(table.targetProjectId),
    statusIdx: index("shared_service_engagements_status_idx").on(table.companyId, table.status),
  }),
);
