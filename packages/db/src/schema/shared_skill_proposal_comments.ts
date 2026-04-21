import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { sharedSkillProposals } from "./shared_skill_proposals.js";
import { agents } from "./agents.js";
import { authUsers } from "./auth.js";

export const sharedSkillProposalComments = pgTable(
  "shared_skill_proposal_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    proposalId: uuid("proposal_id").notNull().references(() => sharedSkillProposals.id, { onDelete: "cascade" }),
    authorAgentId: uuid("author_agent_id").references(() => agents.id, { onDelete: "set null" }),
    authorUserId: text("author_user_id").references(() => authUsers.id, { onDelete: "set null" }),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    proposalIdx: index("shared_skill_proposal_comments_proposal_idx").on(table.proposalId),
    proposalCreatedIdx: index("shared_skill_proposal_comments_proposal_created_idx").on(
      table.proposalId,
      table.createdAt,
    ),
  }),
);
