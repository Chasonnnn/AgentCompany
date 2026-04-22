import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { issues } from "./issues.js";
import { projects } from "./projects.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const budgetReservations = pgTable(
  "budget_reservations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    heartbeatRunId: uuid("heartbeat_run_id").notNull().references(() => heartbeatRuns.id, { onDelete: "cascade" }),
    scopeType: text("scope_type").notNull(),
    scopeId: uuid("scope_id"),
    metric: text("metric").notNull().default("billed_cents"),
    reservedCents: integer("reserved_cents").notNull().default(0),
    actualCostEventId: uuid("actual_cost_event_id"),
    status: text("status").notNull().default("reserved"),
    retryDisposition: text("retry_disposition").notNull().default("charge_full"),
    reason: text("reason"),
    metadataJson: jsonb("metadata_json").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
    releasedAt: timestamp("released_at", { withTimezone: true }),
  },
  (table) => ({
    companyRunIdx: index("budget_reservations_company_run_idx").on(table.companyId, table.heartbeatRunId),
    companyScopeIdx: index("budget_reservations_company_scope_idx").on(
      table.companyId,
      table.scopeType,
      table.scopeId,
      table.status,
    ),
    companyStatusIdx: index("budget_reservations_company_status_idx").on(table.companyId, table.status, table.createdAt),
  }),
);
