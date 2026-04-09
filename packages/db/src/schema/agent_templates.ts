import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import type { AgentCapabilityProfileKey, AgentOperatingClass, AgentRole } from "@paperclipai/shared";
import { companies } from "./companies.js";

export const agentTemplates = pgTable(
  "agent_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    name: text("name").notNull(),
    role: text("role").$type<AgentRole>().notNull().default("general"),
    operatingClass: text("operating_class").$type<AgentOperatingClass>().notNull().default("worker"),
    capabilityProfileKey: text("capability_profile_key")
      .$type<AgentCapabilityProfileKey>()
      .notNull()
      .default("worker"),
    archetypeKey: text("archetype_key").notNull().default("general"),
    metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyArchivedIdx: index("agent_templates_company_archived_idx").on(table.companyId, table.archivedAt),
  }),
);
