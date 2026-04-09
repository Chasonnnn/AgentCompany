import { pgTable, uuid, text, integer, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agentTemplates } from "./agent_templates.js";
import { agents } from "./agents.js";

export const agentTemplateRevisions = pgTable(
  "agent_template_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    templateId: uuid("template_id").notNull().references(() => agentTemplates.id, { onDelete: "cascade" }),
    revisionNumber: integer("revision_number").notNull(),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    templateRevisionIdx: uniqueIndex("agent_template_revisions_template_revision_idx").on(
      table.templateId,
      table.revisionNumber,
    ),
    companyTemplateIdx: index("agent_template_revisions_company_template_idx").on(table.companyId, table.templateId),
  }),
);
