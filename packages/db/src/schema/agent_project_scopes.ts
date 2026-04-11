import { pgTable, uuid, text, boolean, timestamp, index } from "drizzle-orm/pg-core";
import type { AgentProjectRole, AgentProjectScopeMode, ActorPrincipalKind } from "@paperclipai/shared";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { projects } from "./projects.js";

export const agentProjectScopes = pgTable(
  "agent_project_scopes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    scopeMode: text("scope_mode").$type<AgentProjectScopeMode>().notNull(),
    projectRole: text("project_role").$type<AgentProjectRole>().notNull(),
    isPrimary: boolean("is_primary").notNull().default(false),
    teamFunctionKey: text("team_function_key"),
    teamFunctionLabel: text("team_function_label"),
    workstreamKey: text("workstream_key"),
    workstreamLabel: text("workstream_label"),
    grantedByPrincipalType: text("granted_by_principal_type").$type<ActorPrincipalKind>(),
    grantedByPrincipalId: text("granted_by_principal_id"),
    activeFrom: timestamp("active_from", { withTimezone: true }).notNull().defaultNow(),
    activeTo: timestamp("active_to", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentIdx: index("agent_project_scopes_company_agent_idx").on(table.companyId, table.agentId),
    companyProjectIdx: index("agent_project_scopes_company_project_idx").on(table.companyId, table.projectId),
    agentProjectModeIdx: index("agent_project_scopes_agent_project_mode_idx").on(
      table.agentId,
      table.projectId,
      table.scopeMode,
    ),
  }),
);
