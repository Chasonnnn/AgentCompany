import { integer, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { PortfolioClusterStatus } from "@paperclipai/shared";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const portfolioClusters = pgTable(
  "portfolio_clusters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    summary: text("summary"),
    status: text("status").$type<PortfolioClusterStatus>().notNull().default("active"),
    sortOrder: integer("sort_order").notNull().default(0),
    executiveSponsorAgentId: uuid("executive_sponsor_agent_id").references(() => agents.id),
    portfolioDirectorAgentId: uuid("portfolio_director_agent_id").references(() => agents.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("portfolio_clusters_company_idx").on(table.companyId),
    companySlugUq: uniqueIndex("portfolio_clusters_company_slug_uq").on(table.companyId, table.slug),
  }),
);
