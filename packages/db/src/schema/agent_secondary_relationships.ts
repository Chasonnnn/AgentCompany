import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import type { AgentSecondaryRelationshipType, ActorPrincipalKind } from "@paperclipai/shared";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const agentSecondaryRelationships = pgTable(
  "agent_secondary_relationships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    relatedAgentId: uuid("related_agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    relationshipType: text("relationship_type").$type<AgentSecondaryRelationshipType>().notNull(),
    createdByPrincipalType: text("created_by_principal_type").$type<ActorPrincipalKind>(),
    createdByPrincipalId: text("created_by_principal_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentRelationshipIdx: index("agent_secondary_relationships_company_agent_relationship_idx").on(
      table.companyId,
      table.agentId,
      table.relationshipType,
    ),
  }),
);
